import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAssetsDir } from "./assets.js";
import { NO_GATE_PLACEHOLDER } from "../commands/adopt.js";

/**
 * Hermetic behavioral tests for the installed argos-quality-gate.sh asset:
 * run the ACTUAL script against a temp "repo" directory with a real
 * argos.config.json, same shape Claude Code feeds it (PreToolUse stdin JSON
 * + $CLAUDE_PROJECT_DIR).
 */

const HOOK_PATH = join(resolveAssetsDir(), "hooks", "argos-quality-gate.sh");

interface HookRun {
  status: number;
  stdout: string;
  stderr: string;
}

function runGate(command: string, projectDir: string, extraEnv: Record<string, string> = {}): HookRun {
  const result = spawnSync("bash", [HOOK_PATH], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...extraEnv },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function writeConfig(repoDir: string, fast: string): void {
  writeFileSync(join(repoDir, "argos.config.json"), JSON.stringify({ qualityGate: { fast } }), "utf-8");
}

// Every test in this suite spawns `bash` directly (it's testing the actual
// shell asset) — there's no bash on a stock Windows runner, so the whole
// suite is skipped there, same as adopt.test.ts's own it.skipIf(win32) guard
// on its chmod-dependent test.
describe.skipIf(process.platform === "win32")("argos-quality-gate.sh", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "argos-gate-repo-"));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("is a silent no-op when no argos.config.json exists", () => {
    const run = runGate("git commit -m x", repoDir);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
  });

  it("is a silent no-op for a non-commit command, even with config present", () => {
    writeConfig(repoDir, "exit 1"); // would fail if it ran
    const run = runGate("ls -la", repoDir);
    expect(run.status).toBe(0);
  });

  it("is a no-op when qualityGate.fast is the NO_GATE_PLACEHOLDER", () => {
    writeConfig(repoDir, NO_GATE_PLACEHOLDER);
    const run = runGate("git commit -m x", repoDir);
    expect(run.status).toBe(0);
  });

  it("runs the gate and allows the commit when it passes", () => {
    const sentinel = join(repoDir, "sentinel.txt");
    writeConfig(repoDir, "echo gate-ran > sentinel.txt");
    const run = runGate("git commit -m x", repoDir);
    expect(run.status).toBe(0);
    expect(readFileSync(sentinel, "utf-8")).toContain("gate-ran");
  });

  it("blocks the commit and reports the tail of output when the gate fails", () => {
    writeConfig(repoDir, "echo boom-output && exit 1");
    const run = runGate("git commit -m x", repoDir);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("quality gate del repo falló");
    expect(run.stderr).toContain("boom-output");
  });

  it("blocks the commit on timeout", () => {
    writeConfig(repoDir, "sleep 5");
    const run = runGate("git commit -m x", repoDir, { ARGOS_GATE_TIMEOUT_MS: "300" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("quality gate del repo falló");
  });

  it("finds argos.config.json in a parent directory (walks up from cwd)", () => {
    writeConfig(repoDir, "exit 1");
    const nested = join(repoDir, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const run = runGate("git commit -m x", nested);
    expect(run.status).toBe(2);
  });

  it("acts on git commit even inside a compound command", () => {
    writeConfig(repoDir, "exit 1");
    const run = runGate("cd /tmp && git commit -m x", repoDir);
    expect(run.status).toBe(2);
  });

  it.skipIf(process.platform === "win32")(
    "sanitizes a garbage $ARGOS_GATE_TIMEOUT_MS (negative) to the default instead of crashing execSync",
    () => {
      const sentinel = join(repoDir, "sentinel.txt");
      writeConfig(repoDir, "echo gate-ran > sentinel.txt");

      // Number(garbage) || default used to let -5 (and NaN, fractions, etc.)
      // straight through to execSync's `timeout` option, which throws
      // ERR_OUT_OF_RANGE before the gate command is even spawned.
      const run = runGate("git commit -m x", repoDir, { ARGOS_GATE_TIMEOUT_MS: "-5" });

      expect(run.status).toBe(0);
      expect(readFileSync(sentinel, "utf-8")).toContain("gate-ran");
    },
  );

  it.skipIf(process.platform === "win32")(
    "two-stage filter: skips the node spawn entirely for a payload with no 'commit' substring",
    () => {
      // A fake `node` shim that proves whether it was ever invoked: it
      // writes a sentinel to stderr and exits non-zero, so `set -euo
      // pipefail` would abort the whole script the instant it actually runs.
      const fakeBinDir = mkdtempSync(join(tmpdir(), "argos-gate-fakenode-"));
      writeFileSync(join(fakeBinDir, "node"), "#!/usr/bin/env bash\necho fake-node-invoked >&2\nexit 7\n", "utf-8");
      chmodSync(join(fakeBinDir, "node"), 0o755);

      try {
        writeConfig(repoDir, "exit 1"); // would fail loudly if the gate ever ran
        const fakeNodeFirst = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: repoDir };

        const nonCommit = spawnSync("bash", [HOOK_PATH], {
          input: JSON.stringify({ tool_input: { command: "ls -la" } }),
          encoding: "utf-8",
          env: fakeNodeFirst,
        });
        expect(nonCommit.status).toBe(0);
        expect(nonCommit.stderr ?? "").not.toContain("fake-node-invoked");

        // Sanity check: a commit payload DOES still reach stage 2 (which
        // invokes node) — proves the shortcut above wasn't just a no-op stub.
        const commit = spawnSync("bash", [HOOK_PATH], {
          input: JSON.stringify({ tool_input: { command: "git commit -m x" } }),
          encoding: "utf-8",
          env: fakeNodeFirst,
        });
        expect(commit.stderr ?? "").toContain("fake-node-invoked");
      } finally {
        rmSync(fakeBinDir, { recursive: true, force: true });
      }
    },
  );
});
