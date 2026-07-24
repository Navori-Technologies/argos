import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Prompter } from "../lib/prompter.js";
import { runAdopt } from "./adopt.js";
import { runInit } from "./init.js";
import { type RemoveRow, runRemove, runRemoveInteractive } from "./remove.js";

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

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
}

/** Recursively snapshot every file under `dir` as a relative-path -> content map. */
function snapshot(dir: string): Record<string, string> {
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

describe("runRemove", () => {
  let claudeDir: string;
  let argosHome: string;
  const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "argos-remove-claude-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-remove-home-"));
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

  describe("full round trip", () => {
    it("undoes init back to the pre-init state, except backups, and leaves foreign content untouched", () => {
      // Seed foreign content BEFORE init: a foreign file in agents/, a
      // pre-existing CLAUDE.md, and a foreign settings.json entry.
      mkdirSync(join(claudeDir, "agents"), { recursive: true });
      const foreignAgentPath = join(claudeDir, "agents", "my-own-agent.md");
      const foreignAgentContent = "---\nname: my-own-agent\n---\n\nHand-written, not argos.\n";
      writeFileSync(foreignAgentPath, foreignAgentContent, "utf-8");

      const foreignClaudeMd = "# My global notes\n\nHand-written, do not touch.\n";
      writeFileSync(join(claudeDir, "CLAUDE.md"), foreignClaudeMd, "utf-8");

      const foreignSettings = {
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }] },
        permissions: { allow: ["Read(**)"] },
      };
      writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(foreignSettings, null, 2), "utf-8");

      const initReport = runInit();
      expect(initReport.exitCode).toBe(0);

      // Sanity: init actually installed argos-owned stuff on top.
      expect(existsSync(join(claudeDir, "agents", "explorer.md"))).toBe(true);
      expect(existsSync(join(claudeDir, "skills", "verify-before-done", "SKILL.md"))).toBe(true);
      expect(existsSync(join(claudeDir, "hooks", "argos-guard-destructive.sh"))).toBe(true);

      const removeReport = runRemove({ apply: true });
      expect(removeReport.exitCode).toBe(0);
      expect(removeReport.backupPath).toBeTruthy();

      // Foreign agent file survives untouched.
      expect(existsSync(foreignAgentPath)).toBe(true);
      expect(readFileSync(foreignAgentPath, "utf-8")).toBe(foreignAgentContent);

      // Every argos-owned file is gone.
      expect(existsSync(join(claudeDir, "agents", "explorer.md"))).toBe(false);
      expect(existsSync(join(claudeDir, "skills", "verify-before-done", "SKILL.md"))).toBe(false);
      expect(existsSync(join(claudeDir, "output-styles", "argos.md"))).toBe(false);
      expect(existsSync(join(claudeDir, "hooks", "argos-guard-destructive.sh"))).toBe(false);
      expect(existsSync(join(claudeDir, "hooks", "argos-quality-gate.sh"))).toBe(false);

      // The now-empty skills/verify-before-done dir was cleaned up, but
      // agents/ itself survives because the foreign file still lives there.
      expect(existsSync(join(claudeDir, "skills", "verify-before-done"))).toBe(false);
      expect(existsSync(join(claudeDir, "agents"))).toBe(true);

      // settings.json: argos entries gone, foreign entry and foreign
      // top-level key survive.
      const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf-8")) as {
        hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
        permissions: { allow: string[] };
      };
      expect(settings.permissions).toEqual({ allow: ["Read(**)"] });
      const commands = settings.hooks.PreToolUse.flatMap((b) => b.hooks.map((h) => h.command));
      expect(commands).toEqual(["echo user-hook"]);

      // CLAUDE.md: argos blocks stripped, foreign content preserved (file not deleted).
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
      const claudeMd = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("Hand-written, do not touch.");
      expect(claudeMd).not.toContain("argos:managed");
    });

    it("deletes CLAUDE.md entirely when it becomes empty after stripping argos's own blocks", () => {
      runInit(); // CLAUDE.md now holds ONLY the 5 argos-managed blocks

      const report = runRemove({ apply: true });
      expect(report.exitCode).toBe(0);
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(false);
    });
  });

  describe("--purge", () => {
    it("removes ~/.argos data including backups when combined with --apply", () => {
      runInit();
      expect(existsSync(join(argosHome, "global.json"))).toBe(true);

      const report = runRemove({ apply: true, purge: true });
      expect(report.exitCode).toBe(0);

      expect(existsSync(join(argosHome, "global.json"))).toBe(false);
      expect(existsSync(join(argosHome, "backups"))).toBe(false);
      expect(report.warnings.some((w: string) => w.includes("backups"))).toBe(true);
    });

    it("keeps ~/.argos data by default (no --purge)", () => {
      runInit();
      runRemove({ apply: true });
      expect(existsSync(join(argosHome, "global.json"))).toBe(true);
    });
  });

  describe("preview mode", () => {
    it("changes nothing on disk while still reporting what would be removed", () => {
      runInit();

      const before = snapshot(claudeDir);
      const beforeHome = snapshot(argosHome);

      const report = runRemove(); // no apply flag => preview
      expect(report.exitCode).toBe(0);
      expect(report.rows.length).toBeGreaterThan(0);
      expect(
        report.rows.every(
          (r: RemoveRow) => r.status === "would-remove" || r.status === "skipped-foreign" || r.status === "info",
        ),
      ).toBe(true);
      expect(report.backupPath).toBeUndefined();

      const after = snapshot(claudeDir);
      const afterHome = snapshot(argosHome);
      expect(after).toEqual(before);
      expect(afterHome).toEqual(beforeHome);
    });

    it("also previews --purge without touching ~/.argos", () => {
      runInit();
      const beforeHome = snapshot(argosHome);

      const report = runRemove({ purge: true }); // no apply
      expect(existsSync(join(argosHome, "global.json"))).toBe(true);
      expect(snapshot(argosHome)).toEqual(beforeHome);
      // runInit() already created a backup dir via its own createBackup call
      // — a preview run must not touch it, and must still warn since --purge
      // would remove it on a real (--apply) run.
      expect(existsSync(join(argosHome, "backups"))).toBe(true);
      expect(report.warnings.some((w: string) => w.includes("backups"))).toBe(true);
    });
  });

  describe("corrupt settings.json", () => {
    it("refuses the same way the merge path does, reporting an error and leaving the file untouched", () => {
      runInit();
      const settingsPath = join(claudeDir, "settings.json");
      const corrupt = "{ not valid json";
      writeFileSync(settingsPath, corrupt, "utf-8");

      const report = runRemove({ apply: true });

      expect(report.exitCode).toBe(1);
      const row = report.rows.find((r: RemoveRow) => r.path === "settings.json");
      expect(row?.status).toBe("error");
      expect(row?.detail).toBeTruthy();
      expect(readFileSync(settingsPath, "utf-8")).toBe(corrupt);
    });

    it("reports the same corrupt-JSON refusal in preview mode too, without writing anything", () => {
      runInit();
      const settingsPath = join(claudeDir, "settings.json");
      const corrupt = "[1, 2, 3]";
      writeFileSync(settingsPath, corrupt, "utf-8");

      const report = runRemove();

      expect(report.exitCode).toBe(1);
      const row = report.rows.find((r: RemoveRow) => r.path === "settings.json");
      expect(row?.status).toBe("error");
      expect(readFileSync(settingsPath, "utf-8")).toBe(corrupt);
    });
  });

  describe("skill directories (subfiles, not just SKILL.md)", () => {
    it("removes exactly the shipped subfiles for a skill, but preserves a user-added extra file in the same directory", () => {
      runInit();
      const angularDir = join(claudeDir, "skills", "angular");
      expect(existsSync(join(angularDir, "references", "core.md"))).toBe(true);

      // A file the user dropped into the same skill directory, not part of
      // the shipped manifest.
      const extraPath = join(angularDir, "my-notes.md");
      const extraContent = "My own notes, not shipped by argos.\n";
      writeFileSync(extraPath, extraContent, "utf-8");

      const report = runRemove({ apply: true });
      expect(report.exitCode).toBe(0);

      // Shipped subfiles and SKILL.md are gone.
      expect(existsSync(join(angularDir, "SKILL.md"))).toBe(false);
      expect(existsSync(join(angularDir, "references", "core.md"))).toBe(false);

      // The user's extra file survives, so the directory itself survives too.
      expect(existsSync(extraPath)).toBe(true);
      expect(readFileSync(extraPath, "utf-8")).toBe(extraContent);

      const extraRow = report.rows.find((r) => r.path === join("skills", "angular", "my-notes.md"));
      expect(extraRow?.status).toBe("skipped-foreign");
    });

    it("round trip: init -> remove leaves a foreign (unmarked) skill directory from init untouched", () => {
      const skillDir = join(claudeDir, "skills", "angular");
      mkdirSync(skillDir, { recursive: true });
      const foreignSkillMd = "---\nname: angular\n---\n\nMy own hand-written skill.\n";
      writeFileSync(join(skillDir, "SKILL.md"), foreignSkillMd, "utf-8");

      runInit(); // skips the whole foreign angular dir (see init.test.ts)
      const report = runRemove({ apply: true });
      expect(report.exitCode).toBe(0);

      expect(readFileSync(join(skillDir, "SKILL.md"), "utf-8")).toBe(foreignSkillMd);
      expect(existsSync(join(skillDir, "references"))).toBe(false);

      const skillMdRow = report.rows.find((r) => r.path === join("skills", "angular", "SKILL.md"));
      expect(skillMdRow?.status).toBe("skipped-foreign");
    });
  });

  describe("dangling/unclosed CLAUDE.md marker", () => {
    function seedDanglingMarker(): void {
      mkdirSync(claudeDir, { recursive: true });
      // Hand-crafted open marker with no matching close — simulates crash
      // residue or manual corruption.
      const content = '<!-- argos:managed id="identidad" v="1.0.0" -->\nNever closed.\n';
      writeFileSync(join(claudeDir, "CLAUDE.md"), content, "utf-8");
    }

    it("does not hang in apply mode and reports the warning row", () => {
      seedDanglingMarker();

      const report = runRemove({ apply: true });

      expect(report.exitCode).toBe(0);
      const warningRow = report.rows.find((r: RemoveRow) => r.status === "warning");
      expect(warningRow?.detail).toContain("huérfano");
      // The dangling content is untouched since it could never be safely cut.
      expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8")).toContain("Never closed.");
    });

    it("does not hang in preview mode and reports the warning row without writing anything", () => {
      seedDanglingMarker();
      const before = readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8");

      const report = runRemove(); // no apply => preview

      expect(report.exitCode).toBe(0);
      const warningRow = report.rows.find((r: RemoveRow) => r.status === "warning");
      expect(warningRow?.detail).toContain("huérfano");
      expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf-8")).toBe(before);
    });
  });

  describe("scope note", () => {
    it("always ends the report with an info row stating repo-side artifacts are out of scope", () => {
      runInit();
      const report = runRemove();

      const scopeRow = report.rows.at(-1);
      expect(scopeRow?.status).toBe("info");
      expect(scopeRow?.detail).toContain("argos.config.json");
      expect(scopeRow?.detail).toContain("~/.claude");
      expect(scopeRow?.detail).toContain("~/.argos");
    });

    it("--purge regression: an adopted repo's argos.config.json and CLAUDE.md ficha block survive remove --purge", () => {
      const repoDir = mkdtempSync(join(tmpdir(), "argos-remove-repo-"));
      try {
        initGitRepo(repoDir);
        runInit();
        runAdopt({ cwd: repoDir });

        const configPath = join(repoDir, "argos.config.json");
        const repoClaudeMdPath = join(repoDir, "CLAUDE.md");
        expect(existsSync(configPath)).toBe(true);
        const configBefore = readFileSync(configPath, "utf-8");
        const repoClaudeMdBefore = readFileSync(repoClaudeMdPath, "utf-8");
        expect(repoClaudeMdBefore).toContain("Ficha del repo");

        const report = runRemove({ apply: true, purge: true });
        expect(report.exitCode).toBe(0);

        expect(readFileSync(configPath, "utf-8")).toBe(configBefore);
        expect(readFileSync(repoClaudeMdPath, "utf-8")).toBe(repoClaudeMdBefore);
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe("voice activation (settings.json.outputStyle)", () => {
    it("removes outputStyle when it's exactly Argos", () => {
      runInit();
      const settingsPath = join(claudeDir, "settings.json");
      expect((JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string }).outputStyle).toBe("Argos");

      const report = runRemove({ apply: true });

      expect(report.exitCode).toBe(0);
      const row = report.rows.find((r) => r.path === "settings.json#outputStyle");
      expect(row?.status).toBe("removed");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle?: string };
      expect(settings.outputStyle).toBeUndefined();
    });

    it("never touches a foreign (non-Argos) outputStyle", () => {
      runInit();
      const settingsPath = join(claudeDir, "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      settings.outputStyle = "my-custom-voice";
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

      const report = runRemove({ apply: true });

      expect(report.exitCode).toBe(0);
      const row = report.rows.find((r) => r.path === "settings.json#outputStyle");
      expect(row).toBeUndefined();
      const after = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
      expect(after.outputStyle).toBe("my-custom-voice");
    });

    it("preview mode reports would-remove and writes nothing", () => {
      runInit();
      const settingsPath = join(claudeDir, "settings.json");
      const before = readFileSync(settingsPath, "utf-8");

      const report = runRemove({ apply: false });

      const row = report.rows.find((r) => r.path === "settings.json#outputStyle");
      expect(row?.status).toBe("would-remove");
      expect(readFileSync(settingsPath, "utf-8")).toBe(before);
    });
  });
});

describe("runRemoveInteractive", () => {
  let claudeDir: string;
  let argosHome: string;
  const originalClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "argos-remove-interactive-claude-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-remove-interactive-home-"));
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

  it("--yes / no-TTY is byte-identical to calling runRemove directly, even with a prompter injected", async () => {
    runInit();
    const prompter = makeFakePrompter([]); // never consulted

    const viaInteractive = await runRemoveInteractive({ apply: true, yes: true, prompter });

    runInit(); // reset state for a fair second comparison run
    const viaDirect = runRemove({ apply: true });

    expect(viaInteractive.exitCode).toBe(viaDirect.exitCode);
    expect(viaInteractive.rows).toEqual(viaDirect.rows);
  });

  it("a plain preview (apply unset/false) never consults the prompter, even under a real TTY", async () => {
    runInit();
    let calls = 0;
    const prompter: Prompter = {
      ...makeFakePrompter([]),
      text: async () => {
        calls++;
        return CANCEL as never;
      },
    };

    const report = await runRemoveInteractive({ prompter });

    expect(calls).toBe(0);
    expect(report.exitCode).toBe(0);
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

    it("a wrong typed confirmation aborts --apply with zero writes", async () => {
      runInit();
      const before = snapshot(claudeDir);
      const prompter = makeFakePrompter(["not-the-right-directory"]);

      const report = await runRemoveInteractive({ apply: true, prompter });

      expect(report.exitCode).toBe(1);
      expect(report.rows).toEqual([{ path: "cancel", category: "scope-note", status: "info", detail: expect.any(String) }]);
      expect(snapshot(claudeDir)).toEqual(before);
    });

    it("the correct typed confirmation proceeds with --apply", async () => {
      runInit();
      const prompter = makeFakePrompter([claudeDir]);

      const report = await runRemoveInteractive({ apply: true, prompter });

      expect(report.exitCode).toBe(0);
      expect(report.rows.some((r) => r.status === "removed")).toBe(true);
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(false);
    });

    it("--purge requires a SECOND confirmation on top of the typed directory name", async () => {
      runInit();
      const prompter = makeFakePrompter([claudeDir, false]); // directory confirmed, purge declined

      const report = await runRemoveInteractive({ apply: true, purge: true, prompter });

      expect(report.exitCode).toBe(1);
      expect(report.rows).toEqual([{ path: "cancel", category: "scope-note", status: "info", detail: expect.any(String) }]);
      // Neither the engine nor ~/.argos was touched — the purge confirm gates the whole call.
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(true);
    });

    it("confirming both the directory name and the purge warning proceeds with --apply --purge", async () => {
      runInit();
      const prompter = makeFakePrompter([claudeDir, true]);

      const report = await runRemoveInteractive({ apply: true, purge: true, prompter });

      expect(report.exitCode).toBe(0);
      expect(report.rows.some((r) => r.status === "removed")).toBe(true);
      expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(false);
    });
  });
});
