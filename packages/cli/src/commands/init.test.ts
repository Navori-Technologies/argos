import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCliRunner } from "../lib/engram-plugin.js";
import type { GraphifyRunner } from "../lib/graphify-plugin.js";
import type { Prompter } from "../lib/prompter.js";
import { runInit, runInitInteractive } from "./init.js";

const CANCEL = Symbol("cancel");

/**
 * Trivial injectable fake for `Prompter` — every surface's interactive test
 * builds one of these instead of touching `@clack/prompts` internals (spec
 * 0004's "el prompter es inyectable" acceptance criterion). `answers` is
 * consumed in call order across `select`/`confirm`/`text`; a `CANCEL`
 * sentinel anywhere in the queue makes that call (and only that call)
 * behave like a real cancelled clack prompt.
 */
function makeFakePrompter(answers: unknown[]): Prompter {
  let i = 0;
  const next = () => answers[i++];
  return {
    select: async () => next() as never,
    confirm: async () => next() as never,
    text: async () => next() as never,
    isCancel: (value: unknown): value is symbol => value === CANCEL,
    cancel: () => {},
    note: () => {},
    intro: () => {},
    outro: () => {},
  };
}

/** Recursively snapshot every file under `dir` as a relative-path -> content map, for "touched nothing" assertions. */
function snapshotDir(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else out[rel] = readFileSync(full, "utf-8");
    }
  };
  walk(dir, "");
  return out;
}

