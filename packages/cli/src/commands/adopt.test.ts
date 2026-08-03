import { execFileSync, execSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig } from "../lib/config.js";
import type { GraphifyCliResult, GraphifyRunner } from "../lib/graphify-plugin.js";
import type { Prompter } from "../lib/prompter.js";
import { loadRegistry, saveRegistry, type WorkspaceRegistry } from "../lib/workspaces.js";
import { NO_GATE_PLACEHOLDER, runAdopt, runAdoptInteractive } from "./adopt.js";

function ok(stdout = ""): GraphifyCliResult {
  return { status: 0, stdout, stderr: "" };
}

function failure(stderr: string, status = 1): GraphifyCliResult {
  return { status, stdout: "", stderr };
}

/** Writes the graphify PreToolUse hook to `<dir>/.claude/settings.json`, as `graphify install --project` would. */
function writeGraphifyHookSettings(dir: string): void {
  const claudeDir = join(dir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "graphify pretool-hook" }] }] } }),
    "utf-8",
  );
}

/** A `GraphifyRunner` fake that simulates a successful `install --project` + `hook install` by writing the real hook file (mirrors `graphify-plugin.test.ts`'s own fakes, since `installGraphifyProjectScope`'s R9 re-peek reads the actual file). */
function makeHappyGraphifyRunner(dir: string): GraphifyRunner {
  return (_binary, args) => {
    if (args.includes("--project")) writeGraphifyHookSettings(dir);
    return ok();
  };
}

const CANCEL = Symbol("cancel");

/** Same trivial injectable fake as init.test.ts — see its doc comment. */
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

/**
 * A prompter that always echoes back whatever `initialValue`/`defaultValue`
 * it was shown (accepting every field's detected default, exactly as if a
 * human had pressed Enter through every prompt) and always confirms.
 * Driving the wizard through this proves `computeAdoptDefaults`'s preview
 * values are exactly what `runAdopt` itself would detect and write — a
 * parity check between the wizard's preview and the writing core, without
 * needing to export `computeAdoptDefaults` as a public seam.
 */
function makeAutoAcceptPrompter(): Prompter {
  return {
    select: async (opts) => (opts.initialValue ?? opts.options[0]?.value) as never,
    confirm: async () => true,
    text: async (opts) => opts.initialValue ?? opts.defaultValue ?? "",
    isCancel: (value: unknown): value is symbol => value === CANCEL,
    cancel: () => {},
    note: () => {},
    intro: () => {},
    outro: () => {},
  };
}

function initGitRepo(dir: string, remoteUrl?: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  if (remoteUrl) {
    execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  }
}

