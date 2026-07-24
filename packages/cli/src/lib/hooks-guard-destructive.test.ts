import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAssetsDir } from "./assets.js";

/**
 * Hermetic behavioral tests for the installed argos-guard-destructive.sh
 * asset: run the ACTUAL script (not a reimplementation) with a piped
 * PreToolUse-shaped stdin JSON payload, same as Claude Code invokes it. This
 * is the only way to catch a regex/quoting bug the shell interpreter itself
 * would hit, that a pure-TS unit test could never see.
 */

const HOOK_PATH = join(resolveAssetsDir(), "hooks", "argos-guard-destructive.sh");

interface HookRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runGuard(command: string, env: Record<string, string> = {}): HookRun {
  const result = spawnSync("bash", [HOOK_PATH], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Every test in this suite spawns `bash` directly (it's testing the actual
// shell asset) — there's no bash on a stock Windows runner, so the whole
// suite is skipped there, same as adopt.test.ts's own it.skipIf(win32) guard
// on its chmod-dependent test.
describe.skipIf(process.platform === "win32")("argos-guard-destructive.sh", () => {
  it("allows an ordinary safe command", () => {
    const run = runGuard("ls -la");
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
  });

  it("allows an empty/missing tool_input.command (fails open, nothing to inspect)", () => {
    const result = spawnSync("bash", [HOOK_PATH], { input: "{}", encoding: "utf-8" });
    expect(result.status).toBe(0);
  });

  describe("rule: --no-verify", () => {
    it("blocks git commit --no-verify", () => {
      const run = runGuard("git commit -m x --no-verify");
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("--no-verify");
    });

    it("blocks git push --no-verify", () => {
      const run = runGuard("git push --no-verify origin main");
      expect(run.status).toBe(2);
    });

    it("allows a commit message that merely contains the word verify", () => {
      const run = runGuard('git commit -m "add -notify option"');
      expect(run.status).toBe(0);
    });
  });

  describe("rule: force-push to the base branch", () => {
    it("blocks git push --force to main (default branchBase, no config)", () => {
      const run = runGuard("git push --force origin main");
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("force-push");
    });

    it("blocks the short -f flag to main", () => {
      const run = runGuard("git push -f origin main");
      expect(run.status).toBe(2);
    });

    it("allows --force-with-lease to main", () => {
      const run = runGuard("git push --force-with-lease origin main");
      expect(run.status).toBe(0);
    });

    it("allows a force-push to a feature branch", () => {
      const run = runGuard("git push --force origin my-feature-branch");
      expect(run.status).toBe(0);
    });
  });

  describe("rule: rm -rf", () => {
    it("allows rm -rf on a relative path (e.g. node_modules)", () => {
      const run = runGuard("rm -rf node_modules");
      expect(run.status).toBe(0);
    });

    it("blocks rm -rf on a bare home path (~)", () => {
      const run = runGuard("rm -rf ~");
      expect(run.status).toBe(2);
    });

    it("blocks rm -rf on a variable-indirected path ($HOME)", () => {
      const run = runGuard("rm -rf $HOME");
      expect(run.status).toBe(2);
    });

    it("allows rm -rf on an ordinary absolute path under tmp/scratch", () => {
      const run = runGuard("rm -rf /tmp/scratch/some-dir");
      expect(run.status).toBe(0);
    });
  });

  describe("branchBase parametrization from argos.config.json", () => {
    let repoDir: string;
    const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;

    beforeEach(() => {
      repoDir = mkdtempSync(join(tmpdir(), "argos-guard-repo-"));
    });

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
      if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
    });

    it("reads branchBase from argos.config.json instead of defaulting to main", () => {
      writeFileSync(join(repoDir, "argos.config.json"), JSON.stringify({ branchBase: "develop" }), "utf-8");

      const blocked = runGuard("git push --force origin develop", { CLAUDE_PROJECT_DIR: repoDir });
      expect(blocked.status).toBe(2);

      const allowed = runGuard("git push --force origin main", { CLAUDE_PROJECT_DIR: repoDir });
      expect(allowed.status).toBe(0);
    });

    it("finds argos.config.json in a parent directory (walks up from cwd)", () => {
      const nested = join(repoDir, "packages", "app");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(repoDir, "argos.config.json"), JSON.stringify({ branchBase: "release" }), "utf-8");

      const blocked = runGuard("git push --force origin release", { CLAUDE_PROJECT_DIR: nested });
      expect(blocked.status).toBe(2);
    });
  });
});
