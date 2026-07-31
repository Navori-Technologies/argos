import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type GraphifyBinaryName,
  type GraphifyCliResult,
  type GraphifyRunner,
  hasGraphifyProjectHook,
  installGraphifyProjectScope,
  installGraphifyUserScope,
  isGraphifySkillRegistered,
  manualGraphifyCommands,
} from "./graphify-plugin.js";

function ok(stdout = ""): GraphifyCliResult {
  return { status: 0, stdout, stderr: "" };
}

function failure(stderr: string, status = 1): GraphifyCliResult {
  return { status, stdout: "", stderr };
}

function enoent(): GraphifyCliResult {
  return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
}

function noBinaries(): (name: string) => boolean {
  return () => false;
}

describe("manualGraphifyCommands", () => {
  it("names the binary install commands and graphify install", () => {
    expect(manualGraphifyCommands()).toEqual(["uv tool install graphifyy", "pipx install graphifyy", "graphify install"]);
  });
});

describe("isGraphifySkillRegistered", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-graphify-skill-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is false when SKILL.md is absent", () => {
    expect(isGraphifySkillRegistered(dir)).toBe(false);
  });

  it("is true when skills/graphify/SKILL.md exists", () => {
    const skillDir = join(dir, "skills", "graphify");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# graphify", "utf-8");
    expect(isGraphifySkillRegistered(dir)).toBe(true);
  });
});

describe("hasGraphifyProjectHook", () => {
  let dir: string;
  let claudeDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-graphify-hook-"));
    claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is false when settings.json is missing", () => {
    expect(hasGraphifyProjectHook(dir)).toBe(false);
  });

  it("is false when settings.json is corrupt", () => {
    writeFileSync(join(claudeDir, "settings.json"), "{ not valid json", "utf-8");
    expect(hasGraphifyProjectHook(dir)).toBe(false);
  });

  it("is false when hooks.PreToolUse is absent or doesn't mention graphify", () => {
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({}), "utf-8");
    expect(hasGraphifyProjectHook(dir)).toBe(false);

    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "some-other-hook" }] }] } }),
      "utf-8",
    );
    expect(hasGraphifyProjectHook(dir)).toBe(false);
  });

  it("is true when hooks.PreToolUse mentions graphify", () => {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "graphify pretool-hook" }] }] } }),
      "utf-8",
    );
    expect(hasGraphifyProjectHook(dir)).toBe(true);
  });
});

describe("installGraphifyUserScope", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-graphify-user-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function markSkillRegistered(): void {
    const skillDir = join(dir, "skills", "graphify");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# graphify", "utf-8");
  }

  // Covers: R3
  it("skill already registered and graphify already in PATH → unchanged, no spawn", () => {
    markSkillRegistered();
    const runner: GraphifyRunner = () => {
      throw new Error("must not be called — already unchanged");
    };
    const hasBinary = (name: string) => name === "graphify";

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result).toEqual({ status: "unchanged" });
  });

  // Covers: R2
  it("binary present, skill absent → runs graphify install then --version smoke test → created", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      return ok();
    };
    const hasBinary = (name: string) => name === "graphify";

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result).toEqual({ status: "created" });
    expect(calls).toEqual([
      ["graphify", ["install"]],
      ["graphify", ["--version"]],
    ]);
  });

  // Covers: R1
  it("binary absent, uv present → runs uv tool install first, then graphify install + smoke → created", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    let graphifyResolvedAfterInstall = false;
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      if (binary === "uv") graphifyResolvedAfterInstall = true;
      return ok();
    };
    const hasBinary = (name: string) => {
      if (name === "graphify") return graphifyResolvedAfterInstall;
      return name === "uv";
    };

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result).toEqual({ status: "created" });
    expect(calls[0]).toEqual(["uv", ["tool", "install", "graphifyy"]]);
    expect(calls).toEqual([
      ["uv", ["tool", "install", "graphifyy"]],
      ["graphify", ["install"]],
      ["graphify", ["--version"]],
    ]);
  });

  // Covers: R1
  it("binary absent, only pipx present → runs pipx install", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    let graphifyResolvedAfterInstall = false;
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      if (binary === "pipx") graphifyResolvedAfterInstall = true;
      return ok();
    };
    const hasBinary = (name: string) => {
      if (name === "graphify") return graphifyResolvedAfterInstall;
      if (name === "uv") return false;
      return name === "pipx";
    };

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result).toEqual({ status: "created" });
    expect(calls[0]).toEqual(["pipx", ["install", "graphifyy"]]);
  });

  // Covers: R1b
  it("install command exits 0 but graphify still doesn't resolve in PATH → error, PATH detail, no retry, no graphify install", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      return ok();
    };
    const hasBinary = (name: string) => name === "uv"; // graphify never resolves, even after "install"

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("PATH");
    expect(result.detail).not.toContain("graphify install");
    expect(result.detail).not.toContain("uv tool install");
    expect(calls).toEqual([["uv", ["tool", "install", "graphifyy"]]]);
  });

  // Covers: R3 (post-R1 case)
  it("binary just installed by R1 and skill already registered → updated, no graphify install nor smoke", () => {
    markSkillRegistered();
    const calls: [GraphifyBinaryName, string[]][] = [];
    let graphifyResolvedAfterInstall = false;
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      if (binary === "uv") graphifyResolvedAfterInstall = true;
      return ok();
    };
    const hasBinary = (name: string) => {
      if (name === "graphify") return graphifyResolvedAfterInstall;
      return name === "uv";
    };

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result).toEqual({ status: "updated", detail: "binario instalado; skill ya registrado" });
    expect(calls).toEqual([["uv", ["tool", "install", "graphifyy"]]]);
  });

  // Covers: R4
  it("no graphify, uv, or pipx in PATH → error with manual commands", () => {
    const runner: GraphifyRunner = () => {
      throw new Error("must not be called — nothing to install with");
    };

    const result = installGraphifyUserScope(dir, { runner, hasBinary: noBinaries() });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("uv tool install graphifyy");
    expect(result.detail).toContain("pipx install graphifyy");
    expect(result.detail).toContain("graphify install");
  });

  // Covers: R5
  it("uv install fails (non-zero exit) → error, graphify install never attempted", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      return failure("network unreachable");
    };
    const hasBinary = (name: string) => name === "uv";

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("network unreachable");
    expect(calls).toHaveLength(1);
  });

  // Covers: R5
  it("graphify not in PATH but ENOENT-ish spawn error on binary install → error", () => {
    const runner: GraphifyRunner = () => enoent();
    const hasBinary = (name: string) => name === "uv";

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("PATH");
  });

  // Covers: R5
  it("graphify install fails → error, never created", () => {
    const runner: GraphifyRunner = (binary) => {
      if (binary === "graphify") return failure("permission denied");
      return ok();
    };
    const hasBinary = (name: string) => name === "graphify";

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("permission denied");
  });

  // Covers: R5
  it("graphify install succeeds but --version smoke test fails → error, never created", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      if (args[0] === "--version") return failure("segfault", 139);
      return ok();
    };
    const hasBinary = (name: string) => name === "graphify";

    const result = installGraphifyUserScope(dir, { runner, hasBinary });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("segfault");
    expect(calls).toEqual([
      ["graphify", ["install"]],
      ["graphify", ["--version"]],
    ]);
  });
});

