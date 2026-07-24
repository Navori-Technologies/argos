import { defineCommand } from "citty";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { z } from "zod";
import { ArgosConfigSchema, hasConfig } from "../lib/config.js";
import {
  detectFramework,
  detectLibs,
  detectPackageManager,
  readPackageJson,
} from "../lib/detect.js";
import { buildFichaContent, FICHA_BLOCK_ID } from "../lib/ficha.js";
import { getRemoteOriginUrl, isGitRepo, parseIdentityFromRemote } from "../lib/git.js";
import { listAgentIds, listSkillIds, MANAGED_BLOCK_IDS, resolveAssetsDir } from "../lib/assets.js";
import { listBlocks, listDanglingBlockIds } from "../lib/markers.js";
import { hasArgosFileMarker, hasArgosShellFileMarker } from "../lib/managed-files.js";
import { hasNaviorConfig } from "../lib/navori-import.js";
import { resolveClaudeDir } from "../lib/paths.js";
import { isArgosHookCommand } from "../lib/settings-merge.js";
import { readCliVersion } from "../lib/version.js";
import { loadRegistry, resolveWorkspaceForRepo } from "../lib/workspaces.js";
import { describeZodError } from "../lib/zod-messages.js";
import { NO_GATE_PLACEHOLDER } from "./adopt.js";

export type DoctorLevel = "info" | "warning" | "error";

export interface DoctorFinding {
  level: DoctorLevel;
  message: string;
}

export interface DoctorOptions {
  cwd: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  exitCode: 0 | 1;
}

/**
 * Read a text file, guarding against fs failures (e.g. EACCES) that would
 * otherwise crash doctor's read-only audit. On failure, pushes an error
 * finding and falls back to `""` so the rest of the audit can still run.
 */
function readFileSafe(path: string, findings: DoctorFinding[], label: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    findings.push({
      level: "error",
      message: `No se pudo leer ${label} (${err instanceof Error ? err.message : String(err)}).`,
    });
    return "";
  }
}

/** Compare two semver-ish `x.y.z` strings. Returns <0, 0, or >0 like Array.sort comparators. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Ids (basenames under `<claudeDir>/hooks/`) of the 2 global hooks `argos
 * init` installs (see spec 0003 "Hooks globales parametrizados"). Mirrors
 * `HOOK_IDS` in commands/init.ts — kept as a local duplicate here since
 * doctor only reads the filesystem/version drift, it never installs, and the
 * two commands are intentionally not allowed to share private constants.
 */
const HOOK_IDS = ["argos-guard-destructive", "argos-quality-gate"] as const;

/** Extract the version stamped by a shell-comment `# argos:file v="<version>"` marker (see lib/managed-files.ts). */
function extractShellMarkerVersion(content: string): string | null {
  return /^# argos:file v="([^"]*)"/m.exec(content)?.[1] ?? null;
}

