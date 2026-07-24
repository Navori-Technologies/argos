import { defineCommand } from "citty";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import pc from "picocolors";
import { writeFileAtomic } from "../lib/atomic-write.js";
import {
  CONFIG_FILENAME,
  type ArgosConfig,
  type ArgosConfigInput,
  hasConfig,
  readConfig,
  writeConfig,
} from "../lib/config.js";
import {
  buildQualityGateFast,
  detectFramework,
  detectLibs,
  detectMappedSkills,
  detectPackageManager,
  MOTOR_SKILLS,
  readPackageJson,
} from "../lib/detect.js";
import { createBackup } from "../lib/backup.js";
import { buildFichaContent, FICHA_BLOCK_ID } from "../lib/ficha.js";
import { checkGitRepo, getRemoteOriginUrl, parseIdentityFromRemote } from "../lib/git.js";
import { injectBlock, listBlocks } from "../lib/markers.js";
import type { FileStatus } from "../lib/managed-files.js";
import { readNaviorConfig } from "../lib/navori-import.js";
import { readCliVersion } from "../lib/version.js";
import { linkRepo, loadRegistry, resolveWorkspaceForRepo } from "../lib/workspaces.js";

/** Written when no lint/typecheck/test script exists to build a real gate from. */
export const NO_GATE_PLACEHOLDER =
  "echo 'argos: no lint/typecheck/test scripts detected — set qualityGate.fast manually'";

export interface AdoptRow {
  field: string;
  value: string;
  source: "imported" | "preserved" | "detected" | "default" | "info" | "warning" | "error";
}

export interface AdoptOptions {
  cwd: string;
  refresh?: boolean;
}

