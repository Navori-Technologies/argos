import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../lib/config.js";
import { injectBlock } from "../lib/markers.js";
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
});