describe("runAdopt", () => {
  let repoDir: string;
  let argosHome: string;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "argos-adopt-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-adopt-home-"));
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  it("errors when cwd is not a git repository", () => {
    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });
    expect(report.exitCode).toBe(1);
    expect(report.error).toMatch(/git/i);
  });

  it("fresh run with detection produces a sane config with no navori.config.json", () => {
    initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "my-repo",
        scripts: { lint: "eslint .", test: "vitest run" },
        dependencies: { react: "^18.0.0", zod: "^3.0.0" },
      }),
      "utf-8",
    );
    writeFileSync(join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf-8");

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    const config = readConfig(repoDir);
    expect(config.name).toBe("my-repo");
    expect(config.stack?.packageManager).toBe("pnpm");
    expect(config.stack?.framework).toBe("react");
    expect(config.stack?.libs).toContain("zod");
    expect(config.qualityGate.fast).toBe("pnpm lint && pnpm test");
    expect(config.identity).toBe("github.com-bonum");
    // react + zod deps map to react-19 + zod-4, appended after the 4 core motor skills.
    expect(config.skills).toEqual([
      "verify-before-done",
      "review-diff",
      "pr-create",
      "loop-back-debug",
      "react-19",
      "zod-4",
    ]);
  });

  it("skills field: next+zod+tailwind repo maps to nextjs-15, react-19, zod-4, tailwind-4 plus the 4 core skills", () => {
    initGitRepo(repoDir);
    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({
        name: "my-repo",
        dependencies: { next: "^14.0.0", react: "^18.0.0", zod: "^3.0.0", tailwindcss: "^4.0.0" },
      }),
      "utf-8",
    );

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    const config = readConfig(repoDir);
    // Order follows DEP_SKILL_MAP declaration order (tailwindcss before zod), not the order deps appear in package.json.
    expect(config.skills).toEqual([
      "verify-before-done",
      "review-diff",
      "pr-create",
      "loop-back-debug",
      "nextjs-15",
      "react-19",
      "tailwind-4",
      "zod-4",
    ]);
    // react-19 appears once even though both the `next` and `react` DEP_SKILL_MAP entries could match.
    expect(config.skills.filter((s) => s === "react-19")).toHaveLength(1);
  });

  it("skills field: a repo with no mapped deps keeps exactly the 4 core motor skills", () => {
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "my-repo" }), "utf-8");

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    const config = readConfig(repoDir);
    expect(config.skills).toEqual(["verify-before-done", "review-diff", "pr-create", "loop-back-debug"]);
  });

  it("--refresh regenerates the skills field when deps change (e.g. a lib gets added)", () => {
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "repo-a", scripts: {} }), "utf-8");
    const first = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });
    expect(readConfig(repoDir).skills).toEqual([
      "verify-before-done",
      "review-diff",
      "pr-create",
      "loop-back-debug",
    ]);
    expect(first.exitCode).toBe(0);

    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "repo-a", scripts: {}, dependencies: { axios: "^1.0.0", stripe: "^14.0.0" } }),
      "utf-8",
    );
    const refreshed = runAdopt({ cwd: repoDir, refresh: true, graphifyHasBinary: () => false });

    expect(refreshed.exitCode).toBe(0);
    expect(readConfig(repoDir).skills).toEqual([
      "verify-before-done",
      "review-diff",
      "pr-create",
      "loop-back-debug",
      "axios",
      "stripe",
    ]);
  });

  it("imports base values from navori.config.json when present", () => {
    initGitRepo(repoDir);
    writeFileSync(
      join(repoDir, "navori.config.json"),
      JSON.stringify({
        name: "imported-repo",
        qualityGate: { fast: "npm run gate:fast" },
        project: { criticalAreas: ["src/auth"], legacyPaths: [] },
        workspace: "bonum",
      }),
      "utf-8",
    );

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    expect(report.rows.some((r) => r.source === "imported" && r.field === "import")).toBe(true);

    const config = readConfig(repoDir);
    expect(config.name).toBe("imported-repo");
    expect(config.qualityGate.fast).toBe("npm run gate:fast");
    expect(config.project.criticalAreas).toEqual(["src/auth"]);
    expect(config.workspace).toBe("bonum");
  });

  it("errors when argos.config.json already exists and --refresh was not passed", () => {
    initGitRepo(repoDir);
    runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    const second = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });
    expect(second.exitCode).toBe(1);
    expect(second.error).toMatch(/--refresh/);
  });

  it("--refresh regenerates the config picking up new stack facts, preserving name", () => {
    initGitRepo(repoDir);
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "repo-a", scripts: {} }), "utf-8");
    runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    writeFileSync(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "repo-a", scripts: {}, dependencies: { axios: "^1.0.0" } }),
      "utf-8",
    );
    const refreshed = runAdopt({ cwd: repoDir, refresh: true, graphifyHasBinary: () => false });

    expect(refreshed.exitCode).toBe(0);
    const config = readConfig(repoDir);
    expect(config.name).toBe("repo-a");
    expect(config.stack?.libs).toContain("axios");
  });

  it("appends the ficha to a pre-existing foreign CLAUDE.md without disturbing its content", () => {
    initGitRepo(repoDir);
    const foreignContent = "# Repo notes\n\nHand-written repo docs.\n";
    writeFileSync(join(repoDir, "CLAUDE.md"), foreignContent, "utf-8");

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    const claudeMd = readFileSync(join(repoDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.startsWith(foreignContent)).toBe(true);
    expect(claudeMd).toContain('id="ficha"');
  });

  it("replaces the ficha block on refresh instead of duplicating it", () => {
    initGitRepo(repoDir);
    runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });
    runAdopt({ cwd: repoDir, refresh: true, graphifyHasBinary: () => false });

    const claudeMd = readFileSync(join(repoDir, "CLAUDE.md"), "utf-8");
    // One open marker (`id="ficha" v="..."`) + one close marker (`end id="ficha"`) — never duplicated.
    const occurrences = claudeMd.split('id="ficha"').length - 1;
    expect(occurrences).toBe(2);
  });

  it("falls back to NO_GATE_PLACEHOLDER with a warning row when no gate scripts are detected", () => {
    initGitRepo(repoDir);
    // No package.json at all → nothing to detect a lint/typecheck/test script from.

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    const config = readConfig(repoDir);
    expect(config.qualityGate.fast).toBe(NO_GATE_PLACEHOLDER);
    expect(report.rows.some((r) => r.field === "qualityGate.fast" && r.source === "warning")).toBe(true);
  });

  it("NO_GATE_PLACEHOLDER is a harmless, valid shell command that exits 0 when actually run", () => {
    expect(() => execSync(NO_GATE_PLACEHOLDER, { stdio: "pipe" })).not.toThrow();
  });

  it("backs up the repo's existing CLAUDE.md before writing the ficha and reports the backup path", () => {
    initGitRepo(repoDir);
    const originalContent = "# Repo notes\n\nHand-written repo docs.\n";
    writeFileSync(join(repoDir, "CLAUDE.md"), originalContent, "utf-8");

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    expect(report.backupPath).toBeTruthy();
    const backedUpContent = readFileSync(join(report.backupPath as string, "CLAUDE.md"), "utf-8");
    expect(backedUpContent).toBe(originalContent);
    expect(readdirSync(join(argosHome, "backups")).length).toBeGreaterThan(0);
  });

  it("auto-links the repo when its remote matches a seeded workspace registry", () => {
    initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
    const registry: WorkspaceRegistry = {
      bonum: { match: { remotes: ["github.com-bonum"], paths: [] }, repos: [] },
    };
    saveRegistry(registry);

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    expect(report.rows.some((r) => r.field === "workspace.link" && r.source === "detected")).toBe(true);
    const config = readConfig(repoDir);
    const after = loadRegistry();
    expect(after.bonum?.repos.map((r) => r.name)).toContain(config.name);
  });

  it("reports an info row (never blocking) when the workspace can't be resolved", () => {
    initGitRepo(repoDir, "git@github.com:nowhere/my-repo.git");

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    const linkRow = report.rows.find((r) => r.field === "workspace.link");
    expect(linkRow?.source).toBe("info");
    expect(linkRow?.value).toMatch(/workspace link/);
  });

  it("degrades to a warning row (never aborting the rest of adopt) when workspaces.json is corrupt", () => {
    initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
    writeFileSync(join(argosHome, "workspaces.json"), "{ not valid json", "utf-8");

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    // The rest of adopt still ran to completion — config + ficha written.
    expect(report.exitCode).toBe(0);
    expect(readConfig(repoDir).name).toBeTruthy();
    expect(report.fichaStatus).toBe("created");

    const linkRow = report.rows.find((r) => r.field === "workspace.link");
    expect(linkRow?.source).toBe("warning");
    expect(linkRow?.value).toMatch(/corrupto/);
  });

  it("reports a warning row (never blocking) when the workspace match is ambiguous", () => {
    initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
    const registry: WorkspaceRegistry = {
      a: { match: { remotes: ["bonum"], paths: [] }, repos: [] },
      b: { match: { remotes: ["bonum"], paths: [] }, repos: [] },
    };
    saveRegistry(registry);

    const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(report.exitCode).toBe(0);
    const linkRow = report.rows.find((r) => r.field === "workspace.link");
    expect(linkRow?.source).toBe("warning");
    expect(linkRow?.value).toMatch(/ambiguo/);
  });

  it.skipIf(process.platform === "win32")(
    "survives a read-only repo dir, reporting partial success with an error row and no throw",
    () => {
      initGitRepo(repoDir);
      chmodSync(repoDir, 0o500);
      try {
        const report = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

        expect(report.exitCode).toBe(1);
        expect(report.rows.some((r) => r.source !== "error")).toBe(true);
        const errorRows = report.rows.filter((r) => r.source === "error");
        expect(errorRows.length).toBeGreaterThan(0);
        expect(errorRows.every((r) => r.value.length > 0)).toBe(true);
        expect(() => runAdopt({ cwd: repoDir, graphifyHasBinary: () => false })).not.toThrow();
      } finally {
        chmodSync(repoDir, 0o700);
      }
    },
  );
});

