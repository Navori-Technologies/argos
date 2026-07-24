import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
        const report = runInit();

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
      const report = runInit();
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
      const report = runInit();

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

      const report = runInit();
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
      runInit();
      const second = runInit();

      const hookRows = second.rows.filter((r) => r.path.startsWith(join("hooks", "")));
      expect(hookRows.every((r) => r.status === "unchanged")).toBe(true);
      expect(second.rows.some((r) => r.path === "settings.json" && r.status === "unchanged")).toBe(true);
    });

    it("skips a foreign hook script (no argos:file marker) and leaves it byte-identical", () => {
      const guardPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
      mkdirSync(join(claudeDir, "hooks"), { recursive: true });
      const foreignContent = "#!/usr/bin/env bash\necho hand-written hook\n";
      writeFileSync(guardPath, foreignContent, "utf-8");

      const report = runInit();

      const row = report.rows.find((r) => r.path === join("hooks", "argos-guard-destructive.sh"));
      expect(row?.status).toBe("skipped-foreign");
      expect(readFileSync(guardPath, "utf-8")).toBe(foreignContent);
    });

    it("strips a hook's PREVIOUSLY-successful settings.json entry when its write breaks on a later run", () => {
      // Run 1: fresh install, both hooks succeed and get real entries.
      const first = runInit();
      expect(first.exitCode).toBe(0);

      // Now the gate script breaks (e.g. something replaced it with a dir).
      const gatePath = join(claudeDir, "hooks", "argos-quality-gate.sh");
      rmSync(gatePath, { recursive: true, force: true });
      mkdirSync(gatePath, { recursive: true });

      const second = runInit();
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

      const report = runInit();

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

      const report = runInit();

      expect(report.exitCode).toBe(1);
      const row = report.rows.find((r) => r.path === "settings.json");
      expect(row?.status).toBe("error");
      expect(row?.detail).toBeTruthy();
      expect(readFileSync(join(claudeDir, "settings.json"), "utf-8")).toBe(corrupt);
    });
  });
});
