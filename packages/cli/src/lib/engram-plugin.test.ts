import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClaudeCliResult,
  type ClaudeCliRunner,
  ENGRAM_MARKETPLACE,
  ENGRAM_PLUGIN_SPEC,
  installEngramPlugin,
  isEngramPluginEnabled,
  manualEngramCommands,
} from "./engram-plugin.js";

function ok(stdout = ""): ClaudeCliResult {
  return { status: 0, stdout, stderr: "" };
}

function failure(stderr: string, status = 1): ClaudeCliResult {
  return { status, stdout: "", stderr };
}

function enoent(): ClaudeCliResult {
  return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
}

describe("isEngramPluginEnabled", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-engram-peek-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is false when the file is missing", () => {
    expect(isEngramPluginEnabled(settingsPath)).toBe(false);
  });

  it("is true when enabledPlugins['engram@engram'] is exactly true", () => {
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "engram@engram": true } }), "utf-8");
    expect(isEngramPluginEnabled(settingsPath)).toBe(true);
  });

  it("is false when the key is absent, falsy, or the JSON is corrupt/unexpected shape", () => {
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: {} }), "utf-8");
    expect(isEngramPluginEnabled(settingsPath)).toBe(false);

    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "engram@engram": false } }), "utf-8");
    expect(isEngramPluginEnabled(settingsPath)).toBe(false);

    writeFileSync(settingsPath, "{ not valid json", "utf-8");
    expect(isEngramPluginEnabled(settingsPath)).toBe(false);

    writeFileSync(settingsPath, JSON.stringify([1, 2, 3]), "utf-8");
    expect(isEngramPluginEnabled(settingsPath)).toBe(false);
  });
});

describe("manualEngramCommands", () => {
  it("names both commands the operator can run themselves", () => {
    const commands = manualEngramCommands();
    expect(commands).toEqual([
      `claude plugin marketplace add ${ENGRAM_MARKETPLACE}`,
      `claude plugin install ${ENGRAM_PLUGIN_SPEC}`,
    ]);
  });
});

describe("installEngramPlugin", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-engram-install-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Covers: R2
  it("already enabled → unchanged, without spawning any process", () => {
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { "engram@engram": true } }), "utf-8");
    const runner: ClaudeCliRunner = () => {
      throw new Error("must not be called — engram is already enabled");
    };

    const result = installEngramPlugin(settingsPath, { runner });

    expect(result).toEqual({ status: "unchanged" });
  });

  // Covers: R1
  it("not enabled → runs marketplace add then plugin install, in order, and reports created", () => {
    const calls: string[][] = [];
    const runner: ClaudeCliRunner = (args) => {
      calls.push(args);
      return ok();
    };

    const result = installEngramPlugin(settingsPath, { runner });

    expect(result).toEqual({ status: "created" });
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", ENGRAM_MARKETPLACE],
      ["plugin", "install", ENGRAM_PLUGIN_SPEC],
    ]);
  });

  // Covers: R3
  it("claude absent from PATH → error with both manual commands in detail", () => {
    const runner: ClaudeCliRunner = () => enoent();

    const result = installEngramPlugin(settingsPath, { runner });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("PATH");
    expect(result.detail).toContain(`claude plugin marketplace add ${ENGRAM_MARKETPLACE}`);
    expect(result.detail).toContain(`claude plugin install ${ENGRAM_PLUGIN_SPEC}`);
  });

  // Covers: R3
  it("timeout (ETIMEDOUT) → error with a dedicated timeout message, not the generic error.message", () => {
    const timeoutError = Object.assign(new Error("some generic spawnSync message"), { code: "ETIMEDOUT" });
    const runner: ClaudeCliRunner = () => ({ status: null, stdout: "", stderr: "", error: timeoutError });

    const result = installEngramPlugin(settingsPath, { runner });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("excedió el tiempo límite");
    expect(result.detail).not.toContain("some generic spawnSync message");
  });

  // Covers: R3
  it("plugin install step failing → error, even though marketplace add succeeded", () => {
    let call = 0;
    const runner: ClaudeCliRunner = () => {
      call++;
      return call === 1 ? ok() : failure("boom");
    };

    const result = installEngramPlugin(settingsPath, { runner });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("boom");
    expect(result.detail).toContain(`claude plugin install ${ENGRAM_PLUGIN_SPEC}`);
  });

  // Covers: R3
  it("marketplace add failing for a real reason (not 'already registered') → error, install never attempted", () => {
    const calls: string[][] = [];
    const runner: ClaudeCliRunner = (args) => {
      calls.push(args);
      return failure("permission denied");
    };

    const result = installEngramPlugin(settingsPath, { runner });

    expect(result.status).toBe("error");
    expect(result.detail).toContain("permission denied");
    expect(calls).toHaveLength(1); // install was never reached
  });

  // Covers: R3
  it("marketplace 'already registered' failure is tolerated — install still proceeds and succeeds", () => {
    const calls: string[][] = [];
    const runner: ClaudeCliRunner = (args) => {
      calls.push(args);
      if (args.includes("marketplace")) return failure("Error: marketplace already registered");
      return ok();
    };

    const result = installEngramPlugin(settingsPath, { runner });

    expect(result).toEqual({ status: "created" });
    expect(calls).toHaveLength(2);
  });
});
