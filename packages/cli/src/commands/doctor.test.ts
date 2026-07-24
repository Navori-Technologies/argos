import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../lib/config.js";
import { injectBlock } from "../lib/markers.js";
import { linkRepo, saveRegistry, type WorkspaceRegistry } from "../lib/workspaces.js";
import { runAdopt } from "./adopt.js";
import { runDoctor } from "./doctor.js";
import { runInit } from "./init.js";

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

describe("runDoctor", () => {
  let claudeDir: string;
  let argosHome: string;
  let nonRepoDir: string;
  const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "argos-doctor-claude-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-doctor-home-"));
    nonRepoDir = mkdtempSync(join(tmpdir(), "argos-doctor-cwd-"));
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    rmSync(nonRepoDir, { recursive: true, force: true });
    if (originalClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeDir;
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  it("reports a clean state with exit 0 when the motor is fresh and cwd is not a repo", () => {
    runInit();
    const report = runDoctor({ cwd: nonRepoDir });
    expect(report.exitCode).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it("reports an outdated motor block", () => {
    runInit();
    const claudeMdPath = join(claudeDir, "CLAUDE.md");
    let claudeMd = readFileSync(claudeMdPath, "utf-8");
    claudeMd = injectBlock(claudeMd, "identidad", "-1", "stale content");
    writeFileSync(claudeMdPath, claudeMd, "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(report.findings.some((f) => f.level === "warning" && /identidad/.test(f.message))).toBe(true);
  });

  it("reports ficha drift when argos.config.json changes without --refresh", () => {
    initGitRepo(nonRepoDir);
    runInit();
    runAdopt({ cwd: nonRepoDir });

    const config = readConfig(nonRepoDir);
    writeConfig(nonRepoDir, { ...config, workspace: "changed-workspace" });

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(report.findings.some((f) => f.level === "warning" && /ficha/i.test(f.message))).toBe(true);
  });

  it("reports an outdated motor block as a warning suggesting argos init (older-than-binary)", () => {
    runInit();
    const claudeMdPath = join(claudeDir, "CLAUDE.md");
    let claudeMd = readFileSync(claudeMdPath, "utf-8");
    claudeMd = injectBlock(claudeMd, "identidad", "-1", "stale content");
    writeFileSync(claudeMdPath, claudeMd, "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some((f) => f.level === "warning" && /identidad/.test(f.message) && /argos init/.test(f.message)),
    ).toBe(true);
  });

  it("reports a block newer than the binary as a warning suggesting a package upgrade", () => {
    runInit();
    const claudeMdPath = join(claudeDir, "CLAUDE.md");
    let claudeMd = readFileSync(claudeMdPath, "utf-8");
    claudeMd = injectBlock(claudeMd, "identidad", "999.0.0", "content from the future");
    writeFileSync(claudeMdPath, claudeMd, "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some(
        (f) => f.level === "warning" && /identidad/.test(f.message) && /npm i -g/.test(f.message),
      ),
    ).toBe(true);
  });

  it("reports a clean state (no version findings) when the block version matches the binary exactly", () => {
    const report = runInit();
    const doctorReport = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(0);
    expect(doctorReport.exitCode).toBe(0);
    expect(doctorReport.findings.some((f) => /identidad/.test(f.message))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "reports an error finding instead of throwing when the global CLAUDE.md is unreadable",
    () => {
      runInit();
      const claudeMdPath = join(claudeDir, "CLAUDE.md");
      chmodSync(claudeMdPath, 0o000);
      try {
        const report = runDoctor({ cwd: nonRepoDir });

        expect(report.exitCode).toBe(1);
        expect(
          report.findings.some((f) => f.level === "error" && /CLAUDE\.md/.test(f.message)),
        ).toBe(true);
      } finally {
        chmodSync(claudeMdPath, 0o644);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports an error finding instead of throwing when the repo's ./CLAUDE.md is unreadable",
    () => {
      initGitRepo(nonRepoDir);
      runInit();
      runAdopt({ cwd: nonRepoDir });
      const repoClaudeMdPath = join(nonRepoDir, "CLAUDE.md");
      chmodSync(repoClaudeMdPath, 0o000);
      try {
        const report = runDoctor({ cwd: nonRepoDir });

        expect(report.exitCode).toBe(1);
        expect(
          report.findings.some((f) => f.level === "error" && /CLAUDE\.md/.test(f.message)),
        ).toBe(true);
      } finally {
        chmodSync(repoClaudeMdPath, 0o644);
      }
    },
  );

  it("flags a duplicated managed block in CLAUDE.md as a warning", () => {
    runInit();
    const claudeMdPath = join(claudeDir, "CLAUDE.md");
    const claudeMd = readFileSync(claudeMdPath, "utf-8");
    // Simulate crash residue: append a second raw copy of the "identidad" block by id.
    const openMarker = '<!-- argos:managed id="identidad"';
    const openIdx = claudeMd.indexOf(openMarker);
    const endMarker = '<!-- argos:managed end id="identidad" -->';
    const endIdx = claudeMd.indexOf(endMarker) + endMarker.length;
    const duplicatedBlock = claudeMd.slice(openIdx, endIdx);
    writeFileSync(claudeMdPath, `${claudeMd}\n${duplicatedBlock}\n`, "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some((f) => f.level === "warning" && /identidad/.test(f.message) && /duplicad/.test(f.message)),
    ).toBe(true);
  });

  it("warns when qualityGate.fast is still the NO_GATE_PLACEHOLDER left by adopt", () => {
    initGitRepo(nonRepoDir);
    runInit();
    // No package.json at all → buildQualityGateFast has nothing to detect from → placeholder.
    runAdopt({ cwd: nonRepoDir });

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some((f) => f.level === "warning" && /placeholder/i.test(f.message) && /adopt --refresh/.test(f.message)),
    ).toBe(true);
  });

  it("reports a readable error finding for an invalid argos.config.json", () => {
    initGitRepo(nonRepoDir);
    runInit();
    runAdopt({ cwd: nonRepoDir });

    writeFileSync(join(nonRepoDir, "argos.config.json"), JSON.stringify({ qualityGate: {} }), "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    const errorFindings = report.findings.filter((f) => f.level === "error");
    expect(errorFindings.length).toBeGreaterThan(0);
    expect(errorFindings.every((f) => !/ZodError|issues:/.test(f.message))).toBe(true);
  });

  // --- F2: hooks ---------------------------------------------------------

  it("stays silent about hooks when the motor is freshly installed", () => {
    runInit();
    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(0);
    expect(report.findings.some((f) => /hook/i.test(f.message))).toBe(false);
  });

  it("warns when a global hook script is missing", () => {
    runInit();
    const hookPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
    rmSync(hookPath);

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some(
        (f) => f.level === "warning" && /argos-guard-destructive\.sh/.test(f.message) && /argos init/.test(f.message),
      ),
    ).toBe(true);
  });

  it("warns when a hook script's marker version is older than the binary", () => {
    runInit();
    const hookPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
    const hookContent = readFileSync(hookPath, "utf-8").replace(/# argos:file v="[^"]*"/, '# argos:file v="-1"');
    writeFileSync(hookPath, hookContent, "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some(
        (f) =>
          f.level === "warning" && /argos-guard-destructive\.sh/.test(f.message) && /desactualizado/.test(f.message),
      ),
    ).toBe(true);
  });

  it("warns when settings.json references an orphaned hook (script file gone)", () => {
    runInit();
    const hookPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
    rmSync(hookPath);

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some(
        (f) => f.level === "warning" && /huérfano/.test(f.message) && /argos-guard-destructive\.sh/.test(f.message),
      ),
    ).toBe(true);
  });

  it("flags a settings.json hook entry as orphaned when its script path is a directory, not a file", () => {
    runInit();
    const hookPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
    // `existsSync` alone is true for directories too — replacing the script
    // with a directory of the same name must still be flagged as orphaned.
    rmSync(hookPath, { recursive: true, force: true });
    mkdirSync(hookPath, { recursive: true });

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some(
        (f) => f.level === "warning" && /huérfano/.test(f.message) && /argos-guard-destructive\.sh/.test(f.message),
      ),
    ).toBe(true);
  });

  it("reports an error finding instead of throwing when settings.json has invalid JSON", () => {
    runInit();
    const settingsPath = join(claudeDir, "settings.json");
    writeFileSync(settingsPath, "{ not valid json", "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some((f) => f.level === "error" && /settings\.json/.test(f.message) && /JSON/.test(f.message)),
    ).toBe(true);
  });

  // --- F2: workspaces ------------------------------------------------------

  it("suggests `argos workspace link` when the repo isn't registered in any workspace", () => {
    initGitRepo(nonRepoDir);
    runInit();
    runAdopt({ cwd: nonRepoDir });

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some((f) => f.level === "info" && /workspace link/.test(f.message)),
    ).toBe(true);
  });

  it("warns about workspace registry entries whose repo path no longer exists on disk", () => {
    runInit();
    const registry: WorkspaceRegistry = {
      bonum: {
        match: { remotes: [], paths: [] },
        repos: [{ name: "ghost-repo", path: join(tmpdir(), "argos-doctor-ghost-repo-does-not-exist") }],
      },
    };
    saveRegistry(registry);

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some(
        (f) => f.level === "warning" && /ghost-repo/.test(f.message) && /paths inexistentes/i.test(f.message),
      ),
    ).toBe(true);
  });

  it("reports a structured error finding instead of crashing when workspaces.json is corrupt", () => {
    initGitRepo(nonRepoDir);
    runInit();
    runAdopt({ cwd: nonRepoDir });
    writeFileSync(join(argosHome, "workspaces.json"), "{ not valid json", "utf-8");

    const report = runDoctor({ cwd: nonRepoDir });

    expect(report.exitCode).toBe(1);
    expect(
      report.findings.some((f) => f.level === "error" && /workspaces\.json/.test(f.message) && /corrupto/.test(f.message)),
    ).toBe(true);
  });

  it("warns about a stale registered path when a linked repo relocates", () => {
    initGitRepo(nonRepoDir);
    runInit();
    runAdopt({ cwd: nonRepoDir });

    const config = readConfig(nonRepoDir);
    linkRepo("bonum", { name: config.name, path: nonRepoDir });
    writeConfig(nonRepoDir, { ...config, workspace: "bonum" });

    const relocatedDir = `${nonRepoDir}-relocated`;
    renameSync(nonRepoDir, relocatedDir);
    try {
      const report = runDoctor({ cwd: relocatedDir });

      expect(report.exitCode).toBe(1);
      expect(
        report.findings.some((f) => f.level === "warning" && /path distinto/i.test(f.message)),
      ).toBe(true);
    } finally {
      // Restore the original path so afterEach's rmSync(nonRepoDir) still works.
      renameSync(relocatedDir, nonRepoDir);
    }
  });
});
