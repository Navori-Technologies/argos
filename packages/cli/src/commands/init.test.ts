import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "./init.js";

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
    const report = runInit();

    expect(report.exitCode).toBe(0);
    expect(report.rows.every((r) => r.status === "created")).toBe(true);

    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "output-styles", "argos.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "agents", "explorer.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "skills", "verify-before-done", "SKILL.md"))).toBe(true);
    expect(existsSync(join(argosHome, "global.json"))).toBe(true);

    const claudeMd = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    for (const id of ["identidad", "formato-respuesta", "aterrizaje", "orquestacion", "operaciones-seguras"]) {
      expect(claudeMd).toContain(`id="${id}"`);
    }

    const globalJson = JSON.parse(readFileSync(join(argosHome, "global.json"), "utf-8")) as {
      version: string;
      language: string;
    };
    expect(globalJson.language).toBe("es");
    expect(typeof globalJson.version).toBe("string");
  });

  it("respects the --language flag in global.json", () => {
    runInit({ language: "en" });
    const globalJson = JSON.parse(readFileSync(join(argosHome, "global.json"), "utf-8")) as { language: string };
    expect(globalJson.language).toBe("en");
  });

  it("is idempotent — a second run with no changes reports everything unchanged", () => {
    runInit();
    const second = runInit();

    expect(second.exitCode).toBe(0);
    expect(second.rows.every((r) => r.status === "unchanged")).toBe(true);
  });

  it("skips a foreign skill file (no argos:file marker) and leaves it byte-identical", () => {
    const foreignPath = join(claudeDir, "skills", "verify-before-done", "SKILL.md");
    mkdirSync(join(claudeDir, "skills", "verify-before-done"), { recursive: true });
    const foreignContent = "---\nname: verify-before-done\n---\n\nMy own hand-written skill.\n";
    writeFileSync(foreignPath, foreignContent, "utf-8");

    const report = runInit();

    const row = report.rows.find((r) => r.path === join("skills", "verify-before-done", "SKILL.md"));
    expect(row?.status).toBe("skipped-foreign");
    expect(readFileSync(foreignPath, "utf-8")).toBe(foreignContent);
  });

  it("preserves foreign CLAUDE.md content byte-exact outside the 5 managed blocks", () => {
    mkdirSync(claudeDir, { recursive: true });
    const foreignContent = "# My global notes\n\nHand-written, do not touch.\n";
    writeFileSync(join(claudeDir, "CLAUDE.md"), foreignContent, "utf-8");

    runInit();

    const claudeMd = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.startsWith(foreignContent)).toBe(true);
    expect(claudeMd).toContain('id="identidad"');
  });

  it.skipIf(process.platform === "win32")(
    "survives a read-only claudeDir with partial success and surfaces the backup path",
    () => {
      chmodSync(claudeDir, 0o500);
      try {
        const report = runInit();

        expect(report.exitCode).toBe(1);
        const errorRows = report.rows.filter((r) => r.status === "error");
        expect(errorRows.length).toBeGreaterThan(0);
        expect(errorRows.every((r) => typeof r.detail === "string" && r.detail.length > 0)).toBe(true);
        // global.json lives under ARGOS_HOME, unaffected by the read-only claudeDir.
        expect(report.rows.some((r) => r.path === "global.json" && r.status === "created")).toBe(true);
        // The backup itself only reads from claudeDir and writes elsewhere, so it still succeeds.
        expect(report.backupPath).toBeTruthy();
        expect(() => runInit()).not.toThrow();
      } finally {
        chmodSync(claudeDir, 0o700);
      }
    },
  );
});