describe("installGraphifyProjectScope", () => {
  let dir: string;
  let claudeDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-graphify-project-"));
    claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeHookSettings(): void {
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "graphify pretool-hook" }] }] } }),
      "utf-8",
    );
  }

  // Covers: R10
  it("hook already in settings.json → unchanged with 'ya instalado', no spawn", () => {
    writeHookSettings();
    const runner: GraphifyRunner = () => {
      throw new Error("must not be called — hook already installed");
    };

    const result = installGraphifyProjectScope(dir, { runner });

    expect(result).toEqual({ status: "unchanged", detail: "ya instalado" });
  });

  // Covers: R10
  it("corrupt settings.json is treated as absent → proceeds to install", () => {
    writeFileSync(join(claudeDir, "settings.json"), "{ not valid json", "utf-8");
    const calls: [GraphifyBinaryName, string[]][] = [];
    const runner: GraphifyRunner = (binary, args, _timeoutMs, cwd) => {
      calls.push([binary, args]);
      if (args.includes("--project")) {
        writeHookSettings();
      }
      expect(cwd).toBe(dir);
      return ok();
    };

    const result = installGraphifyProjectScope(dir, { runner });

    expect(result).toEqual({ status: "created" });
    expect(calls).toEqual([
      ["graphify", ["install", "--project"]],
      ["graphify", ["hook", "install"]],
    ]);
  });

  // Covers: R9
  it("happy path → runs install --project then hook install, in order, with re-peek positive → created", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    const runner: GraphifyRunner = (binary, args, _timeoutMs, cwd) => {
      calls.push([binary, args]);
      expect(cwd).toBe(dir);
      if (args.includes("--project")) {
        writeHookSettings();
      }
      return ok();
    };

    const result = installGraphifyProjectScope(dir, { runner });

    expect(result).toEqual({ status: "created" });
    expect(calls).toEqual([
      ["graphify", ["install", "--project"]],
      ["graphify", ["hook", "install"]],
    ]);
  });

  // Covers: R12
  it("both commands succeed but re-peek doesn't find the hook → error", () => {
    const runner: GraphifyRunner = () => ok(); // never writes settings.json

    const result = installGraphifyProjectScope(dir, { runner });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("graphify install --project");
    expect(result.detail).toContain("graphify hook install");
  });

  // Covers: R12
  it("graphify install --project fails → error, hook install never attempted, no partial-failure prefix", () => {
    const calls: [GraphifyBinaryName, string[]][] = [];
    const runner: GraphifyRunner = (binary, args) => {
      calls.push([binary, args]);
      return failure("no write permission");
    };

    const result = installGraphifyProjectScope(dir, { runner });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("no write permission");
    expect(result.detail).not.toContain("PreToolUse ya quedó escrito");
    expect(calls).toHaveLength(1);
  });

  // Covers: R12
  it("graphify hook install fails (spawn error) after a successful install --project → error, prefixed with 'hook PreToolUse ya quedó escrito'", () => {
    const runner: GraphifyRunner = (binary, args) => {
      if (args.includes("--project")) return ok();
      return enoent();
    };

    const result = installGraphifyProjectScope(dir, { runner });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("PATH");
    expect(result.detail).toContain("el hook PreToolUse ya quedó escrito en .claude/settings.json");
  });
});