describe("runInit", () => {
  let claudeDir: string;
  let argosHome: string;
  const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "argos-init-claude-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-init-home-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  it("fresh run creates every managed block and every full-file asset", () => {
    const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

    expect(report.exitCode).toBe(0);
    expect(report.rows.every((r) => r.status === "created")).toBe(true);

    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "output-styles", "argos.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "agents", "explorer.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "skills", "verify-before-done", "SKILL.md"))).toBe(true);
    expect(existsSync(join(argosHome, "global.json"))).toBe(true);

    const claudeMd = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    for (const id of [
      "identidad",
      "formato-respuesta",
      "disciplina-skills",
      "aterrizaje",
      "orquestacion",
      "operaciones-seguras",
    ]) {
      expect(claudeMd).toContain(`id="${id}"`);
    }

    const globalJson = JSON.parse(readFileSync(join(argosHome, "global.json"), "utf-8")) as {
      version: string;
      language: string;
    };
    expect(globalJson.language).toBe("es");
    expect(typeof globalJson.version).toBe("string");
  });

  it("installs the disciplina-skills block ordered after formato-respuesta and before aterrizaje", () => {
    runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

    const claudeMd = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain('id="disciplina-skills"');
    expect(claudeMd).toContain("Disparo de skills (disciplina obligatoria)");

    const formatoIdx = claudeMd.indexOf('id="formato-respuesta"');
    const disciplinaIdx = claudeMd.indexOf('id="disciplina-skills"');
    const aterrizajeIdx = claudeMd.indexOf('id="aterrizaje"');

    expect(formatoIdx).toBeGreaterThan(-1);
    expect(disciplinaIdx).toBeGreaterThan(-1);
    expect(aterrizajeIdx).toBeGreaterThan(-1);
    expect(disciplinaIdx).toBeGreaterThan(formatoIdx);
    expect(aterrizajeIdx).toBeGreaterThan(disciplinaIdx);
  });

  it("respects the --language flag in global.json", () => {
    runInit({ language: "en", installEngram: false, setAutoMode: false, installGraphify: false });
    const globalJson = JSON.parse(readFileSync(join(argosHome, "global.json"), "utf-8")) as { language: string };
    expect(globalJson.language).toBe("en");
  });

  it("is idempotent — a second run with no changes reports everything unchanged", () => {
    runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
    const second = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

    expect(second.exitCode).toBe(0);
    expect(second.rows.every((r) => r.status === "unchanged")).toBe(true);
  });

  it("skips a foreign skill file (no argos:file marker) and leaves it byte-identical", () => {
    const foreignPath = join(claudeDir, "skills", "verify-before-done", "SKILL.md");
    mkdirSync(join(claudeDir, "skills", "verify-before-done"), { recursive: true });
    const foreignContent = "---\nname: verify-before-done\n---\n\nMy own hand-written skill.\n";
    writeFileSync(foreignPath, foreignContent, "utf-8");

    const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

    const row = report.rows.find((r) => r.path === join("skills", "verify-before-done", "SKILL.md"));
    expect(row?.status).toBe("skipped-foreign");
    expect(readFileSync(foreignPath, "utf-8")).toBe(foreignContent);
  });

  it("preserves foreign CLAUDE.md content byte-exact outside the managed blocks", () => {
    mkdirSync(claudeDir, { recursive: true });
    const foreignContent = "# My global notes\n\nHand-written, do not touch.\n";
    writeFileSync(join(claudeDir, "CLAUDE.md"), foreignContent, "utf-8");

    runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

    const claudeMd = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.startsWith(foreignContent)).toBe(true);
    expect(claudeMd).toContain('id="identidad"');
  });

  it.skipIf(process.platform === "win32")(
    "survives a read-only claudeDir with partial success and surfaces the backup path",
    () => {
      chmodSync(claudeDir, 0o500);
      try {
        const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

        expect(report.exitCode).toBe(1);
        const errorRows = report.rows.filter((r) => r.status === "error");
        expect(errorRows.length).toBeGreaterThan(0);
        expect(errorRows.every((r) => typeof r.detail === "string" && r.detail.length > 0)).toBe(true);
        // global.json lives under ARGOS_HOME, unaffected by the read-only claudeDir.
        expect(report.rows.some((r) => r.path === "global.json" && r.status === "created")).toBe(true);
        // The backup itself only reads from claudeDir and writes elsewhere, so it still succeeds.
        expect(report.backupPath).toBeTruthy();
        expect(() => runInit({ installEngram: false, setAutoMode: false, installGraphify: false })).not.toThrow();
      } finally {
        chmodSync(claudeDir, 0o700);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "aborts the entire run and touches nothing under claudeDir when the backup itself fails",
    () => {
      // Seed a pre-existing CLAUDE.md so we can prove it's untouched afterwards.
      mkdirSync(claudeDir, { recursive: true });
      const originalClaudeMd = "# pre-existing content\n";
      writeFileSync(join(claudeDir, "CLAUDE.md"), originalClaudeMd, "utf-8");

      // createBackup writes into <ARGOS_HOME>/backups/... — make ARGOS_HOME
      // read-only so `mkdirSync` for the backup dir throws.
      chmodSync(argosHome, 0o500);
      try {
        const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

        expect(report.exitCode).toBe(1);
        expect(report.summary).toMatch(/backup falló/);
        expect(report.rows).toEqual([{ path: "backup", status: "error", detail: expect.any(String) }]);
        expect(report.backupPath).toBeUndefined();

        // Nothing in claudeDir was touched: no hooks, no settings.json, and
        // the pre-existing CLAUDE.md is byte-identical.
        expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8")).toBe(originalClaudeMd);
        expect(existsSync(join(claudeDir, "hooks"))).toBe(false);
        expect(existsSync(join(claudeDir, "settings.json"))).toBe(false);
        expect(existsSync(join(claudeDir, "agents"))).toBe(false);
      } finally {
        chmodSync(argosHome, 0o700);
      }
    },
  );

  describe("hooks + settings.json (spec 0003)", () => {
    it("installs both hook scripts, executable, with the real version stamped", () => {
      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      expect(report.exitCode).toBe(0);

      const guardPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
      const gatePath = join(claudeDir, "hooks", "argos-quality-gate.sh");
      expect(existsSync(guardPath)).toBe(true);
      expect(existsSync(gatePath)).toBe(true);

      expect(statSync(guardPath).mode & 0o111).toBeGreaterThan(0); // executable bit set
      expect(statSync(gatePath).mode & 0o111).toBeGreaterThan(0);

      const guardContent = readFileSync(guardPath, "utf-8");
      expect(guardContent).not.toContain("__ARGOS_VERSION__");
      expect(guardContent).toMatch(/^#!\/usr\/bin\/env bash\n# argos:file v="[^"]+"\n/);

      expect(report.rows.some((r) => r.path === join("hooks", "argos-guard-destructive.sh") && r.status === "created")).toBe(
        true,
      );
      expect(report.rows.some((r) => r.path === join("hooks", "argos-quality-gate.sh") && r.status === "created")).toBe(
        true,
      );
    });

    it("adds both PreToolUse hook entries to a fresh settings.json", () => {
      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      const settingsPath = join(claudeDir, "settings.json");
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      };
      const commands = settings.hooks.PreToolUse.flatMap((b) => b.hooks.map((h) => h.command));
      expect(commands.some((c) => c.includes("argos-guard-destructive.sh"))).toBe(true);
      expect(commands.some((c) => c.includes("argos-quality-gate.sh"))).toBe(true);

      expect(report.rows.some((r) => r.path === "settings.json" && r.status === "created")).toBe(true);
    });

    it("preserves a user's existing settings.json foreign hooks and keys, adding argos's own", () => {
      mkdirSync(claudeDir, { recursive: true });
      const foreign = {
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }] },
        permissions: { allow: ["Read(**)"] },
      };
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(foreign, null, 2), "utf-8");

      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      expect(report.exitCode).toBe(0);

      const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
        permissions: { allow: string[] };
      };
      expect(settings.permissions).toEqual({ allow: ["Read(**)"] });
      const bashBucket = settings.hooks.PreToolUse.find((b) => b.matcher === "Bash")!;
      const commands = bashBucket.hooks.map((h) => h.command);
      expect(commands[0]).toBe("echo user-hook");
      expect(commands.some((c) => c.includes("argos-guard-destructive.sh"))).toBe(true);
      expect(commands.some((c) => c.includes("argos-quality-gate.sh"))).toBe(true);
    });

    it("is idempotent — a second run reports both hooks and settings.json unchanged", () => {
      runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      const second = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      const hookRows = second.rows.filter((r) => r.path.startsWith(join("hooks", "")));
      expect(hookRows.every((r) => r.status === "unchanged")).toBe(true);
      expect(second.rows.some((r) => r.path === "settings.json" && r.status === "unchanged")).toBe(true);
    });

    it("skips a foreign hook script (no argos:file marker) and leaves it byte-identical", () => {
      const guardPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
      mkdirSync(join(claudeDir, "hooks"), { recursive: true });
      const foreignContent = "#!/usr/bin/env bash\necho hand-written hook\n";
      writeFileSync(guardPath, foreignContent, "utf-8");

      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      const row = report.rows.find((r) => r.path === join("hooks", "argos-guard-destructive.sh"));
      expect(row?.status).toBe("skipped-foreign");
      expect(readFileSync(guardPath, "utf-8")).toBe(foreignContent);
    });

    it("strips a hook's PREVIOUSLY-successful settings.json entry when its write breaks on a later run", () => {
      // Run 1: fresh install, both hooks succeed and get real entries.
      const first = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      expect(first.exitCode).toBe(0);

      // Now the gate script breaks (e.g. something replaced it with a dir).
      const gatePath = join(claudeDir, "hooks", "argos-quality-gate.sh");
      rmSync(gatePath, { recursive: true, force: true });
      mkdirSync(gatePath, { recursive: true });

      const second = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      expect(second.exitCode).toBe(1);
      const gateRow = second.rows.find((r) => r.path === join("hooks", "argos-quality-gate.sh"));
      expect(gateRow?.status).toBe("error");

      const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      const commands = settings.hooks.PreToolUse.flatMap((b) => b.hooks.map((h) => h.command));
      // The stale entry from run 1 must be gone, not left dangling.
      expect(commands.some((c) => c.includes("argos-quality-gate.sh"))).toBe(false);
      expect(commands.some((c) => c.includes("argos-guard-destructive.sh"))).toBe(true);
    });

    it("never adds a settings.json entry for a hook whose script write failed", () => {
      // Pre-create a DIRECTORY at the hook's destination path so
      // writeManagedShellFile's readFileSync(destPath) throws (EISDIR)
      // instead of writing the script.
      const gatePath = join(claudeDir, "hooks", "argos-quality-gate.sh");
      mkdirSync(gatePath, { recursive: true });

      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      const gateRow = report.rows.find((r) => r.path === join("hooks", "argos-quality-gate.sh"));
      expect(gateRow?.status).toBe("error");

      const settingsPath = join(claudeDir, "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
      };
      const commands = settings.hooks.PreToolUse.flatMap((b) => b.hooks.map((h) => h.command));
      // The failed hook must NOT appear — a dangling entry pointing at a
      // script that was never written would hard-block every Bash call.
      expect(commands.some((c) => c.includes("argos-quality-gate.sh"))).toBe(false);
      // The other hook, which wrote fine, still gets its entry.
      expect(commands.some((c) => c.includes("argos-guard-destructive.sh"))).toBe(true);
    });

    it("reports a settings.json error row and leaves the file untouched when its JSON is corrupt", () => {
      mkdirSync(claudeDir, { recursive: true });
      const corrupt = "{ not valid json";
      writeFileSync(join(claudeDir, "settings.json"), corrupt, "utf-8");

      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      expect(report.exitCode).toBe(1);
      const row = report.rows.find((r) => r.path === "settings.json");
      expect(row?.status).toBe("error");
      expect(row?.detail).toBeTruthy();
      expect(readFileSync(join(claudeDir, "settings.json"), "utf-8")).toBe(corrupt);
    });

    it("installHooks: false on a SECOND run does not retroactively strip hooks a prior run already installed", () => {
      runInit({ installEngram: false, setAutoMode: false, installGraphify: false }); // default run installs both hooks + their settings.json entries
      const guardScriptPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
      const gateScriptPath = join(claudeDir, "hooks", "argos-quality-gate.sh");
      expect(existsSync(guardScriptPath)).toBe(true);
      expect(existsSync(gateScriptPath)).toBe(true);
      const settingsBefore = readFileSync(join(claudeDir, "settings.json"), "utf-8");

      const report = runInit({ installHooks: false, installEngram: false, setAutoMode: false, installGraphify: false });

      // Untouched — a later run toggling hooks off is not a retroactive
      // uninstall; that's `argos remove`'s job (see commands/init.ts's
      // hooks-gating comment).
      expect(existsSync(guardScriptPath)).toBe(true);
      expect(existsSync(gateScriptPath)).toBe(true);
      expect(readFileSync(join(claudeDir, "settings.json"), "utf-8")).toBe(settingsBefore);
      expect(report.rows.some((r) => r.path.startsWith("hooks/"))).toBe(false);
      expect(report.rows.some((r) => r.path === "settings.json")).toBe(false);
    });
  });

  describe("skill directories (not just SKILL.md)", () => {
    it("installs supporting files under a skill's references/ and phases/ subdirectories, not just SKILL.md", () => {
      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      expect(report.exitCode).toBe(0);

      const angularCorePath = join(claudeDir, "skills", "angular", "references", "core.md");
      const appBuilderPhasePath = join(claudeDir, "skills", "app-builder", "phases", "0-product.md");
      expect(existsSync(angularCorePath)).toBe(true);
      expect(existsSync(appBuilderPhasePath)).toBe(true);

      expect(
        report.rows.some((r) => r.path === join("skills", "angular", "references", "core.md") && r.status === "created"),
      ).toBe(true);
      expect(
        report.rows.some(
          (r) => r.path === join("skills", "app-builder", "phases", "0-product.md") && r.status === "created",
        ),
      ).toBe(true);
    });

    it("is idempotent for skill supporting files — a second run reports them unchanged, no duplication", () => {
      runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      const second = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      expect(second.exitCode).toBe(0);
      const angularCoreRow = second.rows.find((r) => r.path === join("skills", "angular", "references", "core.md"));
      expect(angularCoreRow?.status).toBe("unchanged");

      // No duplicate rows for the same file.
      const matching = second.rows.filter((r) => r.path === join("skills", "angular", "references", "core.md"));
      expect(matching).toHaveLength(1);
    });

    it("skips the WHOLE skill directory (SKILL.md + supporting files) when SKILL.md is foreign", () => {
      const skillDir = join(claudeDir, "skills", "angular");
      mkdirSync(skillDir, { recursive: true });
      const foreignSkillMd = "---\nname: angular\n---\n\nMy own hand-written skill.\n";
      writeFileSync(join(skillDir, "SKILL.md"), foreignSkillMd, "utf-8");

      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      const skillMdRow = report.rows.find((r) => r.path === join("skills", "angular", "SKILL.md"));
      expect(skillMdRow?.status).toBe("skipped-foreign");
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(foreignSkillMd);

      const coreRow = report.rows.find((r) => r.path === join("skills", "angular", "references", "core.md"));
      expect(coreRow?.status).toBe("skipped-foreign");
      expect(existsSync(join(skillDir, "references", "core.md"))).toBe(false);
    });
  });

  describe("engram + auto mode (spec 0005)", () => {
    function fakeSuccessRunner(calls: string[][] = []): ClaudeCliRunner {
      return (args) => {
        calls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      };
    }

    // Covers: R1
    it("installEngram default true: not yet enabled → installs via the injected runner, in order, and reports created", () => {
      const calls: string[][] = [];
      const report = runInit({ setAutoMode: false, installGraphify: false, engramRunner: fakeSuccessRunner(calls) });

      const row = report.rows.find((r) => r.path === "plugins#engram");
      expect(row?.status).toBe("created");
      expect(calls).toEqual([
        ["plugin", "marketplace", "add", "Gentleman-Programming/engram"],
        ["plugin", "install", "engram@engram"],
      ]);
    });

    // Covers: R2
    it("installEngram: already enabled in settings.json → unchanged, runner never called", () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "engram@engram": true } }, null, 2),
        "utf-8",
      );
      const runner: ClaudeCliRunner = () => {
        throw new Error("must not be called — engram is already enabled");
      };

      const report = runInit({ setAutoMode: false, installGraphify: false, engramRunner: runner });

      const row = report.rows.find((r) => r.path === "plugins#engram");
      expect(row?.status).toBe("unchanged");
    });

    // Covers: R3
    it("installEngram: claude absent from PATH → error row with the manual commands, rest of init still proceeds", () => {
      const runner: ClaudeCliRunner = () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException,
      });

      const report = runInit({ setAutoMode: false, installGraphify: false, engramRunner: runner });

      const row = report.rows.find((r) => r.path === "plugins#engram");
      expect(row?.status).toBe("error");
      expect(row?.detail).toContain("claude plugin marketplace add");
      expect(row?.detail).toContain("claude plugin install");
      // A failed engram install must not abort the rest of init.
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
      expect(report.exitCode).toBe(1); // engram's own row is an error, but init otherwise completed
    });

    // Covers: R9
    it("installEngram: disabled by option → step skipped entirely, no row at all", () => {
      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      expect(report.rows.some((r) => r.path === "plugins#engram")).toBe(false);
    });

    // Covers: R5
    it("setAutoMode default true: absent → sets permissions.defaultMode = auto and reports created", () => {
      const report = runInit({ installEngram: false, installGraphify: false });

      const row = report.rows.find((r) => r.path === "settings.json#defaultMode");
      expect(row?.status).toBe("created");
      const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
        permissions: { defaultMode: string };
      };
      expect(settings.permissions.defaultMode).toBe("auto");
    });

    // Covers: R6
    it("setAutoMode: a foreign defaultMode value is reported skipped-foreign and never touched", () => {
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(
        join(claudeDir, "settings.json"),
        JSON.stringify({ permissions: { defaultMode: "plan" } }, null, 2),
        "utf-8",
      );

      const report = runInit({ installEngram: false, installGraphify: false });

      const row = report.rows.find((r) => r.path === "settings.json#defaultMode");
      expect(row?.status).toBe("skipped-foreign");
      const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
        permissions: { defaultMode: string };
      };
      expect(settings.permissions.defaultMode).toBe("plan");
    });

    // Covers: R9
    it("setAutoMode: disabled by option → step skipped entirely, no row at all", () => {
      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      expect(report.rows.some((r) => r.path === "settings.json#defaultMode")).toBe(false);
    });
  });

  describe("graphify (spec 0006)", () => {
    function fakeGraphifyRunner(calls: string[][] = []): GraphifyRunner {
      return (binary, args) => {
        calls.push([binary, ...args]);
        return { status: 0, stdout: "", stderr: "" };
      };
    }

    // Covers: R1
    it("installGraphify default true: binary in PATH, skill not registered → installs + smokes, reports the tooling#graphify row created", () => {
      const calls: string[][] = [];
      const report = runInit({
        installEngram: false,
        setAutoMode: false,
        graphifyRunner: fakeGraphifyRunner(calls),
        graphifyHasBinary: (name) => name === "graphify",
      });

      const row = report.rows.find((r) => r.path === "tooling#graphify");
      expect(row?.status).toBe("created");
      expect(calls).toEqual([
        ["graphify", "install"],
        ["graphify", "--version"],
      ]);
      // The rest of init still ran normally alongside it.
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
    });

    // Covers: R5
    it("installGraphify: a failing command is reported as an error row without aborting the rest of init", () => {
      const runner: GraphifyRunner = () => ({ status: 1, stdout: "", stderr: "graphify install boom" });
      const report = runInit({
        installEngram: false,
        setAutoMode: false,
        graphifyRunner: runner,
        graphifyHasBinary: (name) => name === "graphify",
      });

      const row = report.rows.find((r) => r.path === "tooling#graphify");
      expect(row?.status).toBe("error");
      expect(row?.detail).toContain("graphify install boom");
      // A failed graphify install must not abort the rest of init.
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
      expect(existsSync(join(argosHome, "global.json"))).toBe(true);
    });

    // Covers: R6
    it("installGraphify: disabled by option → step skipped entirely, no row at all", () => {
      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      expect(report.rows.some((r) => r.path === "tooling#graphify")).toBe(false);
    });
  });

  describe("--force", () => {
    function seedForeignAngularSkill(): { skillDir: string; foreignSkillMd: string; foreignSubfile: string } {
      const skillDir = join(claudeDir, "skills", "angular");
      mkdirSync(join(skillDir, "references"), { recursive: true });
      const foreignSkillMd = "---\nname: angular\n---\n\nMy own hand-written skill.\n";
      const foreignSubfile = "My own hand-written reference notes.\n";
      writeFileSync(join(skillDir, "SKILL.md"), foreignSkillMd, "utf-8");
      writeFileSync(join(skillDir, "references", "core.md"), foreignSubfile, "utf-8");
      return { skillDir, foreignSkillMd, foreignSubfile };
    }

    it("overwrites a seeded foreign skill (SKILL.md + subfile) and stamps argos:file markers on both", () => {
      const { skillDir, foreignSkillMd, foreignSubfile } = seedForeignAngularSkill();

      const report = runInit({ force: true, installEngram: false, setAutoMode: false, installGraphify: false });

      expect(report.exitCode).toBe(0);
      const skillMdRow = report.rows.find((r) => r.path === join("skills", "angular", "SKILL.md"));
      const coreRow = report.rows.find((r) => r.path === join("skills", "angular", "references", "core.md"));
      expect(skillMdRow?.status).toBe("overwritten-foreign");
      expect(coreRow?.status).toBe("overwritten-foreign");

      const skillMdContent = readFileSync(join(skillDir, "SKILL.md"), "utf-8");
      expect(skillMdContent).not.toBe(foreignSkillMd);
      expect(skillMdContent).toContain('<!-- argos:file v="');
      expect(readFileSync(join(skillDir, "references", "core.md"), "utf-8")).not.toBe(foreignSubfile);

      // The marker lands with the write — a later NON-forced run must treat
      // it as owned from now on, never skipped-foreign again.
      const second = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });
      const secondRow = second.rows.find((r) => r.path === join("skills", "angular", "SKILL.md"));
      expect(secondRow?.status).toBe("unchanged");
    });

    it("without --force, the same seeded foreign skill is left skipped-foreign, byte-identical (unchanged default behavior)", () => {
      const { skillDir, foreignSkillMd, foreignSubfile } = seedForeignAngularSkill();

      const report = runInit({ installEngram: false, setAutoMode: false, installGraphify: false });

      const skillMdRow = report.rows.find((r) => r.path === join("skills", "angular", "SKILL.md"));
      expect(skillMdRow?.status).toBe("skipped-foreign");
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(foreignSkillMd);
      expect(readFileSync(join(skillDir, "references", "core.md"), "utf-8")).toBe(foreignSubfile);
    });

    it("overwrites a foreign hook script and stamps its shell marker", () => {
      const guardPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
      mkdirSync(join(claudeDir, "hooks"), { recursive: true });
      const foreignContent = "#!/usr/bin/env bash\necho hand-written hook\n";
      writeFileSync(guardPath, foreignContent, "utf-8");

      const report = runInit({ force: true, installEngram: false, setAutoMode: false, installGraphify: false });

      const row = report.rows.find((r) => r.path === join("hooks", "argos-guard-destructive.sh"));
      expect(row?.status).toBe("overwritten-foreign");
      const written = readFileSync(guardPath, "utf-8");
      expect(written).not.toBe(foreignContent);
      expect(written).toContain('# argos:file v="');
    });

    it("HARD BOUNDARY: foreign CLAUDE.md prose survives --force byte-exact (managed-block injection stays own-blocks-only)", () => {
      mkdirSync(claudeDir, { recursive: true });
      const foreignContent = "# My global notes\n\nHand-written, do not touch.\n";
      writeFileSync(join(claudeDir, "CLAUDE.md"), foreignContent, "utf-8");

      runInit({ force: true, installEngram: false, setAutoMode: false, installGraphify: false });

      const claudeMd = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd.startsWith(foreignContent)).toBe(true);
      expect(claudeMd).toContain('id="identidad"');
    });

    it("HARD BOUNDARY: a foreign settings.json entry survives --force byte-exact (surgical merge unchanged)", () => {
      mkdirSync(claudeDir, { recursive: true });
      const foreign = {
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }] },
        permissions: { allow: ["Read(**)"] },
      };
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(foreign, null, 2), "utf-8");

      const report = runInit({ force: true, installEngram: false, setAutoMode: false, installGraphify: false });
      expect(report.exitCode).toBe(0);

      const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
        permissions: { allow: string[] };
      };
      expect(settings.permissions).toEqual({ allow: ["Read(**)"] });
      const bashBucket = settings.hooks.PreToolUse.find((b) => b.matcher === "Bash")!;
      expect(bashBucket.hooks.map((h) => h.command)[0]).toBe("echo user-hook");
      // argos's own hooks still land alongside it — surgical merge is unchanged by --force.
      const commands = bashBucket.hooks.map((h) => h.command);
      expect(commands.some((c) => c.includes("argos-guard-destructive.sh"))).toBe(true);
    });

    it("backup taken before the overwrite contains the foreign file's ORIGINAL content", () => {
      const { foreignSkillMd } = seedForeignAngularSkill();

      const report = runInit({ force: true, installEngram: false, setAutoMode: false, installGraphify: false });

      expect(report.backupPath).toBeTruthy();
      const backedUp = readFileSync(join(report.backupPath as string, "skills", "angular", "SKILL.md"), "utf-8");
      expect(backedUp).toBe(foreignSkillMd);
    });
  });
});

