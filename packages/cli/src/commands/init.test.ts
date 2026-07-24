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
    const report = runInit();

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
    runInit();

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

  it("preserves foreign CLAUDE.md content byte-exact outside the managed blocks", () => {
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

    it("installHooks: false on a SECOND run does not retroactively strip hooks a prior run already installed", () => {
      runInit(); // default run installs both hooks + their settings.json entries
      const guardScriptPath = join(claudeDir, "hooks", "argos-guard-destructive.sh");
      const gateScriptPath = join(claudeDir, "hooks", "argos-quality-gate.sh");
      expect(existsSync(guardScriptPath)).toBe(true);
      expect(existsSync(gateScriptPath)).toBe(true);
      const settingsBefore = readFileSync(join(claudeDir, "settings.json"), "utf-8");

      const report = runInit({ installHooks: false });

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
      const report = runInit();
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
      runInit();
      const second = runInit();

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

      const report = runInit();

      const skillMdRow = report.rows.find((r) => r.path === join("skills", "angular", "SKILL.md"));
      expect(skillMdRow?.status).toBe("skipped-foreign");
      expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(foreignSkillMd);

      const coreRow = report.rows.find((r) => r.path === join("skills", "angular", "references", "core.md"));
      expect(coreRow?.status).toBe("skipped-foreign");
      expect(existsSync(join(skillDir, "references", "core.md"))).toBe(false);
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
    const viaInteractive = await runInitInteractive({ language: "en", yes: true, prompter });

    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(argosHome, { recursive: true });
    const viaDirect = runInit({ language: "en" });

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
    const report = await runInitInteractive({ prompter });

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
      const prompter = makeFakePrompter(["es", true, true, false]); // final confirm = false
      const before = existsSync(claudeDir) ? readdirSync(claudeDir) : [];

      const report = await runInitInteractive({ prompter });

      expect(report.exitCode).toBe(1);
      expect(report.rows).toEqual([]);
      const after = existsSync(claudeDir) ? readdirSync(claudeDir) : [];
      expect(after).toEqual(before);
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
          CANCEL, // cancel right at the navori takeover prompt
        ]);

        const report = await runInitInteractive({ prompter });

        expect(report.exitCode).toBe(1);
        expect(report.rows).toEqual([]);
        expect(snapshotDir(claudeDir)).toEqual(before);
      });
    });
  });
});
