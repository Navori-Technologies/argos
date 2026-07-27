import { defineCommand } from "citty";
import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import pc from "picocolors";
import { listSkillFiles, listSkillIds, MANAGED_BLOCK_IDS, resolveAssetsDir } from "../lib/assets.js";
import { writeFileAtomic } from "../lib/atomic-write.js";
import { createBackup } from "../lib/backup.js";
import { listBlocks, removeBlock } from "../lib/markers.js";
import { hasArgosFileMarker, hasArgosShellFileMarker } from "../lib/managed-files.js";
import { resolveArgosHome, resolveClaudeDir } from "../lib/paths.js";
import { isInteractive, clackPrompter, type Prompter } from "../lib/prompter.js";
import {
  removeAllArgosHooksFromSettings,
  removeDefaultModeIfAuto,
  removeOutputStyleIfArgos,
} from "../lib/settings-merge.js";

/**
 * Uninstaller for `argos init`: the mirror image of `runInit` (see
 * commands/init.ts). Removes only what Argos itself owns — a managed
 * CLAUDE.md block, a file carrying the `argos:file`/shell marker, or a
 * settings.json hook entry pointing at an Argos script — and leaves every
 * foreign file, block, and entry byte-identical.
 *
 * Scope: this command only touches `~/.claude` (via `resolveClaudeDir()`)
 * and, with `--purge`, `~/.argos` (via `resolveArgosHome()`) — the global
 * Argos engine and its registry. Repo-side artifacts are intentionally out
 * of scope and are NEVER touched here: a repo's own `argos.config.json` and
 * the "ficha" managed block `argos adopt` writes into that repo's own
 * `CLAUDE.md` both survive `remove` untouched, including `remove --purge`.
 * (See the final "scope" row every report ends with.)
 */

export type RemoveRowStatus = "removed" | "would-remove" | "skipped-foreign" | "warning" | "info" | "error";

export type RemoveRowCategory =
  | "claude-md-block"
  | "agents-file"
  | "skills-file"
  | "output-styles-file"
  | "hooks-file"
  | "settings-entries"
  | "argos-home"
  | "scope-note";

export interface RemoveRow {
  path: string;
  category: RemoveRowCategory;
  status: RemoveRowStatus;
  detail?: string;
}

export interface RemoveOptions {
  /** Actually perform the removal. Default false = dry-run preview, touches nothing on disk. */
  apply?: boolean;
  /** Also remove ~/.argos data (registry, global.json, backups). Backups are removed LAST. */
  purge?: boolean;
}

export interface RemoveReport {
  rows: RemoveRow[];
  summary: string;
  exitCode: 0 | 1;
  backupPath?: string;
  /** Non-fatal warnings surfaced alongside the report, e.g. the --purge/backups tradeoff. */
  warnings: string[];
}

const STATUS_COUNT_ORDER: RemoveRowStatus[] = [
  "removed",
  "would-remove",
  "skipped-foreign",
  "info",
  "warning",
  "error",
];