export interface AdoptReport {
  rows: AdoptRow[];
  configPath?: string;
  fichaStatus?: FileStatus;
  backupPath?: string;
  exitCode: 0 | 1;
  error?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Core, testable implementation of `argos adopt [--refresh]`: writes
 * `argos.config.json` (detecting stack/quality-gate/identity, importing
 * `navori.config.json` when present) and injects the `ficha` managed block
 * into `./CLAUDE.md`. Pure function of the filesystem — no process.exit.
 */
export function runAdopt(options: AdoptOptions): AdoptReport {
  const { cwd, refresh = false } = options;

  const gitCheck = checkGitRepo(cwd);
  if (!gitCheck.isRepo) {
    return {
      rows: [],
      exitCode: 1,
      error: gitCheck.gitMissing
        ? "No se encontró el binario git — instalá git y volvé a intentar."
        : "argos adopt debe ejecutarse dentro de un repositorio git.",
    };
  }

  const configExists = hasConfig(cwd);
  if (configExists && !refresh) {
    return {
      rows: [],
      exitCode: 1,
      error: "argos.config.json ya existe. Corre `argos adopt --refresh` para regenerarlo.",
    };
  }

  const rows: AdoptRow[] = [];

  let existing: ArgosConfig | undefined;
  if (configExists) {
    try {
      existing = readConfig(cwd);
    } catch {
      rows.push({
        field: "argos.config.json",
        value: "config existente inválido, se regenera desde cero",
        source: "warning",
      });
    }
  }

  const naviorResult = readNaviorConfig(cwd);
  const navori = naviorResult.kind === "imported" ? naviorResult.data : undefined;
  if (naviorResult.kind === "imported") {
    rows.push({ field: "import", value: "importado de navori.config.json", source: "imported" });
  } else if (naviorResult.kind === "unreadable") {
    rows.push({
      field: "navori.config.json",
      value: "navori.config.json presente pero ilegible — ignorado",
      source: "warning",
    });
  }

  const pkg = readPackageJson(cwd);

  // name: existing > navori import > package.json > repo dirname
  let name: string;
  let nameSource: AdoptRow["source"];
  if (existing?.name) {
    name = existing.name;
    nameSource = "preserved";
  } else if (navori?.name) {
    name = navori.name;
    nameSource = "imported";
  } else if (pkg?.name) {
    name = pkg.name;
    nameSource = "detected";
  } else {
    name = basename(cwd);
    nameSource = "default";
  }
  rows.push({ field: "name", value: name, source: nameSource });

  // workspace / branchBase / prTarget: existing > navori import > default (no detection exists for these)
  const workspace = existing?.workspace ?? navori?.workspace;
  rows.push({
    field: "workspace",
    value: workspace ?? "(sin asignar)",
    source: existing?.workspace ? "preserved" : navori?.workspace ? "imported" : "default",
  });

  const branchBase = existing?.branchBase ?? navori?.branchBase ?? "main";
  rows.push({
    field: "branchBase",
    value: branchBase,
    source: existing?.branchBase ? "preserved" : navori?.branchBase ? "imported" : "default",
  });

  const prTarget = existing?.prTarget ?? navori?.prTarget;
  if (prTarget) {
    rows.push({
      field: "prTarget",
      value: prTarget,
      source: existing?.prTarget ? "preserved" : "imported",
    });
  }

  // project: existing > navori import > empty defaults
  const project = existing?.project ?? {
    criticalAreas: navori?.project?.criticalAreas ?? [],
    legacyPaths: navori?.project?.legacyPaths ?? [],
  };
  rows.push({
    field: "project",
    value: `criticalAreas=[${project.criticalAreas.join(", ")}] legacyPaths=[${project.legacyPaths.join(", ")}]`,
    source: existing?.project ? "preserved" : navori?.project ? "imported" : "default",
  });

  // stack (packageManager/framework/libs): always freshly detected.
  const packageManager = detectPackageManager(cwd);
  const framework = pkg ? detectFramework(pkg) : undefined;
  const libs = pkg ? detectLibs(pkg) : [];
  rows.push({ field: "stack.packageManager", value: packageManager ?? "(no detectado)", source: "detected" });
  rows.push({ field: "stack.framework", value: framework ?? "(no detectado)", source: "detected" });
  rows.push({ field: "stack.libs", value: libs.join(", ") || "(ninguna)", source: "detected" });

  // qualityGate: existing > navori import > detected from package.json scripts
  const importedFull = existing?.qualityGate?.full ?? navori?.qualityGate?.full;
  const importedFast = existing?.qualityGate?.fast || navori?.qualityGate?.fast;
  let qualityGate: { fast: string; full?: string };
  if (importedFast) {
    qualityGate = { fast: importedFast, full: importedFull };
    rows.push({
      field: "qualityGate.fast",
      value: importedFast,
      source: existing?.qualityGate ? "preserved" : "imported",
    });
  } else {
    const fast = pkg && packageManager ? buildQualityGateFast(pkg, packageManager) : "";
    if (fast) {
      qualityGate = { fast, full: importedFull };
      rows.push({ field: "qualityGate.fast", value: fast, source: "detected" });
    } else {
      qualityGate = { fast: NO_GATE_PLACEHOLDER, full: importedFull };
      rows.push({
        field: "qualityGate.fast",
        value: "no se detectaron scripts lint/typecheck/test",
        source: "warning",
      });
    }
  }

  // identity: always freshly detected from the git remote.
  const remoteUrl = getRemoteOriginUrl(cwd);
  const identity = remoteUrl ? (parseIdentityFromRemote(remoteUrl) ?? undefined) : undefined;
  rows.push({ field: "identity", value: identity ?? "(no detectada)", source: "detected" });

  // skills: the 4 hardcoded motor skills plus whatever DEP_SKILL_MAP maps
  // from the repo's detected deps, deduped and in stable (MOTOR_SKILLS
  // first, then DEP_SKILL_MAP declaration order) order.
  const mappedSkills = pkg ? detectMappedSkills(pkg) : [];
  const skills = [...MOTOR_SKILLS, ...mappedSkills.filter((id) => !MOTOR_SKILLS.includes(id))];
  rows.push({ field: "skills", value: skills.join(", "), source: "detected" });

  const configInput: ArgosConfigInput = {
    name,
    language: existing?.language ?? "es",
    workspace,
    branchBase,
    prTarget,
    qualityGate,
    project,
    identity,
    stack: { framework, packageManager, libs },
    skills,
  };

  let configPath: string | undefined;
  let finalConfig: ArgosConfig | undefined;
  try {
    writeConfig(cwd, configInput);
    configPath = join(cwd, CONFIG_FILENAME);
    finalConfig = readConfig(cwd);
  } catch (err) {
    rows.push({ field: "argos.config.json", value: errorMessage(err), source: "error" });
    return { rows, configPath, exitCode: 1 };
  }

  // Workspace auto-link: resolve the same explicit>config>match-rules chain
  // `workspace link` uses and register the repo when it resolves cleanly.
  // Never blocks adopt — an unresolved or ambiguous result is reported as a
  // pending step (info/warning row), not an error.
  try {
    const registry = loadRegistry();
    const resolution = resolveWorkspaceForRepo(registry, {
      configWorkspace: finalConfig.workspace,
      remoteUrl,
      repoPath: cwd,
    });
    if (resolution.kind === "resolved") {
      const linkResult = linkRepo(resolution.name, { name: finalConfig.name, path: cwd });
      rows.push({
        field: "workspace.link",
        value: `${linkResult.action} en workspace '${resolution.name}'`,
        source: "detected",
      });
    } else if (resolution.kind === "ambiguous") {
      rows.push({
        field: "workspace.link",
        value: `ambiguo entre workspaces (${resolution.candidates.join(", ")}) — corre argos workspace link <nombre>`,
        source: "warning",
      });
    } else {
      rows.push({
        field: "workspace.link",
        value: "workspace sin resolver — corre argos workspace link <nombre>",
        source: "info",
      });
    }
  } catch (err) {
    rows.push({ field: "workspace.link", value: errorMessage(err), source: "warning" });
  }

  // Ficha: inject/replace the `ficha` managed block in ./CLAUDE.md via the
  // same markers lib used for the global engine — foreign content untouched.
  let fichaStatus: FileStatus | undefined;
  let backupPath: string | undefined;
  try {
    // Back up the repo's own CLAUDE.md before mutating it in place — same
    // backups location the global engine uses, keyed by an arbitrary source dir.
    backupPath = createBackup(cwd, ["CLAUDE.md"]);

    const fichaContent = buildFichaContent(finalConfig);
    const claudeMdPath = join(cwd, "CLAUDE.md");
    const claudeMdBefore = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, "utf-8") : "";
    const hadFicha = listBlocks(claudeMdBefore).some((b) => b.id === FICHA_BLOCK_ID);
    const claudeMdAfter = injectBlock(claudeMdBefore, FICHA_BLOCK_ID, readCliVersion(), fichaContent);
    fichaStatus = claudeMdAfter === claudeMdBefore ? "unchanged" : hadFicha ? "updated" : "created";
    writeFileAtomic(claudeMdPath, claudeMdAfter);
    rows.push({ field: "ficha (./CLAUDE.md)", value: fichaStatus, source: "detected" });
  } catch (err) {
    rows.push({ field: "ficha (./CLAUDE.md)", value: errorMessage(err), source: "error" });
  }

  const exitCode: 0 | 1 = rows.some((r) => r.source === "error") ? 1 : 0;
  return { rows, configPath, fichaStatus, backupPath, exitCode };
}

export const adoptCommand = defineCommand({
  meta: {
    name: "adopt",
    description: "Detect a repo's stack and write its argos.config.json.",
  },
  args: {
    refresh: {
      type: "boolean",
      default: false,
      description: "Regenera argos.config.json y la ficha aunque ya existan.",
    },
  },
  run({ args }) {
    const report = runAdopt({ cwd: process.cwd(), refresh: Boolean(args.refresh) });

    if (report.error) {
      console.error(pc.red(report.error));
      process.exit(report.exitCode);
    }

    for (const row of report.rows) {
      const paddedSource = row.source.padEnd(10);
      const label =
        row.source === "error" ? pc.red(paddedSource) : row.source === "warning" ? pc.yellow(paddedSource) : pc.dim(paddedSource);
      console.log(`${label} ${row.field.padEnd(28)} ${row.value}`);
    }
    console.log("");
    console.log(`argos.config.json escrito en ${report.configPath}`);
    if (report.backupPath) console.log(`backup en ${report.backupPath}`);

    process.exit(report.exitCode);
  },
});
