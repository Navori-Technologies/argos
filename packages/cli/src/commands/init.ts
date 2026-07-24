import { defineCommand } from "citty";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import {
  listAgentIds,
  listSkillIds,
  MANAGED_BLOCK_IDS,
  readAsset,
  resolveAssetsDir,
} from "../lib/assets.js";
import { writeFileAtomic } from "../lib/atomic-write.js";
import { createBackup } from "../lib/backup.js";
import { injectBlock, listBlocks } from "../lib/markers.js";
import { type FileStatus, writeManagedFile, writeManagedShellFile } from "../lib/managed-files.js";
import { resolveArgosHome, resolveClaudeDir } from "../lib/paths.js";
import { type ArgosHookSpec, mergeHooksIntoSettings } from "../lib/settings-merge.js";
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
}

export interface InitReport {
  rows: InitRow[];
  summary: string;
  exitCode: 0 | 1;
  backupPath?: string;
}

const STATUS_COUNT_ORDER: InitRowStatus[] = ["created", "updated", "unchanged", "skipped-foreign", "error"];

function summarize(rows: InitRow[]): string {
  const counts: Record<InitRowStatus, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    "skipped-foreign": 0,
    error: 0,
  };
  for (const row of rows) counts[row.status]++;

  const parts = STATUS_COUNT_ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return `argos init: ${parts.join(", ")}.`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  // 1. CLAUDE.md — 5 managed blocks, in order.
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

  // 2. Full-file assets: output-style, agents, skills.
  const fullFiles: string[][] = [
    ["output-styles", "argos.md"],
    ...listAgentIds(assetsDir).map((id) => ["agents", `${id}.md`]),
    ...listSkillIds(assetsDir).map((id) => ["skills", id, "SKILL.md"]),
  ];
  for (const relPath of fullFiles) {
    const source = readAsset(assetsDir, ...relPath);
    const dest = join(claudeDir, ...relPath);
    try {
      const status = writeManagedFile(dest, source, version);
      rows.push({ path: join(...relPath), status });
    } catch (err) {
      rows.push({ path: join(...relPath), status: "error", detail: errorMessage(err) });
    }
  }

  // 2b. Global hooks: full-file shell assets, own shell-comment marker,
  // chmod +x. Same skipped-foreign policy as the full-file assets above.
  // Track which hooks actually landed on disk successfully — a hook whose
  // write threw must NEVER get a settings.json entry (see 2c below): a
  // dangling PreToolUse entry pointing at a script that isn't there hard-
  // blocks every subsequent Bash call.
  const hookWriteFailed = new Map<(typeof HOOK_IDS)[number], boolean>();
  for (const id of HOOK_IDS) {
    const relPath = ["hooks", `${id}.sh`];
    const source = readAsset(assetsDir, ...relPath);
    const dest = join(claudeDir, ...relPath);
    try {
      const status = writeManagedShellFile(dest, source, version);
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
  },
  run({ args }) {
    const report = runInit({ language: args.language as "es" | "en" });

    const colorize = (status: InitRowStatus): string => {
      const padded = status.padEnd(18);
      switch (status) {
        case "skipped-foreign":
          return pc.yellow(padded);
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