function summarize(rows: RemoveRow[], apply: boolean): string {
  const counts: Record<RemoveRowStatus, number> = {
    removed: 0,
    "would-remove": 0,
    "skipped-foreign": 0,
    info: 0,
    warning: 0,
    error: 0,
  };
  for (const row of rows) counts[row.status]++;

  const parts = STATUS_COUNT_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  const verb = apply ? "argos remove" : "argos remove (preview — nada se tocó)";
  return parts.length === 0 ? `${verb}: nada que hacer.` : `${verb}: ${parts.join(", ")}.`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Strip every present managed block from CLAUDE.md; delete the file entirely if it becomes empty. */
function processClaudeMd(claudeDir: string, apply: boolean, rows: RemoveRow[]): void {
  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) return;

  let claudeMd: string;
  try {
    claudeMd = readFileSync(claudeMdPath, "utf-8");
  } catch (err) {
    rows.push({ path: "CLAUDE.md", category: "claude-md-block", status: "error", detail: errorMessage(err) });
    return;
  }

  let next = claudeMd;
  const removedIds: string[] = [];
  for (const id of MANAGED_BLOCK_IDS) {
    const hadBlock = listBlocks(next).some((b) => b.id === id);
    if (!hadBlock) continue;
    const beforeThisId = next;
    // removeBlock only strips the first occurrence — loop to self-heal any
    // crash-residue duplicates left by injectBlock (see lib/markers.ts).
    // Progress-guarded: a dangling open marker with no matching close (see
    // lib/markers.ts's findBlock/listDanglingBlockIds) makes removeBlock a
    // no-op — its output equals its input — which would otherwise spin this
    // loop forever since listBlocks still reports the id as present. Break
    // and surface it as a warning instead of hanging.
    while (listBlocks(next).some((b) => b.id === id)) {
      const before = next;
      next = removeBlock(next, id);
      if (next === before) {
        rows.push({
          path: "CLAUDE.md",
          category: "claude-md-block",
          status: "warning",
          detail: "marker argos huérfano sin cierre en CLAUDE.md — remuévelo a mano",
        });
        break;
      }
    }
    if (next !== beforeThisId) removedIds.push(id);
  }

  if (removedIds.length === 0) return;
  for (const id of removedIds) {
    rows.push({ path: `CLAUDE.md#${id}`, category: "claude-md-block", status: apply ? "removed" : "would-remove" });
  }

  if (!apply) return;

  try {
    if (next.trim().length === 0) {
      rmSync(claudeMdPath, { force: true });
    } else {
      writeFileAtomic(claudeMdPath, next);
    }
  } catch (err) {
    rows.push({ path: "CLAUDE.md", category: "claude-md-block", status: "error", detail: errorMessage(err) });
  }
}

function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** Remove now-empty directories bottom-up under `dir`, leaving any dir that still holds foreign content. */
function removeEmptyDirsUnder(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirsUnder(join(dir, entry.name));
  }
  const remaining = existsSync(dir) ? readdirSync(dir) : [];
  if (remaining.length === 0) {
    try {
      rmdirSync(dir);
    } catch {
      // Best-effort cleanup — a leftover empty dir is cosmetic, not an error.
    }
  }
}

/**
 * Remove every Argos-owned file (carrying the ownership marker) under
 * `claudeDir/<topDir>`, recursively — skills live in subdirectories, hence
 * the recursive walk. Foreign files (no marker) are reported
 * "skipped-foreign" and left byte-identical.
 */
function processManagedDir(
  claudeDir: string,
  topDir: "agents" | "output-styles" | "hooks",
  category: RemoveRowCategory,
  hasMarker: (content: string) => boolean,
  apply: boolean,
  rows: RemoveRow[],
): void {
  const dirPath = join(claudeDir, topDir);
  const files = walkFiles(dirPath);
  for (const file of files) {
    const relPath = relative(claudeDir, file);
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch (err) {
      rows.push({ path: relPath, category, status: "error", detail: errorMessage(err) });
      continue;
    }

    if (!hasMarker(content)) {
      rows.push({ path: relPath, category, status: "skipped-foreign" });
      continue;
    }

    if (!apply) {
      rows.push({ path: relPath, category, status: "would-remove" });
      continue;
    }

    try {
      rmSync(file, { force: true });
      rows.push({ path: relPath, category, status: "removed" });
    } catch (err) {
      rows.push({ path: relPath, category, status: "error", detail: errorMessage(err) });
    }
  }

  if (apply) removeEmptyDirsUnder(dirPath);
}

/**
 * Remove Argos-owned skill directories under `claudeDir/skills/`.
 *
 * Unlike `processManagedDir` (per-file marker check), ownership here is
 * decided PER SKILL DIRECTORY: the skill's `SKILL.md` `argos:file` marker is
 * the sentinel (mirrors the install policy in commands/init.ts). Supporting
 * files (`references/*.md`, `phases/*.md`, etc.) never carry a marker of
 * their own, so a per-file marker check would wrongly treat every one of
 * them as foreign.
 * - `SKILL.md` missing, or present without the marker → the whole directory
 *   is foreign (or not argos-installed at all); every file under it is left
 *   untouched, reported "skipped-foreign".
 * - `SKILL.md` present with the marker → argos-owned. Only the files the
 *   CURRENTLY shipped asset manifest lists for that skill id
 *   (`listSkillFiles`) are removed; anything else in the directory — a
 *   user-added extra file, or every file if this CLI version no longer
 *   ships the skill at all — is left in place.
 */