describe("runInitInteractive", () => {
  let claudeDir: string;
  let argosHome: string;
  const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "argos-init-interactive-claude-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-init-interactive-home-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  it("--yes / no-TTY is byte-identical to calling runInit directly, even with a prompter injected", async () => {
    const prompter = makeFakePrompter([]); // never consulted — --yes short-circuits before any prompt call
    const viaInteractive = await runInitInteractive({
      language: "en",
      installEngram: false,
      setAutoMode: false,
      installGraphify: false,
      yes: true,
      prompter,
    });

    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(argosHome, { recursive: true });
    const viaDirect = runInit({ language: "en", installEngram: false, setAutoMode: false, installGraphify: false });

    expect(viaInteractive.exitCode).toBe(viaDirect.exitCode);
    expect(viaInteractive.rows).toEqual(viaDirect.rows);
  });

  it("no real TTY (yes unset, this test runner has none attached) never calls the injected prompter", async () => {
    let calls = 0;
    const prompter: Prompter = {
      ...makeFakePrompter([]),
      select: async () => {
        calls++;
        return CANCEL as never;
      },
    };
    const report = await runInitInteractive({ installEngram: false, setAutoMode: false, installGraphify: false, prompter });

    expect(calls).toBe(0);
    expect(report.exitCode).toBe(0);
    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
  });

  describe("forced-interactive (stubbed TTY)", () => {
    let originalStdoutIsTTY: PropertyDescriptor | undefined;
    let originalStdinIsTTY: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    });

    afterEach(() => {
      if (originalStdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
      if (originalStdinIsTTY) Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    });

    it("happy path: language, agents, hooks, final confirm — writes exactly what was chosen", async () => {
      const prompter = makeFakePrompter([
        "en", // language
        true, // installAgents
        false, // installHooks
        false, // installEngram
        false, // setAutoMode
        false, // decline installGraphify
        true, // final confirm
      ]);

      const report = await runInitInteractive({ prompter });

      expect(report.exitCode).toBe(0);
      expect(existsSync(join(claudeDir, "agents", "explorer.md"))).toBe(true);
      expect(existsSync(join(claudeDir, "hooks", "argos-guard-destructive.sh"))).toBe(false);
      const globalJson = JSON.parse(readFileSync(join(argosHome, "global.json"), "utf-8")) as { language: string };
      expect(globalJson.language).toBe("en");
    });

    it("cancelling at any step touches nothing on disk", async () => {
      const prompter = makeFakePrompter([CANCEL]); // cancel right at the language select
      const before = existsSync(claudeDir) ? readdirSync(claudeDir) : [];

      const report = await runInitInteractive({ prompter });

      expect(report.exitCode).toBe(1);
      expect(report.rows).toEqual([]);
      const after = existsSync(claudeDir) ? readdirSync(claudeDir) : [];
      expect(after).toEqual(before);
    });

    it("cancelling at the final confirm step also touches nothing on disk", async () => {
      const prompter = makeFakePrompter(["es", true, true, false, false, false, false]); // decline installGraphify, then final confirm = false
      const before = existsSync(claudeDir) ? readdirSync(claudeDir) : [];

      const report = await runInitInteractive({ prompter });

      expect(report.exitCode).toBe(1);
      expect(report.rows).toEqual([]);
      const after = existsSync(claudeDir) ? readdirSync(claudeDir) : [];
      expect(after).toEqual(before);
    });

    describe("--force confirm prompt", () => {
      function seedForeignAngularSkill(): string {
        const skillDir = join(claudeDir, "skills", "angular");
        mkdirSync(skillDir, { recursive: true });
        const foreignSkillMd = "---\nname: angular\n---\n\nMy own hand-written skill.\n";
        writeFileSync(join(skillDir, "SKILL.md"), foreignSkillMd, "utf-8");
        return foreignSkillMd;
      }

      it("accepting the force confirm proceeds and overwrites the foreign file", async () => {
        seedForeignAngularSkill();
        const prompter = makeFakePrompter([
          "es", // language
          true, // installAgents
          true, // installHooks
          false, // installEngram
          false, // setAutoMode
          false, // decline installGraphify
          true, // accept the force-overwrite confirm
          true, // final confirm
        ]);

        const report = await runInitInteractive({ force: true, prompter });

        expect(report.exitCode).toBe(0);
        const row = report.rows.find((r) => r.path === join("skills", "angular", "SKILL.md"));
        expect(row?.status).toBe("overwritten-foreign");
      });

      it("cancelling at the force confirm touches nothing on disk", async () => {
        const foreignSkillMd = seedForeignAngularSkill();
        const before = snapshotDir(claudeDir);
        const prompter = makeFakePrompter([
          "es",
          true,
          true,
          false, // installEngram
          false, // setAutoMode
          false, // decline installGraphify
          CANCEL, // cancel right at the force-overwrite confirm
        ]);

        const report = await runInitInteractive({ force: true, prompter });

        expect(report.exitCode).toBe(1);
        expect(report.rows).toEqual([]);
        expect(snapshotDir(claudeDir)).toEqual(before);
        expect(readFileSync(join(claudeDir, "skills", "angular", "SKILL.md"), "utf-8")).toBe(foreignSkillMd);
      });

      it("declining (not just cancelling) the force confirm also touches nothing on disk", async () => {
        const foreignSkillMd = seedForeignAngularSkill();
        const before = snapshotDir(claudeDir);
        const prompter = makeFakePrompter(["es", true, true, false, false, false, false]); // decline installGraphify, then decline the force confirm

        const report = await runInitInteractive({ force: true, prompter });

        expect(report.exitCode).toBe(1);
        expect(report.rows).toEqual([]);
        expect(snapshotDir(claudeDir)).toEqual(before);
        expect(readFileSync(join(claudeDir, "skills", "angular", "SKILL.md"), "utf-8")).toBe(foreignSkillMd);
      });

      it("no foreign files to overwrite → force never prompts, even with --force set", async () => {
        // Nothing seeded: a fresh claudeDir has zero foreign motor paths.
        let calls = 0;
        const prompter = makeFakePrompter(["es", true, true, false, false, false, true]); // language, agents, hooks, engram, auto mode, graphify, final confirm — no force-confirm slot consumed
        const wrapped: Prompter = {
          ...prompter,
          confirm: async (opts) => {
            calls++;
            return prompter.confirm(opts);
          },
        };

        const report = await runInitInteractive({ force: true, prompter: wrapped });

        expect(report.exitCode).toBe(0);
        // installAgents + installHooks + installEngram + setAutoMode +
        // installGraphify + final confirm = 6 confirm calls; no extra
        // force-confirm call was made since there was nothing foreign.
        expect(calls).toBe(6);
      });
    });

    describe("navori voice takeover prompt", () => {
      function seedNavoriOutputStyle(): string {
        mkdirSync(claudeDir, { recursive: true });
        const settingsPath = join(claudeDir, "settings.json");
        writeFileSync(settingsPath, JSON.stringify({ outputStyle: "navori" }, null, 2), "utf-8");
        return settingsPath;
      }

      it("accepting the takeover prompt replaces navori with Argos and reports it", async () => {
        const settingsPath = seedNavoriOutputStyle();
        const prompter = makeFakePrompter([
          "es", // language
          true, // installAgents
          true, // installHooks
          false, // installEngram
          false, // setAutoMode
          false, // decline installGraphify
          true, // accept the navori takeover prompt
          true, // final confirm
        ]);

        const report = await runInitInteractive({ prompter });

        expect(report.exitCode).toBe(0);
        const row = report.rows.find((r) => r.path === "settings.json#outputStyle");
        expect(row?.status).toBe("updated");
        expect(row?.detail).toMatch(/navori.*Argos/);
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
        expect(settings.outputStyle).toBe("Argos");
      });

      it("declining the takeover prompt leaves outputStyle at navori, untouched", async () => {
        const settingsPath = seedNavoriOutputStyle();
        const prompter = makeFakePrompter([
          "es",
          true,
          true,
          false, // installEngram
          false, // setAutoMode
          false, // decline installGraphify
          false, // decline the navori takeover prompt
          true, // final confirm — the rest of init still proceeds
        ]);

        const report = await runInitInteractive({ prompter });

        expect(report.exitCode).toBe(0);
        const row = report.rows.find((r) => r.path === "settings.json#outputStyle");
        expect(row?.status).toBe("skipped-foreign");
        const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
        expect(settings.outputStyle).toBe("navori");
      });

      it("cancelling exactly at the takeover prompt touches nothing on disk", async () => {
        seedNavoriOutputStyle();
        const before = snapshotDir(claudeDir);
        const prompter = makeFakePrompter([
          "es",
          true,
          true,
          false, // installEngram
          false, // setAutoMode
          false, // decline installGraphify
          CANCEL, // cancel right at the navori takeover prompt
        ]);

        const report = await runInitInteractive({ prompter });

        expect(report.exitCode).toBe(1);
        expect(report.rows).toEqual([]);
        expect(snapshotDir(claudeDir)).toEqual(before);
      });
    });

    describe("engram + auto mode wizard prompts (spec 0005)", () => {
      // Covers: R4
      it("declining the Engram prompt omits the whole step: no row, no process spawned", async () => {
        const prompter = makeFakePrompter([
          "es", // language
          true, // installAgents
          true, // installHooks
          false, // decline installEngram
          false, // setAutoMode
          false, // decline installGraphify
          true, // final confirm
        ]);

        const report = await runInitInteractive({ prompter });

        expect(report.exitCode).toBe(0);
        expect(report.rows.some((r) => r.path === "plugins#engram")).toBe(false);
      });

      // Covers: R7
      it("declining the auto mode prompt omits the whole step: key never touched, no row", async () => {
        const prompter = makeFakePrompter([
          "es",
          true,
          true,
          false, // installEngram
          false, // decline setAutoMode
          false, // decline installGraphify
          true, // final confirm
        ]);

        const report = await runInitInteractive({ prompter });

        expect(report.exitCode).toBe(0);
        expect(report.rows.some((r) => r.path === "settings.json#defaultMode")).toBe(false);
      });

      // Covers: R4, R7
      it("accepting both prompts (with an injected engramRunner) writes both rows", async () => {
        const prompter = makeFakePrompter([
          "es",
          true,
          true,
          true, // accept installEngram
          true, // accept setAutoMode
          false, // decline installGraphify
          true, // final confirm
        ]);
        const engramRunner: ClaudeCliRunner = () => ({ status: 0, stdout: "", stderr: "" });

        const report = await runInitInteractive({ prompter, engramRunner });

        expect(report.exitCode).toBe(0);
        expect(report.rows.find((r) => r.path === "plugins#engram")?.status).toBe("created");
        expect(report.rows.find((r) => r.path === "settings.json#defaultMode")?.status).toBe("created");
      });
    });

    describe("graphify wizard prompt (spec 0006)", () => {
      // Covers: R6
      it("declining the Graphify prompt omits the whole step: no row, no process spawned", async () => {
        const runner: GraphifyRunner = () => {
          throw new Error("must not be called — the operator declined installGraphify");
        };
        const prompter = makeFakePrompter([
          "es", // language
          true, // installAgents
          true, // installHooks
          false, // installEngram
          false, // setAutoMode
          false, // decline installGraphify
          true, // final confirm
        ]);

        const report = await runInitInteractive({ prompter, graphifyRunner: runner });

        expect(report.exitCode).toBe(0);
        expect(report.rows.some((r) => r.path === "tooling#graphify")).toBe(false);
      });

      // Covers: R6
      it("accepting the Graphify prompt (with injected runner/hasBinary) writes the tooling#graphify row", async () => {
        const prompter = makeFakePrompter([
          "es",
          true,
          true,
          false, // installEngram
          false, // setAutoMode
          true, // accept installGraphify
          true, // final confirm
        ]);
        const graphifyRunner: GraphifyRunner = () => ({ status: 0, stdout: "", stderr: "" });

        const report = await runInitInteractive({
          prompter,
          graphifyRunner,
          graphifyHasBinary: (name) => name === "graphify",
        });

        expect(report.exitCode).toBe(0);
        expect(report.rows.find((r) => r.path === "tooling#graphify")?.status).toBe("created");
      });
    });
  });
});

