import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pc from "picocolors";
import {
  listAgentIds,
  listSkillFiles,
  listSkillIds,
  MANAGED_BLOCK_IDS,
  readAsset,
  resolveAssetsDir,
} from "../lib/assets.js";
import { writeFileAtomic } from "../lib/atomic-write.js";
import { createBackup } from "../lib/backup.js";
import { installEngramPlugin, type ClaudeCliRunner } from "../lib/engram-plugin.js";
import { injectBlock, listBlocks } from "../lib/markers.js";
import {
  type FileStatus,
  hasArgosFileMarker,
  hasArgosShellFileMarker,
  writeManagedFile,
  writeManagedShellFile,
} from "../lib/managed-files.js";
import { resolveArgosHome, resolveClaudeDir } from "../lib/paths.js";
import {
  type ArgosHookSpec,
  applyDefaultModePolicy,
  applyOutputStylePolicy,
  isNavoriOutputStyle,
  mergeHooksIntoSettings,
} from "../lib/settings-merge.js";
import { isInteractive, clackPrompter, type Prompter } from "../lib/prompter.js";
import { readCliVersion } from "../lib/version.js";

/**
 * Ids (basenames under assets/hooks/) of the 2 global hooks argos init
 * installs. See spec 0003 "Hooks globales parametrizados".
 */
const HOOK_IDS = ["argos-guard-destructive", "argos-quality-gate"] as const;

/**
 * Outer Claude Code hook timeout (seconds) for argos-quality-gate.sh. Fixed
 * rather than derived from $ARGOS_GATE_TIMEOUT_MS: that env var is read
 * inside the hook at COMMIT time (whatever env the Claude Code session has),
 * not at `argos init` time, so there's nothing meaningful to read here. 600s
 * comfortably covers the hook's own default inner bound (300s) with 2x
 * headroom; a repo whose gate legitimately needs longer than ~590s needs to
 * bump this constant (and rerun `argos init`) alongside its own
 * $ARGOS_GATE_TIMEOUT_MS — not automated in v1.
 */
const QUALITY_GATE_OUTER_TIMEOUT_SECONDS = 600;

export type InitRowStatus = FileStatus | "error";

export interface InitRow {
  path: string;
  status: InitRowStatus;
  detail?: string;
}

export interface InitOptions {
  language?: "es" | "en";
  /**
   * Install the agent full-file assets under `agents/`. Default `true`.
   * Skills are NEVER gated by an option (spec 0004: they load on-demand and
   * trimming them breaks the arsenal), only agents and hooks are.
   */
  installAgents?: boolean;
  /** Install the 2 global hooks (scripts + settings.json entries). Default `true`. */
  installHooks?: boolean;
  /**
   * Install the Engram persistent-memory plugin (`engram@engram`) via the
   * `claude` CLI when it isn't already enabled (spec 0005 R1/R2/R3). Default
   * `true`; the wizard's "instalar Engram sí/no" step (default sí, R4) passes
   * `false` when the operator declines — the whole step is then skipped
   * entirely (no row, no process spawned).
   */
  installEngram?: boolean;
  /**
   * Injectable for tests; defaults to `runClaudeCli` (see
   * lib/engram-plugin.ts). Never used outside tests — the real `argos init`
   * CLI always goes through the real `claude`-CLI-backed runner.
   */
  engramRunner?: ClaudeCliRunner;
  /**
   * Set `settings.json.permissions.defaultMode` to `"auto"` when the key is
   * absent (spec 0005 R5/R6). Default `true`; the wizard's "activar auto mode
   * sí/no" step (default sí, R7) passes `false` when the operator declines —
   * the key is then never touched and no row is emitted. Never overwrites an
   * already-set `defaultMode`, whatever its value (R6).
   */
  setAutoMode?: boolean;
  /**
   * Whether to take over `settings.json.outputStyle` when it currently
   * points at the predecessor harness's voice (`navori`). Default `true`
   * (unconditional replace — the `--yes`/no-TTY behavior from spec 0004);
   * the interactive wizard passes `false` when the user declines the
   * takeover prompt.
   */
  takeoverNavoriVoice?: boolean;
  /**
   * `argos init --force`: full-file motor assets (skills incl. every
   * manifest subfile, agents, output-styles, hooks) that exist on disk
   * WITHOUT an `argos:file` ownership marker — normally left untouched,
   * reported `skipped-foreign` — get overwritten with the motor version
   * instead, reported `overwritten-foreign`. The marker lands with the
   * write, so a later (non-forced) `init` treats them as owned from then on.
   * Does NOT cross into CLAUDE.md prose (managed-block injection stays
   * own-blocks-only) or foreign `settings.json` entries (surgical merge is
   * unchanged) — force only ever replaces whole files at motor paths.
   * Default `false`.
   */
  force?: boolean;
}