function processSkillsDir(claudeDir: string, apply: boolean, rows: RemoveRow[]): void {
  const skillsRoot = join(claudeDir, "skills");
  if (!existsSync(skillsRoot)) return;

  const assetsDir = resolveAssetsDir();
  const shippedSkillIds = new Set(listSkillIds(assetsDir));

  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue; // skills/ only ever holds skill subdirectories
    const skillId = entry.name;
    const skillDir = join(skillsRoot, skillId);
    const skillMdPath = join(skillDir, "SKILL.md");

    let skillMdContent: string | null = null;
    if (existsSync(skillMdPath)) {
      try {
        skillMdContent = readFileSync(skillMdPath, "utf-8");
      } catch (err) {
        rows.push({
          path: relative(claudeDir, skillMdPath),
          category: "skills-file",
          status: "error",
          detail: errorMessage(err),
        });
        continue;
      }
    }

    const isArgosOwned = skillMdContent !== null && hasArgosFileMarker(skillMdContent);
    const manifest =
      isArgosOwned && shippedSkillIds.has(skillId) ? new Set(listSkillFiles(assetsDir, skillId)) : new Set<string>();

    for (const file of walkFiles(skillDir)) {
      const relToClaudeDir = relative(claudeDir, file);

      if (!isArgosOwned || !manifest.has(relative(skillDir, file).split(sep).join("/"))) {
        rows.push({ path: relToClaudeDir, category: "skills-file", status: "skipped-foreign" });
        continue;
      }

      if (!apply) {
        rows.push({ path: relToClaudeDir, category: "skills-file", status: "would-remove" });
        continue;
      }

      try {
        rmSync(file, { force: true });
        rows.push({ path: relToClaudeDir, category: "skills-file", status: "removed" });
      } catch (err) {
        rows.push({ path: relToClaudeDir, category: "skills-file", status: "error", detail: errorMessage(err) });
      }
    }
  }

  if (apply) removeEmptyDirsUnder(skillsRoot);
}

const PURGE_FILES = ["global.json", "workspaces.json"] as const;

function processPurge(apply: boolean, rows: RemoveRow[], warnings: string[]): void {
  const argosHome = resolveArgosHome();

  for (const name of PURGE_FILES) {
    const p = join(argosHome, name);
    if (!existsSync(p)) continue;
    const label = join("~", ".argos", name);
    if (!apply) {
      rows.push({ path: label, category: "argos-home", status: "would-remove" });
      continue;
    }
    try {
      rmSync(p, { force: true });
      rows.push({ path: label, category: "argos-home", status: "removed" });
    } catch (err) {
      rows.push({ path: label, category: "argos-home", status: "error", detail: errorMessage(err) });
    }
  }

  // Backups LAST, and always explicitly flagged: they're the safety net for
  // every previous (and this very) destructive operation, so purging them
  // removes the one thing that could otherwise undo a mistake.
  const backupsDir = join(argosHome, "backups");
  const backupsLabel = join("~", ".argos", "backups");
  if (existsSync(backupsDir)) {
    warnings.push(
      "--purge elimina ~/.argos/backups — se pierde la red de seguridad de esta y de toda operación anterior.",
    );
    if (!apply) {
      rows.push({ path: backupsLabel, category: "argos-home", status: "would-remove" });
    } else {
      try {
        rmSync(backupsDir, { recursive: true, force: true });
        rows.push({ path: backupsLabel, category: "argos-home", status: "removed" });
      } catch (err) {
        rows.push({ path: backupsLabel, category: "argos-home", status: "error", detail: errorMessage(err) });
      }
    }
  }
}

/**
 * Core, testable implementation of `argos remove`: uninstalls everything
 * `runInit` (commands/init.ts) installs into `resolveClaudeDir()`. Pure
 * function of the filesystem — no process.exit, no console output.
 *
 * Preview by default (`apply: false`): computes the full report without
 * writing anything. `apply: true` performs the removal, backing up
 * everything affected first (same `createBackup` call `runInit` makes,
 * before any mutation). `purge: true` additionally removes `~/.argos` data
 * (kept by default) — backups are removed last and always warned about.
 */