describe("runAdopt — graphify project-scope hook (spec 0006 T4)", () => {
  let repoDir: string;
  let argosHome: string;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "argos-adopt-graphify-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-adopt-graphify-home-"));
    process.env.ARGOS_HOME = argosHome;
    initGitRepo(repoDir);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  // Covers: R9
  it("happy path: binary present, hook absent → installs and reports a 'detected' row", () => {
    const report = runAdopt({
      cwd: repoDir,
      graphifyHasBinary: () => true,
      graphifyRunner: makeHappyGraphifyRunner(repoDir),
    });

    expect(report.exitCode).toBe(0);
    const row = report.rows.find((r) => r.field === "graphify");
    expect(row?.source).toBe("detected");
  });

  // Covers: R10, R11
  it("hook already present → 'detected' with 'ya instalado', no spawn, with precedence over binary absent", () => {
    writeGraphifyHookSettings(repoDir);
    const runner: GraphifyRunner = () => {
      throw new Error("must not be called — hook already installed");
    };

    const report = runAdopt({
      cwd: repoDir,
      graphifyHasBinary: () => false, // binary absent too — R10 must still win over R11
      graphifyRunner: runner,
    });

    expect(report.exitCode).toBe(0);
    const row = report.rows.find((r) => r.field === "graphify");
    expect(row).toEqual({ field: "graphify", value: "ya instalado", source: "detected" });
  });

  // Covers: R11
  it("binary absent, hook absent → 'warning' row with manual commands, no exit 1, no spawn", () => {
    const runner: GraphifyRunner = () => {
      throw new Error("must not be called — binary absent, adopt must not spawn");
    };

    const report = runAdopt({
      cwd: repoDir,
      graphifyHasBinary: () => false,
      graphifyRunner: runner,
    });

    expect(report.exitCode).toBe(0);
    const row = report.rows.find((r) => r.field === "graphify");
    expect(row?.source).toBe("warning");
    expect(row?.value).toContain("graphify install");
  });

  // Covers: R12
  it("graphify install --project fails → 'error' row and exit code 1", () => {
    const runner: GraphifyRunner = () => failure("no write permission");

    const report = runAdopt({
      cwd: repoDir,
      graphifyHasBinary: () => true,
      graphifyRunner: runner,
    });

    expect(report.exitCode).toBe(1);
    const row = report.rows.find((r) => r.field === "graphify");
    expect(row?.source).toBe("error");
    expect(row?.value).toContain("no write permission");
  });

  it("installGraphify: false skips the whole step — no row, no spawn", () => {
    const runner: GraphifyRunner = () => {
      throw new Error("must not be called — installGraphify is false");
    };

    const report = runAdopt({
      cwd: repoDir,
      installGraphify: false,
      graphifyHasBinary: () => true,
      graphifyRunner: runner,
    });

    expect(report.exitCode).toBe(0);
    expect(report.rows.some((r) => r.field === "graphify")).toBe(false);
  });
});