/** Extract the script path from an Argos hook command string (`bash "<scriptPath>"`, see lib/settings-merge.ts). */
function extractHookScriptPath(command: string): string | null {
  return /^bash "(.+)"$/.exec(command)?.[1] ?? null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Hooks (F2, motor scope): presence, ownership, and version drift of the 2
 * global hook scripts under `<claudeDir>/hooks/`. Same bidirectional-version
 * convention as the CLAUDE.md managed-blocks check in `checkMotor`.
 */
function checkHookScripts(findings: DoctorFinding[], claudeDir: string, currentVersion: string): void {
  for (const id of HOOK_IDS) {
    const hookPath = join(claudeDir, "hooks", `${id}.sh`);
    if (!existsSync(hookPath)) {
      findings.push({ level: "warning", message: `Falta el hook hooks/${id}.sh. Corre argos init.` });
      continue;
    }

    const beforeCount = findings.length;
    const content = readFileSafe(hookPath, findings, `hooks/${id}.sh`);
    if (findings.length > beforeCount) continue; // read error already reported by readFileSafe

    if (!hasArgosShellFileMarker(content)) {
      findings.push({ level: "info", message: `hooks/${id}.sh existe pero es ajeno (sin marker argos:file).` });
      continue;
    }

    const hookVersion = extractShellMarkerVersion(content);
    if (!hookVersion) continue;
    const cmp = compareVersions(hookVersion, currentVersion);
    if (cmp < 0) {
      findings.push({
        level: "warning",
        message: `hooks/${id}.sh está desactualizado (v${hookVersion} < v${currentVersion}). Corre argos init.`,
      });
    } else if (cmp > 0) {
      findings.push({
        level: "warning",
        message: `hooks/${id}.sh es más nuevo que el binario (v${hookVersion} > v${currentVersion}) — el binario es más viejo que el motor instalado — actualiza el paquete (npm i -g).`,
      });
    }
  }
}

/**
 * Hooks (F2, motor scope): `settings.json` PreToolUse entries — missing,
 * orphaned (the entry's script file is gone), or the file itself unreadable
 * as valid JSON. Guarded reads throughout: never throws, always degrades to
 * an error finding so the rest of doctor's audit still runs.
 */
function checkHookSettings(findings: DoctorFinding[], claudeDir: string): void {
  const settingsPath = join(claudeDir, "settings.json");
  if (!existsSync(settingsPath)) {
    for (const id of HOOK_IDS) {
      findings.push({ level: "warning", message: `Falta la entrada del hook ${id} en settings.json. Corre argos init.` });
    }
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf-8");
  } catch (err) {
    findings.push({
      level: "error",
      message: `No se pudo leer settings.json (${err instanceof Error ? err.message : String(err)}).`,
    });
    return;
  }

  let settings: unknown;
  try {
    settings = raw.trim().length === 0 ? {} : JSON.parse(raw);
  } catch (err) {
    findings.push({
      level: "error",
      message: `settings.json tiene JSON inválido (${err instanceof Error ? err.message : String(err)}).`,
    });
    return;
  }

  const foundScriptPaths = new Set<string>();
  const hooksRoot = isPlainObject(settings) ? settings.hooks : undefined;
  const preToolUse = isPlainObject(hooksRoot) ? hooksRoot.PreToolUse : undefined;
  if (Array.isArray(preToolUse)) {
    for (const bucket of preToolUse) {
      if (!isPlainObject(bucket) || !Array.isArray(bucket.hooks)) continue;
      for (const hook of bucket.hooks) {
        if (!isPlainObject(hook) || !isArgosHookCommand(hook.command)) continue;
        const scriptPath = extractHookScriptPath(hook.command);
        if (!scriptPath) continue;
        foundScriptPaths.add(scriptPath);
        // `existsSync` alone is true for directories too — a settings.json
        // entry pointing at a directory (e.g. a failed write that left a
        // stray directory in the script's place) would otherwise read as
        // "present" here and slip past the orphan check.
        let isRealFile = false;
        try {
          isRealFile = existsSync(scriptPath) && statSync(scriptPath).isFile();
        } catch {
          isRealFile = false;
        }
        if (!isRealFile) {
          findings.push({
            level: "warning",
            message: `settings.json referencia el hook huérfano ${scriptPath} (el script ya no existe). Corre argos init.`,
          });
        }
      }
    }
  }

  for (const id of HOOK_IDS) {
    const expectedPath = join(claudeDir, "hooks", `${id}.sh`);
    if (!foundScriptPaths.has(expectedPath)) {
      findings.push({ level: "warning", message: `Falta la entrada del hook ${id} en settings.json. Corre argos init.` });
    }
  }
}

/**
 * Workspaces (F2, motor scope): `~/.argos/workspaces.json` registry entries
 * whose repo path no longer exists on disk (moved/deleted repo). Guarded
 * against a corrupt registry file — never throws.
 */
function checkWorkspaceRegistryHealth(findings: DoctorFinding[]): void {
  let registry: ReturnType<typeof loadRegistry>;
  try {
    registry = loadRegistry();
  } catch (err) {
    findings.push({
      level: "error",
      message: `No se pudo leer workspaces.json (${err instanceof Error ? err.message : String(err)}).`,
    });
    return;
  }

  const stale: string[] = [];
  for (const [wsName, ws] of Object.entries(registry)) {
    for (const repo of ws.repos) {
      if (!existsSync(repo.path)) stale.push(`${wsName}/${repo.name} (${repo.path})`);
    }
  }
  if (stale.length > 0) {
    findings.push({
      level: "warning",
      message: `Hay repos registrados en workspaces con paths inexistentes: ${stale.join(", ")}. Corre argos workspace link o editá el registro a mano.`,
    });
  }
}

/**
 * Flag dangling/unclosed managed-block markers (an open marker with no
 * matching close — crash residue or hand-edited corruption) as a warning.
 * Reuses `listDanglingBlockIds` (lib/markers.ts) — the same scanning logic
 * `remove`'s progress-guard relies on to avoid spinning forever on the same
 * corruption (see commands/remove.ts's processClaudeMd).
 */
function checkDanglingMarkers(findings: DoctorFinding[], content: string, label: string): void {
  for (const id of listDanglingBlockIds(content)) {
    findings.push({
      level: "warning",
      message: `Marker argos huérfano sin cierre en ${label} (bloque "${id}"). Corre argos remove para limpiarlo, o editá el archivo a mano.`,
    });
  }
}

function checkMotor(findings: DoctorFinding[]): void {
  const claudeDir = resolveClaudeDir();
  const currentVersion = readCliVersion();
  const assetsDir = resolveAssetsDir();

  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  const claudeMd = readFileSafe(claudeMdPath, findings, "CLAUDE.md");
  const blocks = listBlocks(claudeMd);

  checkDanglingMarkers(findings, claudeMd, "CLAUDE.md");

  for (const id of MANAGED_BLOCK_IDS) {
    const matching = blocks.filter((b) => b.id === id);
    if (matching.length > 1) {
      findings.push({
        level: "warning",
        message: `El bloque "${id}" está duplicado (${matching.length} veces) en CLAUDE.md. Corre argos init para sanearlo.`,
      });
    }

    const block = matching[0];
    if (!block) {
      findings.push({ level: "error", message: `Falta el bloque managed "${id}" en CLAUDE.md. Corre argos init.` });
      continue;
    }
    if (block.version) {
      const cmp = compareVersions(block.version, currentVersion);
      if (cmp < 0) {
        findings.push({
          level: "warning",
          message: `El bloque "${id}" está desactualizado (v${block.version} < v${currentVersion}). Corre argos init.`,
        });
      } else if (cmp > 0) {
        findings.push({
          level: "warning",
          message: `El bloque "${id}" es más nuevo que el binario (v${block.version} > v${currentVersion}) — el binario es más viejo que el motor instalado — actualiza el paquete (npm i -g).`,
        });
      }
    }
  }

  const fullFiles: string[][] = [
    ["output-styles", "argos.md"],
    ...listAgentIds(assetsDir).map((id) => ["agents", `${id}.md`]),
    ...listSkillIds(assetsDir).map((id) => ["skills", id, "SKILL.md"]),
  ];
  for (const relPath of fullFiles) {
    const dest = join(claudeDir, ...relPath);
    const label = join(...relPath);
    if (!existsSync(dest)) {
      findings.push({ level: "error", message: `Falta ${label} en el motor. Corre argos init.` });
      continue;
    }
    const content = readFileSync(dest, "utf-8");
    if (!hasArgosFileMarker(content)) {
      findings.push({ level: "info", message: `${label} existe pero es ajeno (sin marker argos:file).` });
    }
  }

  checkHookScripts(findings, claudeDir, currentVersion);
  checkHookSettings(findings, claudeDir);
  checkWorkspaceRegistryHealth(findings);
}

function checkRepo(cwd: string, findings: DoctorFinding[]): void {
  if (!hasConfig(cwd)) return;

  const configPath = join(cwd, "argos.config.json");
  let config: z.infer<typeof ArgosConfigSchema> | undefined;
  try {
    const raw: unknown = JSON.parse(readFileSync(configPath, "utf-8"));
    config = ArgosConfigSchema.parse(raw);
  } catch (error) {
    for (const message of describeZodError(error)) {
      findings.push({ level: "error", message: `argos.config.json inválido — ${message}` });
    }
    return;
  }

  if (hasNaviorConfig(cwd)) {
    findings.push({
      level: "info",
      message: "navori.config.json coexiste con argos.config.json (migración en curso).",
    });
  }

  if (config.qualityGate.fast === NO_GATE_PLACEHOLDER) {
    findings.push({
      level: "warning",
      message: "quality gate placeholder — configura scripts y corre argos adopt --refresh.",
    });
  }

  // Ficha drift: does ./CLAUDE.md's ficha block match what adopt would write today?
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const claudeMd = readFileSafe(claudeMdPath, findings, "./CLAUDE.md");
  checkDanglingMarkers(findings, claudeMd, "./CLAUDE.md");
  const fichaBlocks = listBlocks(claudeMd).filter((b) => b.id === FICHA_BLOCK_ID);
  if (fichaBlocks.length > 1) {
    findings.push({
      level: "warning",
      message: `La ficha está duplicada (${fichaBlocks.length} veces) en ./CLAUDE.md. Corre argos adopt --refresh para sanearla.`,
    });
  }
  const fichaBlock = fichaBlocks[0];
  if (!fichaBlock) {
    findings.push({ level: "warning", message: "Falta la ficha en ./CLAUDE.md. Corre argos adopt --refresh." });
  } else {
    const expectedFicha = buildFichaContent(config);
    if (!claudeMd.includes(expectedFicha)) {
      findings.push({ level: "warning", message: "La ficha de ./CLAUDE.md quedó vieja. Corre argos adopt --refresh." });
    }
  }

  // Stack drift: new relevant libs in package.json not yet recorded.
  const pkg = readPackageJson(cwd);
  if (pkg) {
    const recordedLibs = new Set(config.stack?.libs ?? []);
    const freshLibs = detectLibs(pkg);
    const newLibs = freshLibs.filter((lib) => !recordedLibs.has(lib));
    if (newLibs.length > 0) {
      findings.push({
        level: "warning",
        message: `Nuevas libs detectadas sin registrar (${newLibs.join(", ")}). Corre argos adopt --refresh.`,
      });
    }

    const freshFramework = detectFramework(pkg);
    if (freshFramework && config.stack?.framework && freshFramework !== config.stack.framework) {
      findings.push({
        level: "warning",
        message: `El framework detectado (${freshFramework}) difiere del registrado (${config.stack.framework}). Corre argos adopt --refresh.`,
      });
    }

    const freshPackageManager = detectPackageManager(cwd);
    if (
      freshPackageManager &&
      config.stack?.packageManager &&
      freshPackageManager !== config.stack.packageManager
    ) {
      findings.push({
        level: "warning",
        message: `El package manager detectado (${freshPackageManager}) difiere del registrado (${config.stack.packageManager}). Corre argos adopt --refresh.`,
      });
    }
  }

  // Identity drift: current git remote vs the identity recorded in config.
  const remoteUrl = getRemoteOriginUrl(cwd);
  const freshIdentity = remoteUrl ? (parseIdentityFromRemote(remoteUrl) ?? undefined) : undefined;
  if (freshIdentity && config.identity && freshIdentity !== config.identity) {
    findings.push({
      level: "warning",
      message: `La identidad detectada (${freshIdentity}) difiere de la registrada (${config.identity}). Corre argos adopt --refresh.`,
    });
  }

  // Workspace linkage (F2): repo not registered, registered under a stale
  // path, or config.workspace pointing at a name absent from the registry.
  let registry: ReturnType<typeof loadRegistry>;
  try {
    registry = loadRegistry();
  } catch (err) {
    findings.push({
      level: "error",
      message: `No se pudo leer workspaces.json (${err instanceof Error ? err.message : String(err)}).`,
    });
    return;
  }
  const resolution = resolveWorkspaceForRepo(registry, {
    configWorkspace: config.workspace,
    remoteUrl,
    repoPath: cwd,
  });

  if (resolution.kind === "unresolved") {
    findings.push({
      level: "info",
      message: "El repo no está vinculado a ningún workspace. Corre argos workspace link.",
    });
  } else if (resolution.kind === "resolved") {
    const workspace = registry[resolution.name];
    if (!workspace) {
      findings.push({
        level: "warning",
        message: `argos.config.json referencia el workspace '${resolution.name}', que no existe en el registro. Corre argos workspace link ${resolution.name}.`,
      });
    } else {
      const entry = workspace.repos.find((r) => r.name === config.name);
      if (!entry) {
        findings.push({
          level: "info",
          message: "El repo no está vinculado a ningún workspace. Corre argos workspace link.",
        });
      } else {
        let realCwd: string | undefined;
        try {
          realCwd = realpathSync(resolve(cwd));
        } catch {
          realCwd = undefined;
        }
        if (realCwd && entry.path !== realCwd) {
          findings.push({
            level: "warning",
            message: `El repo está registrado en el workspace '${resolution.name}' con un path distinto (${entry.path} vs ${realCwd}). Corre argos workspace link para actualizarlo.`,
          });
        }
      }
    }
  }
}

/**
 * Core, testable implementation of `argos doctor`: a read-only audit of the
 * global engine and (when cwd is a git repo) the repo's argos.config.json +
 * ficha. Never writes anything.
 */
export function runDoctor(options: DoctorOptions): DoctorReport {
  const findings: DoctorFinding[] = [];

  checkMotor(findings);
  if (isGitRepo(options.cwd)) {
    checkRepo(options.cwd, findings);
  }

  const exitCode = findings.some((f) => f.level !== "info") ? 1 : 0;
  return { findings, exitCode };
}

export const doctorCommand = defineCommand({
  meta: {
    name: "doctor",
    description: "Report drift between the engine, the repo config, and its ficha.",
  },
  run() {
    const report = runDoctor({ cwd: process.cwd() });

    if (report.findings.length === 0) {
      console.log("Todo al día.");
      process.exit(0);
    }

    for (const finding of report.findings) {
      const padded = finding.level.padEnd(10);
      const label = finding.level === "error" ? pc.red(padded) : finding.level === "warning" ? pc.yellow(padded) : pc.dim(padded);
      console.log(`${label} ${finding.message}`);
    }

    process.exit(report.exitCode);
  },
});