describe("runInitInteractive — non-interactive defaults (spec 0005 R9)", () => {
  let claudeDir: string;
  let argosHome: string;
  const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "argos-init-r9-claude-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-init-r9-home-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  // Covers: R9
  it("--yes: installEngram/setAutoMode both default true, with zero prompts", async () => {
    const prompter = makeFakePrompter([]); // never consulted — --yes short-circuits before any prompt call
    const engramRunner: ClaudeCliRunner = () => ({ status: 0, stdout: "", stderr: "" });

    const report = await runInitInteractive({ yes: true, installGraphify: false, prompter, engramRunner });

    expect(report.rows.find((r) => r.path === "plugins#engram")?.status).toBe("created");
    expect(report.rows.find((r) => r.path === "settings.json#defaultMode")?.status).toBe("created");
  });

  // Covers: R9
  it("no real TTY (this test runner has none attached): installEngram/setAutoMode both default true, with zero prompts", async () => {
    const engramRunner: ClaudeCliRunner = () => ({ status: 0, stdout: "", stderr: "" });

    const report = await runInitInteractive({ installGraphify: false, engramRunner });

    expect(report.rows.find((r) => r.path === "plugins#engram")?.status).toBe("created");
    expect(report.rows.find((r) => r.path === "settings.json#defaultMode")?.status).toBe("created");
  });

  // Covers: R7
  it("--yes: installGraphify defaults true, with zero prompts, and reports the tooling#graphify row", async () => {
    const prompter = makeFakePrompter([]); // never consulted — --yes short-circuits before any prompt call
    const graphifyRunner: GraphifyRunner = () => ({ status: 0, stdout: "", stderr: "" });

    const report = await runInitInteractive({
      yes: true,
      installEngram: false,
      setAutoMode: false,
      prompter,
      graphifyRunner,
      graphifyHasBinary: (name) => name === "graphify",
    });

    expect(report.rows.find((r) => r.path === "tooling#graphify")?.status).toBe("created");
  });

  // Covers: R7
  it("no real TTY (this test runner has none attached): installGraphify defaults true, with zero prompts, and reports the tooling#graphify row", async () => {
    const graphifyRunner: GraphifyRunner = () => ({ status: 0, stdout: "", stderr: "" });

    const report = await runInitInteractive({
      installEngram: false,
      setAutoMode: false,
      graphifyRunner,
      graphifyHasBinary: (name) => name === "graphify",
    });

    expect(report.rows.find((r) => r.path === "tooling#graphify")?.status).toBe("created");
  });
});