describe("runAdoptInteractive", () => {
  let repoDir: string;
  let argosHome: string;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "argos-adopt-interactive-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-adopt-interactive-home-"));
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  it("--yes / no-TTY is byte-identical to calling runAdopt directly, even with a prompter injected", async () => {
    initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
    const prompter = makeFakePrompter([]); // never consulted

    const viaInteractive = await runAdoptInteractive({
      cwd: repoDir,
      yes: true,
      prompter,
      graphifyHasBinary: () => false,
    });
    const configAfterInteractive = readConfig(repoDir);

    rmSync(join(repoDir, "argos.config.json"), { force: true });
    rmSync(join(repoDir, "CLAUDE.md"), { force: true });
    const viaDirect = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

    expect(viaInteractive.exitCode).toBe(viaDirect.exitCode);
    expect(viaInteractive.rows).toEqual(viaDirect.rows);
    expect(configAfterInteractive.name).toBe(readConfig(repoDir).name);
    // Covers: R13 — no TTY/`--yes`, no graphify prompt was ever consulted (the fake prompter has zero
    // answers queued), yet `installGraphify` still defaulted to `true` and produced its row.
    expect(viaInteractive.rows.some((r) => r.field === "graphify")).toBe(true);
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

    it("editing the detected name away from its default is reflected in the written config, with row source 'edited'", async () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      const prompter = makeFakePrompter([
        "my-edited-name", // name (edited away from the detected default)
        "main", // branchBase (accepted)
        NO_GATE_PLACEHOLDER, // qualityGate.fast (accepted — no scripts detected)
        "", // workspace (accepted — none resolved)
        "", // identity (accepted — none detected without a package.json)
        false, // installGraphify (declined — unrelated to this test, keep it deterministic)
        true, // final confirm
      ]);

      const report = await runAdoptInteractive({ cwd: repoDir, prompter });

      expect(report.exitCode).toBe(0);
      expect(readConfig(repoDir).name).toBe("my-edited-name");
      const nameRow = report.rows.find((r) => r.field === "name");
      expect(nameRow?.source).toBe("edited");
      expect(nameRow?.value).toBe("my-edited-name");
    });

    it("parity: accepting every wizard default (Enter-through) writes exactly what a plain runAdopt call would", async () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      writeFileSync(
        join(repoDir, "package.json"),
        JSON.stringify({
          name: "pkg-name",
          scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest run" },
        }),
        "utf-8",
      );

      // `graphifyHasBinary` pinned to false (never invoked as `false ??
      // true`-style defaults would) so neither call ever risks spawning a
      // real `graphify`/`uv`/`pipx` process on the machine running the test.
      const viaInteractive = await runAdoptInteractive({
        cwd: repoDir,
        prompter: makeAutoAcceptPrompter(),
        graphifyHasBinary: () => false,
      });

      rmSync(join(repoDir, "argos.config.json"), { force: true });
      rmSync(join(repoDir, "CLAUDE.md"), { force: true });
      const viaDirect = runAdopt({ cwd: repoDir, graphifyHasBinary: () => false });

      expect(viaInteractive.exitCode).toBe(viaDirect.exitCode);
      expect(viaInteractive.rows).toEqual(viaDirect.rows);
    });

    it("resolves an ambiguous workspace match via select instead of erroring", async () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      const registry: WorkspaceRegistry = {
        a: { match: { remotes: ["bonum"], paths: [] }, repos: [] },
        b: { match: { remotes: ["bonum"], paths: [] }, repos: [] },
      };
      saveRegistry(registry);

      const prompter = makeFakePrompter([
        "repo-name", // name
        "main", // branchBase
        NO_GATE_PLACEHOLDER, // qualityGate.fast
        "a", // workspace select (chosen candidate)
        "", // identity
        false, // installGraphify (declined — unrelated to this test, keep it deterministic)
        true, // final confirm
      ]);

      const report = await runAdoptInteractive({ cwd: repoDir, prompter });

      expect(report.exitCode).toBe(0);
      expect(readConfig(repoDir).workspace).toBe("a");
      const linkRow = report.rows.find((r) => r.field === "workspace.link");
      expect(linkRow?.value).toContain("workspace 'a'");
    });

    it("cancelling at any step touches nothing on disk", async () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      const prompter = makeFakePrompter([CANCEL]); // cancel right at the name prompt

      const report = await runAdoptInteractive({ cwd: repoDir, prompter });

      expect(report.exitCode).toBe(1);
      expect(report.rows).toEqual([]);
      expect(readdirSync(repoDir).includes("argos.config.json")).toBe(false);
    });

    // Covers: R13
    it("declining the graphify confirm skips the whole step — no row, no spawn", async () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      const runner: GraphifyRunner = () => {
        throw new Error("must not be called — installGraphify was declined");
      };
      const prompter = makeFakePrompter([
        "repo-name", // name
        "main", // branchBase
        NO_GATE_PLACEHOLDER, // qualityGate.fast
        "", // workspace
        "", // identity
        false, // installGraphify (declined)
        true, // final confirm
      ]);

      const report = await runAdoptInteractive({
        cwd: repoDir,
        prompter,
        graphifyHasBinary: () => true,
        graphifyRunner: runner,
      });

      expect(report.exitCode).toBe(0);
      expect(report.rows.some((r) => r.field === "graphify")).toBe(false);
    });
  });
});
