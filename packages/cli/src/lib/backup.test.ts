import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackup } from "./backup.js";

const cpSyncMock = vi.fn();

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      if (cpSyncMock.getMockImplementation()) return cpSyncMock(...args);
      return actual.cpSync(...args);
    },
  };
});

describe("createBackup", () => {
  let claudeDir: string;
  let argosHome: string;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "argos-claude-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-home-"));
    process.env.ARGOS_HOME = argosHome;

    writeFileSync(join(claudeDir, "CLAUDE.md"), "# Global CLAUDE.md\n", "utf-8");
    mkdirSync(join(claudeDir, "agents"), { recursive: true });
    writeFileSync(join(claudeDir, "agents", "explorer.md"), "# Explorer\n", "utf-8");
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  it("copies listed files and directories into a timestamped backup dir", () => {
    const backupDir = createBackup(claudeDir, ["CLAUDE.md", "agents"]);

    expect(backupDir.startsWith(join(argosHome, "backups"))).toBe(true);
    expect(existsSync(join(backupDir, "CLAUDE.md"))).toBe(true);
    expect(readFileSync(join(backupDir, "CLAUDE.md"), "utf-8")).toBe("# Global CLAUDE.md\n");
    expect(existsSync(join(backupDir, "agents", "explorer.md"))).toBe(true);
  });

  it("skips entries that do not exist without throwing", () => {
    const backupDir = createBackup(claudeDir, ["CLAUDE.md", "does-not-exist.md"]);
    expect(existsSync(join(backupDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(backupDir, "does-not-exist.md"))).toBe(false);
  });

  it("creates a fresh backup directory per call", () => {
    const first = createBackup(claudeDir, ["CLAUDE.md"]);
    const second = createBackup(claudeDir, ["CLAUDE.md"]);
    expect(first).not.toBe(second);
  });

  it("removes the partial backup directory and rethrows when cpSync fails", () => {
    const cpSyncError = new Error("EACCES: permission denied");
    cpSyncMock.mockImplementation(() => {
      throw cpSyncError;
    });

    try {
      expect(() => createBackup(claudeDir, ["CLAUDE.md"])).toThrow(cpSyncError);
    } finally {
      cpSyncMock.mockReset();
    }

    const backupsRoot = join(argosHome, "backups");
    const remaining = existsSync(backupsRoot) ? readdirSync(backupsRoot) : [];
    expect(remaining).toHaveLength(0);
  });
});