export function runRemove(options: RemoveOptions = {}): RemoveReport {
  const apply = options.apply ?? false;
  const purge = options.purge ?? false;
  const claudeDir = resolveClaudeDir();
  const rows: RemoveRow[] = [];
  const warnings: string[] = [];

  let backupPath: string | undefined;
  if (apply) {
    try {
      backupPath = createBackup(claudeDir, [
        "CLAUDE.md",
        "agents",
        "skills",
        "output-styles",
        "hooks",
        "settings.json",
      ]);
    } catch (err) {
      const detail = errorMessage(err);
      rows.push({ path: "backup", category: "argos-home", status: "error", detail });
      return { rows, summary: `backup falló — no se tocó nada (${detail}).`, exitCode: 1, warnings };
    }
  }

  processClaudeMd(claudeDir, apply, rows);

  processManagedDir(claudeDir, "agents", "agents-file", hasArgosFileMarker, apply, rows);
  processSkillsDir(claudeDir, apply, rows);
  processManagedDir(claudeDir, "output-styles", "output-styles-file", hasArgosFileMarker, apply, rows);
  processManagedDir(claudeDir, "hooks", "hooks-file", hasArgosShellFileMarker, apply, rows);

  const settingsPath = join(claudeDir, "settings.json");
  const settingsResult = removeAllArgosHooksFromSettings(settingsPath, join(claudeDir, "hooks"), { dryRun: !apply });
  if (settingsResult.status === "error") {
    rows.push({ path: "settings.json", category: "settings-entries", status: "error", detail: settingsResult.detail });
  } else if (settingsResult.removedCount > 0) {
    const noun = settingsResult.removedCount === 1 ? "entry" : "entries";
    rows.push({
      path: "settings.json",
      category: "settings-entries",
      status: apply ? "removed" : "would-remove",
      detail: `${settingsResult.removedCount} hook ${noun}`,
    });
  }

  // Voice activation (spec 0004): remove settings.json.outputStyle ONLY when
  // it's still exactly "Argos" — the value argos init wrote. Any other
  // voice (a foreign one init never touched, or the key simply absent) is
  // left byte-identical; this is `argos remove`'s own value to clean up
  // after, never the user's.
  const outputStyleResult = removeOutputStyleIfArgos(settingsPath, { dryRun: !apply });
  if (outputStyleResult.status === "error") {
    rows.push({
      path: "settings.json#outputStyle",
      category: "settings-entries",
      status: "error",
      detail: outputStyleResult.detail,
    });
  } else if (outputStyleResult.status === "removed") {
    rows.push({
      path: "settings.json#outputStyle",
      category: "settings-entries",
      status: apply ? "removed" : "would-remove",
    });
  }

  // Auto mode (spec 0005 R10): remove settings.json.permissions.defaultMode
  // ONLY when it's still exactly "auto" — the value argos init wrote. Any
  // other value (an operator's own choice, or the key simply absent) is left
  // byte-identical. Engram is deliberately NOT touched here at all (no-goal,
  // see spec 0005): the accumulated memory is the operator's, never `argos
  // remove`'s to uninstall or disable.
  const defaultModeResult = removeDefaultModeIfAuto(settingsPath, { dryRun: !apply });
  if (defaultModeResult.status === "error") {
    rows.push({
      path: "settings.json#defaultMode",
      category: "settings-entries",
      status: "error",
      detail: defaultModeResult.detail,
    });
  } else if (defaultModeResult.status === "removed") {
    rows.push({
      path: "settings.json#defaultMode",
      category: "settings-entries",
      status: apply ? "removed" : "would-remove",
    });
  }

  if (purge) processPurge(apply, rows, warnings);

  // Always-present closing note: repo-side artifacts (argos.config.json, the
  // ficha block in a repo's own CLAUDE.md) are out of scope for `remove` —
  // see the module doc comment above.
  rows.push({
    path: "scope",
    category: "scope-note",
    status: "info",
    detail: "los repos adoptados conservan su argos.config.json y ficha — este comando solo limpia ~/.claude y ~/.argos",
  });

  const exitCode: 0 | 1 = rows.some((r) => r.status === "error") ? 1 : 0;
  return { rows, summary: summarize(rows, apply), exitCode, backupPath, warnings };
}

export interface RemoveInteractiveOptions extends RemoveOptions {
  /** `--yes`: forces non-interactive behavior even under a real TTY. */
  yes?: boolean;
  /** Injectable for tests; defaults to the real `@clack/prompts`-backed prompter. */
  prompter?: Prompter;
}