export interface InitReport {
  rows: InitRow[];
  summary: string;
  exitCode: 0 | 1;
  backupPath?: string;
}

const STATUS_COUNT_ORDER: InitRowStatus[] = [
  "created",
  "updated",
  "unchanged",
  "skipped-foreign",
  "overwritten-foreign",
  "error",
];

function summarize(rows: InitRow[]): string {
  const counts: Record<InitRowStatus, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    "skipped-foreign": 0,
    "overwritten-foreign": 0,
    error: 0,
  };
  for (const row of rows) counts[row.status]++;

  const parts = STATUS_COUNT_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return `argos init: ${parts.join(", ")}.`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write a plain (unmarked) supporting file belonging to an already
 * ownership-checked skill directory — e.g. `references/core.md`,
 * `phases/0-product.md`. Unlike `writeManagedFile`, this never carries or
 * checks the `argos:file` marker itself: ownership for the whole skill
 * directory is decided once, up front, from its `SKILL.md` (see the skills
 * loop in `runInit`), so per-file marker bookkeeping here would be
 * redundant. Reports the same created/updated/unchanged statuses.
 */
function writePlainFile(destPath: string, sourceContent: string): FileStatus {
  if (!existsSync(destPath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileAtomic(destPath, sourceContent);
    return "created";
  }

  const current = readFileSync(destPath, "utf-8");
  if (current === sourceContent) return "unchanged";

  writeFileAtomic(destPath, sourceContent);
  return "updated";
}

/**
 * `--force` counterpart to `writePlainFile`, used only for a supporting file
 * (e.g. `references/core.md`) that lives under a skill directory whose
 * `SKILL.md` was just detected as foreign (no `argos:file` marker). These
 * plain subfiles never carry a marker of their own — the whole skill
 * directory's ownership is decided once from `SKILL.md` (see the skills loop
 * below) — so this always overwrites unconditionally: `overwritten-foreign`
 * when something was already there to replace, `created` when the motor
 * ships a subfile the foreign directory never had.
 */
function writeForcedPlainFile(destPath: string, sourceContent: string): FileStatus {
  const existed = existsSync(destPath);
  if (!existed) mkdirSync(dirname(destPath), { recursive: true });
  writeFileAtomic(destPath, sourceContent);
  return existed ? "overwritten-foreign" : "created";
}

/** Inject one managed CLAUDE.md block, reporting created/updated/unchanged. */
function injectAndReport(claudeMd: string, id: string, version: string, content: string) {
  const hadBlock = listBlocks(claudeMd).some((b) => b.id === id);
  const after = injectBlock(claudeMd, id, version, content);
  const status: FileStatus = after === claudeMd ? "unchanged" : hadBlock ? "updated" : "created";
  return { claudeMd: after, status };
}

/**
 * Core, testable implementation of `argos init`: installs the Argos engine
 * (CLAUDE.md managed blocks + agents/skills/output-style full files +
 * `~/.argos/global.json`) into `resolveClaudeDir()`. Pure function of the
 * filesystem — no process.exit, no console output.
 */
export function runInit(options: InitOptions = {}): InitReport {
  const language = options.language ?? "es";
  const installAgents = options.installAgents ?? true;
  const installHooks = options.installHooks ?? true;
  const installEngram = options.installEngram ?? true;
  const setAutoMode = options.setAutoMode ?? true;
  const force = options.force ?? false;
  const version = readCliVersion();
  const claudeDir = resolveClaudeDir();
  const assetsDir = resolveAssetsDir();
  const rows: InitRow[] = [];

  // Backup everything Argos is about to touch, before any write happens. A
  // failed backup means we have no safety net for what's about to be
  // mutated, so it aborts the whole run right here — every subsequent
  // mutation step is skipped, nothing gets touched.
  let backupPath: string | undefined;
  try {
    backupPath = createBackup(claudeDir, ["CLAUDE.md", "agents", "skills", "output-styles", "hooks", "settings.json"]);
  } catch (err) {
    const detail = errorMessage(err);
    rows.push({ path: "backup", status: "error", detail });
    return { rows, summary: `backup falló — no se tocó nada (${detail}).`, exitCode: 1 };
  }

  // 1. CLAUDE.md — MANAGED_BLOCK_IDS.length managed blocks, in order.
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  let claudeMd = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
  const blockResults: { id: string; status: FileStatus }[] = [];
  for (const id of MANAGED_BLOCK_IDS) {
    const content = readAsset(assetsDir, "managed", `${id}.md`).replace(/\n$/, "");
    const result = injectAndReport(claudeMd, id, version, content);
    claudeMd = result.claudeMd;
    blockResults.push({ id, status: result.status });
  }
  try {
    mkdirSync(claudeDir, { recursive: true });
    writeFileAtomic(claudeMdPath, claudeMd);
    for (const b of blockResults) rows.push({ path: `CLAUDE.md#${b.id}`, status: b.status });
  } catch (err) {
    const detail = errorMessage(err);
    for (const id of MANAGED_BLOCK_IDS) rows.push({ path: `CLAUDE.md#${id}`, status: "error", detail });
  }

  // 2. Full-file assets: output-style always, agents gated by the
  // `installAgents` toggle (default true; the wizard's "agentes sí/no"
  // step — spec 0004). Skills below are NEVER gated: they load on-demand
  // and trimming the set breaks the arsenal.
  const fullFiles: string[][] = [
    ["output-styles", "argos.md"],
    ...(installAgents ? listAgentIds(assetsDir).map((id) => ["agents", `${id}.md`]) : []),
  ];
  for (const relPath of fullFiles) {
    const source = readAsset(assetsDir, ...relPath);
    const dest = join(claudeDir, ...relPath);
    try {
      const status = writeManagedFile(dest, source, version, { force });
      rows.push({ path: join(...relPath), status });
    } catch (err) {
      rows.push({ path: join(...relPath), status: "error", detail: errorMessage(err) });
    }
  }

  // 2a. Skills: each skill directory (SKILL.md plus any `references/`,
  // `phases/`, `assets/`, etc. it ships) is installed as a single unit.
  // Ownership sentinel is SKILL.md's `argos:file` marker:
  // - SKILL.md absent, or present WITH the marker → install/update every
  //   file the skill ships.
  // - SKILL.md present WITHOUT the marker (foreign/user-modified) → skip
  //   every file under that skill dir, untouched — same policy as a single
  //   foreign full-file asset above, extended to the whole directory. Under
  //   `--force`, every file in that directory is overwritten instead
  //   (`overwritten-foreign`) — SKILL.md gets its marker stamped via
  //   `writeManagedFile`'s own `force` path, and each plain subfile is
  //   force-written via `writeForcedPlainFile` (see its own doc comment).
  for (const skillId of listSkillIds(assetsDir)) {
    const skillMdDest = join(claudeDir, "skills", skillId, "SKILL.md");
    const isForeignSkill = existsSync(skillMdDest) && !hasArgosFileMarker(readFileSync(skillMdDest, "utf-8"));

    for (const relFile of listSkillFiles(assetsDir, skillId)) {
      const relParts = relFile.split("/");
      const relPath = join("skills", skillId, ...relParts);

      if (isForeignSkill && !force) {
        rows.push({ path: relPath, status: "skipped-foreign" });
        continue;
      }

      const source = readAsset(assetsDir, "skills", skillId, ...relParts);
      const dest = join(claudeDir, "skills", skillId, ...relParts);
      try {
        const status =
          relFile === "SKILL.md"
            ? writeManagedFile(dest, source, version, { force })
            : isForeignSkill
              ? writeForcedPlainFile(dest, source)
              : writePlainFile(dest, source);
        rows.push({ path: relPath, status });
      } catch (err) {
        rows.push({ path: relPath, status: "error", detail: errorMessage(err) });
      }
    }
  }

  // 2b. Global hooks: full-file shell assets, own shell-comment marker,
  // chmod +x. Same skipped-foreign policy as the full-file assets above.
  // Track which hooks actually landed on disk successfully — a hook whose
  // write threw must NEVER get a settings.json entry (see 2c below): a
  // dangling PreToolUse entry pointing at a script that isn't there hard-
  // blocks every subsequent Bash call.
  //
  // Gated by the `installHooks` toggle (default true; the wizard's "hooks
  // sí/no" step — spec 0004): when disabled, this run neither writes nor
  // touches any pre-existing hook script/settings.json entry — a full
  // uninstall of previously-installed hooks is `argos remove`'s job, not a
  // side effect of toggling this flag off on a later `init` run.
  const hookWriteFailed = new Map<(typeof HOOK_IDS)[number], boolean>();
  if (installHooks) {
    for (const id of HOOK_IDS) {
      const relPath = ["hooks", `${id}.sh`];
      const source = readAsset(assetsDir, ...relPath);
      const dest = join(claudeDir, ...relPath);
      try {
        const status = writeManagedShellFile(dest, source, version, { force });
        rows.push({ path: join(...relPath), status });
        hookWriteFailed.set(id, false);
      } catch (err) {
        rows.push({ path: join(...relPath), status: "error", detail: errorMessage(err) });
        hookWriteFailed.set(id, true);
      }
    }

    // 2c. settings.json — surgical merge of the 2 PreToolUse hook entries.
    // Only writes/updates entries whose command targets one of the 2 scripts
    // above; every other key and hook in the user's settings.json is left
    // untouched (see lib/settings-merge.ts). Only hooks whose script write
    // actually succeeded get an entry built for them at all.
    const settingsPath = join(claudeDir, "settings.json");
    const allHookSpecs: Record<(typeof HOOK_IDS)[number], ArgosHookSpec> = {
      "argos-guard-destructive": {
        scriptPath: join(claudeDir, "hooks", "argos-guard-destructive.sh"),
        matcher: "Bash",
        timeout: 10,
        statusMessage: "argos: guard-destructive",
      },
      "argos-quality-gate": {
        scriptPath: join(claudeDir, "hooks", "argos-quality-gate.sh"),
        matcher: "Bash",
        timeout: QUALITY_GATE_OUTER_TIMEOUT_SECONDS,
        statusMessage: "argos: quality-gate",
      },
    };
    const hookSpecs: ArgosHookSpec[] = HOOK_IDS.filter((id) => !hookWriteFailed.get(id)).map((id) => allHookSpecs[id]);
    // Any hook whose write just failed also gets its (possibly pre-existing,
    // from an earlier successful run) settings.json entry stripped out — a
    // script that's gone or broken must never be left with a live entry.
    const failedScriptPaths = HOOK_IDS.filter((id) => hookWriteFailed.get(id)).map((id) => allHookSpecs[id].scriptPath);
    const mergeResult = mergeHooksIntoSettings(settingsPath, hookSpecs, { removeScriptPaths: failedScriptPaths });
    rows.push({ path: "settings.json", status: mergeResult.status, detail: mergeResult.detail });
  }

  // 2d. Engram plugin (spec 0005 "Engram como parte del motor"): install
  // `engram@engram` via the `claude` CLI unless it's already enabled.
  // Delegates entirely to `installEngramPlugin` (lib/engram-plugin.ts), which
  // peeks `enabledPlugins` itself and never writes settings.json directly —
  // a successful install is the `claude` CLI's own write, not ours. Gated by
  // the `installEngram` toggle (default true; the wizard's "Engram sí/no"
  // step — R4): when declined, this is skipped entirely, no row at all.
  if (installEngram) {
    const result = installEngramPlugin(join(claudeDir, "settings.json"), { runner: options.engramRunner });
    rows.push({ path: "plugins#engram", status: result.status, detail: result.detail });
  }

  // 2e. Voice activation (spec 0004 "Activación de la voz"):
  // settings.json.outputStyle. Absent → set to "Argos". Matching the
  // predecessor harness's voice (navori) → takeover per
  // `takeoverNavoriVoice` (default true, i.e. unconditional replace under
  // --yes/no-TTY; the interactive wizard passes `false` when the user
  // declines). Any other value → never touched. Reported separately from
  // the hooks settings.json row above so a takeover/foreign-voice detail is
  // never conflated with the hooks merge outcome.
  const outputStyleResult = applyOutputStylePolicy(join(claudeDir, "settings.json"), {
    takeoverNavori: options.takeoverNavoriVoice ?? true,
  });
  // "untouched" (a foreign non-navori voice, or a declined navori takeover)
  // maps to the same "skipped-foreign" row status used elsewhere for
  // "found something not ours, left it byte-identical".
  const outputStyleRowStatus: InitRowStatus =
    outputStyleResult.status === "untouched" ? "skipped-foreign" : outputStyleResult.status;
  rows.push({ path: "settings.json#outputStyle", status: outputStyleRowStatus, detail: outputStyleResult.detail });

  // 2f. Auto mode (spec 0005 "auto mode por defecto"):
  // settings.json.permissions.defaultMode. Absent → set to "auto". Already
  // "auto" → unchanged. Any other value → never touched (R6). Gated by the
  // `setAutoMode` toggle (default true; the wizard's "auto mode sí/no" step
  // — R7): when declined, this is skipped entirely, no row at all.
  if (setAutoMode) {
    const defaultModeResult = applyDefaultModePolicy(join(claudeDir, "settings.json"));
    rows.push({ path: "settings.json#defaultMode", status: defaultModeResult.status, detail: defaultModeResult.detail });
  }

  // 3. ~/.argos/global.json
  const argosHome = resolveArgosHome();
  const globalJsonPath = join(argosHome, "global.json");
  const globalJsonContent = `${JSON.stringify({ version, language }, null, 2)}\n`;
  try {
    const globalJsonExisted = existsSync(globalJsonPath);
    const globalJsonStatus: FileStatus = !globalJsonExisted
      ? "created"
      : readFileSync(globalJsonPath, "utf-8") === globalJsonContent
        ? "unchanged"
        : "updated";
    mkdirSync(argosHome, { recursive: true });
    writeFileSync(globalJsonPath, globalJsonContent, "utf-8");
    rows.push({ path: "global.json", status: globalJsonStatus });
  } catch (err) {
    rows.push({ path: "global.json", status: "error", detail: errorMessage(err) });
  }

  const exitCode: 0 | 1 = rows.some((r) => r.status === "error") ? 1 : 0;
  return { rows, summary: summarize(rows), exitCode, backupPath };
}

export interface InitInteractiveOptions extends InitOptions {
  /** `--yes`: forces non-interactive behavior even under a real TTY. */
  yes?: boolean;
  /** Injectable for tests; defaults to the real `@clack/prompts`-backed prompter. */
  prompter?: Prompter;
}

/**
 * A cancelled wizard's report: identical shape to a run that touched
 * nothing. `exitCode: 1` — a cancel is neither a successful write nor
 * silently indistinguishable from one by exit code alone (matches
 * `runWorkspaceLinkInteractive`'s convention for its own cancel paths).
 */
function cancelledInitReport(): InitReport {
  return { rows: [], summary: "argos init: cancelado — no se tocó nada.", exitCode: 1 };
}

/**
 * Read-only peek at `settings.json.outputStyle`, used only to decide whether
 * the interactive wizard needs to ask about a navori takeover. Never throws,
 * never writes — any missing file, unreadable file, or invalid JSON just
 * reads as "no value" (`undefined`), which is safely a non-match for
 * `isNavoriOutputStyle`. The actual write happens inside `runInit` via
 * `applyOutputStylePolicy`, which re-does this read itself under its own
 * mtime-guarded contract.
 */
function peekOutputStyleValue(settingsPath: string): unknown {
  if (!existsSync(settingsPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return (parsed as Record<string, unknown>).outputStyle;
  } catch {
    return undefined;
  }
}

/**
 * Read-only `--force` pre-flight: counts how many on-disk paths at motor
 * paths (output-style, agents, skills incl. every manifest subfile, hooks)
 * are foreign (no `argos:file`/shell marker) and would therefore be
 * overwritten by a forced `runInit`. Used only by the interactive wizard to
 * size its confirm prompt — the actual overwrite decision and write happen
 * inside `runInit` itself, independently, so this can never drift into
 * writing anything. Mirrors the same directory-ownership rule `runInit`'s
 * own skills loop uses (SKILL.md's marker decides the whole directory), and
 * — like `doctor.ts`'s own read-only checks — intentionally duplicates that
 * iteration shape rather than sharing private state with the writer.
 */
function countForceOverwrites(
  claudeDir: string,
  assetsDir: string,
  installAgents: boolean,
  installHooks: boolean,
): number {
  let count = 0;

  const fullFiles: string[][] = [
    ["output-styles", "argos.md"],
    ...(installAgents ? listAgentIds(assetsDir).map((id) => ["agents", `${id}.md`]) : []),
  ];
  for (const relPath of fullFiles) {
    const dest = join(claudeDir, ...relPath);
    if (existsSync(dest) && !hasArgosFileMarker(readFileSync(dest, "utf-8"))) count++;
  }

  for (const skillId of listSkillIds(assetsDir)) {
    const skillMdDest = join(claudeDir, "skills", skillId, "SKILL.md");
    const isForeignSkill = existsSync(skillMdDest) && !hasArgosFileMarker(readFileSync(skillMdDest, "utf-8"));
    if (!isForeignSkill) continue;
    for (const relFile of listSkillFiles(assetsDir, skillId)) {
      const dest = join(claudeDir, "skills", skillId, ...relFile.split("/"));
      if (existsSync(dest)) count++;
    }
  }

  if (installHooks) {
    for (const id of HOOK_IDS) {
      const dest = join(claudeDir, "hooks", `${id}.sh`);
      if (existsSync(dest) && !hasArgosShellFileMarker(readFileSync(dest, "utf-8"))) count++;
    }
  }

  return count;
}

/**
 * Interactive layer over `runInit` (spec 0004 F5 "argos init"; Engram/auto
 * mode confirms added by spec 0005). A pure additive wrapper — the core
 * `runInit` never changes behavior or contract. Without a real TTY, or with
 * `--yes`, this delegates to `runInit(options)` unchanged: no prompt library
 * call is ever reached on that path. With a TTY, it runs a wizard (language,
 * agents/hooks/Engram/auto-mode toggles, summary + final confirm) before
 * calling `runInit` with the gathered choices; cancelling at any step
 * touches nothing and returns a no-op report.
 */
export async function runInitInteractive(options: InitInteractiveOptions = {}): Promise<InitReport> {
  if (!isInteractive({ yes: options.yes })) {
    return runInit(options);
  }

  const prompter = options.prompter ?? clackPrompter;

  prompter.intro("argos init — instalación interactiva del motor");

  const language = await prompter.select<"es" | "en">({
    message: "Idioma del motor",
    options: [
      { value: "es", label: "es — español" },
      { value: "en", label: "en — English" },
    ],
    initialValue: options.language ?? "es",
  });
  if (prompter.isCancel(language)) {
    prompter.cancel("argos init cancelado — no se tocó nada.");
    return cancelledInitReport();
  }

  const installAgents = await prompter.confirm({
    message: "¿Instalar los agentes del motor (agents/)?",
    initialValue: options.installAgents ?? true,
  });
  if (prompter.isCancel(installAgents)) {
    prompter.cancel("argos init cancelado — no se tocó nada.");
    return cancelledInitReport();
  }

  const installHooks = await prompter.confirm({
    message: "¿Instalar los hooks globales (guard-destructive + quality-gate)?",
    initialValue: options.installHooks ?? true,
  });
  if (prompter.isCancel(installHooks)) {
    prompter.cancel("argos init cancelado — no se tocó nada.");
    return cancelledInitReport();
  }

  // Engram (spec 0005 R4): declining skips the whole step in `runInit`
  // (no row, no process spawned) — see `InitOptions.installEngram`.
  const installEngram = await prompter.confirm({
    message:
      "¿Instalar Engram, un plugin de terceros (Gentleman-Programming/engram, vía GitHub) que provee memoria persistente por MCP?",
    initialValue: options.installEngram ?? true,
  });
  if (prompter.isCancel(installEngram)) {
    prompter.cancel("argos init cancelado — no se tocó nada.");
    return cancelledInitReport();
  }

  // Auto mode (spec 0005 R7): declining skips the whole step in `runInit`
  // (key never touched, no row) — see `InitOptions.setAutoMode`.
  const setAutoMode = await prompter.confirm({
    message:
      '¿Setear permissions.defaultMode = "auto" en el settings.json global (~/.claude), reduciendo prompts de permiso en todas las sesiones de Claude Code de esta máquina?',
    initialValue: options.setAutoMode ?? true,
  });
  if (prompter.isCancel(setAutoMode)) {
    prompter.cancel("argos init cancelado — no se tocó nada.");
    return cancelledInitReport();
  }

  const claudeDir = resolveClaudeDir();

  // `--force` pre-flight (see `InitOptions.force`'s doc comment): flag-driven,
  // not itself a wizard question. When active, count how many on-disk paths
  // are foreign and about to be overwritten (read-only — see
  // `countForceOverwrites`) and, only if that count is > 0, require an
  // explicit confirm before proceeding. Zero foreign paths means force has
  // nothing to do this run, so no extra prompt.
  const force = options.force ?? false;
  if (force) {
    const foreignCount = countForceOverwrites(claudeDir, resolveAssetsDir(), installAgents, installHooks);
    if (foreignCount > 0) {
      const confirmForce = await prompter.confirm({
        message: `${foreignCount} archivos ajenos serán sobrescritos por versiones del motor — backup previo en ~/.argos/backups. ¿Continuar?`,
        initialValue: false,
      });
      if (prompter.isCancel(confirmForce) || !confirmForce) {
        prompter.cancel("argos init cancelado — no se tocó nada.");
        return cancelledInitReport();
      }
    }
  }

  // Voice activation (spec 0004): if the current settings.json.outputStyle
  // matches the predecessor harness's voice, ask before taking it over —
  // this peek is read-only and never writes; the actual takeover only
  // happens inside runInit below, once the user has confirmed everything.
  let takeoverNavoriVoice = options.takeoverNavoriVoice ?? true;
  const currentOutputStyle = peekOutputStyleValue(join(claudeDir, "settings.json"));
  if (isNavoriOutputStyle(currentOutputStyle)) {
    const takeover = await prompter.confirm({
      message: `settings.json.outputStyle apunta a la voz del harness predecesor ('${String(currentOutputStyle)}') — ¿reemplazarla por Argos?`,
      initialValue: true,
    });
    if (prompter.isCancel(takeover)) {
      prompter.cancel("argos init cancelado — no se tocó nada.");
      return cancelledInitReport();
    }
    takeoverNavoriVoice = takeover;
  }

  prompter.note(
    [
      `idioma: ${language}`,
      `agentes: ${installAgents ? "sí" : "no"}`,
      "hooks: " + (installHooks ? "sí" : "no"),
      "skills: sí (siempre — cargan on-demand)",
      `engram: ${installEngram ? "sí" : "no"}`,
      `auto mode: ${setAutoMode ? "sí" : "no"}`,
      `destino: ${claudeDir}`,
      "se hace un backup antes de escribir nada",
    ].join("\n"),
    "Resumen",
  );

  const proceed = await prompter.confirm({ message: "¿Proceder a escribir estos cambios?", initialValue: true });
  if (prompter.isCancel(proceed) || !proceed) {
    prompter.cancel("argos init cancelado — no se tocó nada.");
    return cancelledInitReport();
  }

  const report = runInit({
    language,
    installAgents,
    installHooks,
    installEngram,
    setAutoMode,
    takeoverNavoriVoice,
    force,
    engramRunner: options.engramRunner,
  });
  prompter.outro(report.summary);
  return report;
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Install the Argos engine into the global Claude Code home.",
  },
  args: {
    language: {
      type: "enum",
      options: ["es", "en"],
      default: "es",
      description: "Idioma del motor (global.json).",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Fuerza modo no interactivo aunque haya una TTY real (defaults + flags, sin wizard).",
    },
    force: {
      type: "boolean",
      default: false,
      description:
        "Sobrescribe con la versión del motor los archivos ajenos (sin marker argos) en agents/skills/output-styles/hooks. No toca prosa ajena de CLAUDE.md ni entradas ajenas de settings.json.",
    },
  },
  async run({ args }) {
    const report = await runInitInteractive({
      language: args.language as "es" | "en",
      yes: Boolean(args.yes),
      force: Boolean(args.force),
    });

    const colorize = (status: InitRowStatus): string => {
      const padded = status.padEnd(18);
      switch (status) {
        case "skipped-foreign":
          return pc.yellow(padded);
        case "overwritten-foreign":
          return pc.magenta(padded);
        case "created":
          return pc.green(padded);
        case "updated":
          return pc.cyan(padded);
        case "error":
          return pc.red(padded);
        default:
          return pc.dim(padded);
      }
    };
    for (const row of report.rows) {
      const suffix = row.detail ? ` (${row.detail})` : "";
      console.log(`${colorize(row.status)} ${row.path}${suffix}`);
    }
    console.log("");
    console.log(report.summary);
    if (report.backupPath) console.log(`backup en ${report.backupPath}`);

    process.exit(report.exitCode);
  },
});
