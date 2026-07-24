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
import { createBackup } from "../lib/backup.js";
import { injectBlock, listBlocks } from "../lib/markers.js";
import { type FileStatus, writeManagedFile } from "../lib/managed-files.js";
import { resolveArgosHome, resolveClaudeDir } from "../lib/paths.js";
import { readCliVersion } from "../lib/version.js";

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

  // Backup everything Argos is about to touch, before any write happens.
  let backupPath: string | undefined;
  try {
    backupPath = createBackup(claudeDir, ["CLAUDE.md", "agents", "skills", "output-styles"]);
  } catch (err) {
    rows.push({ path: "backup", status: "error", detail: errorMessage(err) });
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
    writeFileSync(claudeMdPath, claudeMd, "utf-8");
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
