import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { listBlocks } from "../lib/markers.js";
import { hasArgosFileMarker } from "../lib/managed-files.js";
import { hasNaviorConfig } from "../lib/navori-import.js";
import { resolveClaudeDir } from "../lib/paths.js";
import { readCliVersion } from "../lib/version.js";
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

function checkMotor(findings: DoctorFinding[]): void {
  const claudeDir = resolveClaudeDir();
  const currentVersion = readCliVersion();
  const assetsDir = resolveAssetsDir();

  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  const claudeMd = readFileSafe(claudeMdPath, findings, "CLAUDE.md");
  const blocks = listBlocks(claudeMd);

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