/**
 * A cancelled confirmation's report: identical shape to a run that touched
 * nothing. `exitCode: 1` — a cancel is neither a successful write nor
 * silently indistinguishable from one by exit code alone (matches
 * `runWorkspaceLinkInteractive`'s convention for its own cancel paths).
 */
function cancelledRemoveReport(reason: string): RemoveReport {
  return {
    rows: [{ path: "cancel", category: "scope-note", status: "info", detail: reason }],
    summary: `argos remove: cancelado — no se tocó nada (${reason}).`,
    exitCode: 1,
    warnings: [],
  };
}

/**
 * Interactive layer over `runRemove` (spec 0004 F5 "argos remove"). A pure
 * additive wrapper — the core `runRemove` never changes behavior or
 * contract. Without a real TTY, with `--yes`, or for a plain preview
 * (`apply: false`, the default) this delegates to `runRemove(options)`
 * unchanged — no prompt library call is ever reached on those paths. With a
 * TTY AND `apply: true`, requires the operator to type the exact target
 * directory (`resolveClaudeDir()`) before proceeding; `purge: true` on top
 * of that requires a SECOND, separate confirmation mentioning backups.
 * Either confirmation failing/cancelling aborts with zero writes.
 */
export async function runRemoveInteractive(options: RemoveInteractiveOptions = {}): Promise<RemoveReport> {
  const apply = options.apply ?? false;
  const purge = options.purge ?? false;

  if (!isInteractive({ yes: options.yes }) || !apply) {
    return runRemove(options);
  }

  const prompter = options.prompter ?? clackPrompter;
  const claudeDir = resolveClaudeDir();

  const typed = await prompter.text({
    message: `Esto desinstala el motor Argos de ${claudeDir}. Escribí "${claudeDir}" para confirmar:`,
  });
  if (prompter.isCancel(typed) || typed !== claudeDir) {
    prompter.cancel("argos remove cancelado — no se tocó nada.");
    return cancelledRemoveReport("confirmación de directorio no coincide o fue cancelada");
  }

  if (purge) {
    const confirmPurge = await prompter.confirm({
      message:
        "--purge también borra ~/.argos/backups — se pierde la red de seguridad de esta y de toda operación anterior. ¿Confirmás?",
      initialValue: false,
    });
    if (prompter.isCancel(confirmPurge) || !confirmPurge) {
      prompter.cancel("argos remove cancelado — no se tocó nada.");
      return cancelledRemoveReport("--purge no confirmado");
    }
  }

  const report = runRemove(options);
  prompter.outro(report.summary);
  return report;
}

export const removeCommand = defineCommand({
  meta: {
    name: "remove",
    description: "Uninstall the Argos engine from the global Claude Code home (preview by default).",
  },
  args: {
    apply: {
      type: "boolean",
      default: false,
      description: "Actually perform the removal (default: dry-run preview, touches nothing).",
    },
    purge: {
      type: "boolean",
      default: false,
      description: "Also remove ~/.argos data (registry, global.json, backups). Irreversible.",
    },
    yes: {
      type: "boolean",
      default: false,
      description: "Fuerza modo no interactivo aunque haya una TTY real (salta las confirmaciones tipadas).",
    },
  },
  async run({ args }) {
    const report = await runRemoveInteractive({ apply: args.apply, purge: args.purge, yes: Boolean(args.yes) });

    const colorize = (status: RemoveRowStatus): string => {
      const padded = status.padEnd(18);
      switch (status) {
        case "skipped-foreign":
          return pc.yellow(padded);
        case "removed":
          return pc.cyan(padded);
        case "would-remove":
          return pc.dim(padded);
        case "warning":
          return pc.yellow(padded);
        case "info":
          return pc.dim(padded);
        case "error":
          return pc.red(padded);
        default:
          return padded;
      }
    };
    for (const row of report.rows) {
      const suffix = row.detail ? ` (${row.detail})` : "";
      console.log(`${colorize(row.status)} ${row.path}${suffix}`);
    }
    console.log("");
    console.log(report.summary);
    if (report.backupPath) console.log(`backup en ${report.backupPath}`);
    for (const warning of report.warnings) console.log(pc.yellow(`aviso: ${warning}`));

    process.exit(report.exitCode);
  },
});
