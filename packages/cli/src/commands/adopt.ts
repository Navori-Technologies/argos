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
import { isInteractive, clackPrompter, type Prompter } from "../lib/prompter.js";
import { readCliVersion } from "../lib/version.js";
import { linkRepo, loadRegistry, resolveWorkspaceForRepo } from "../lib/workspaces.js";

/** Written when no lint/typecheck/test script exists to build a real gate from. */
export const NO_GATE_PLACEHOLDER =
  "echo 'argos: no lint/typecheck/test scripts detected — set qualityGate.fast manually'";

export interface AdoptRow {
  field: string;
  value: string;
  source: "imported" | "preserved" | "detected" | "default" | "edited" | "info" | "warning" | "error";
}

export interface AdoptOverrides {
  name?: string;
  branchBase?: string;
  qualityGateFast?: string;
  workspace?: string;
  identity?: string;
}

export interface AdoptOptions {
  cwd: string;
  refresh?: boolean;
  /**
   * Values the interactive layer collected by presenting the
   * detected/imported defaults as editable (spec 0004 "argos adopt";
   * Enter = accept the detected value). Additive — every field optional,
   * and omitting `overrides` entirely reproduces today's non-interactive
   * behavior byte-for-byte. Applied in place of the corresponding detected
   * value, reported with row `source: "edited"`.
   */
  overrides?: AdoptOverrides;
}

/**
 * Pure value selection: the interactive-layer override wins over the
 * detected/imported value, when one was collected and it actually differs
 * (Enter-accepted defaults come back as `undefined` from the wizard — see
 * `runAdoptInteractive` — so they're a no-op here too). No side effects —
 * safe to embed in an expression (e.g. an object spread) without hiding a
 * mutation inside it.
 */
function resolveOverride<T extends string | undefined>(computed: T, override: T | undefined): T {
  return override === undefined || override === computed ? computed : override;
}

/**
 * The mutation half of applying an override: when `override` differs from
 * `computed` (the value already pushed as `field`'s row), rewrites that
 * row's `value`/`source` in place to reflect the edit (`source: "edited"`).
 * Deliberately separate from `resolveOverride` and NEVER called embedded
 * inside another expression (e.g. a spread) — always its own statement, so
 * the side effect is visible at the call site, not hidden.
 */
function markRowEditedIfOverridden<T extends string | undefined>(
  rows: AdoptRow[],
  field: string,
  computed: T,
  override: T | undefined,
): void {
  if (override === undefined || override === computed) return;
  const row = rows.find((r) => r.field === field);
  if (row) {
    row.value = override;
    row.source = "edited";
  }
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
  markRowEditedIfOverridden(rows, "name", name, options.overrides?.name);
  name = resolveOverride(name, options.overrides?.name);

  // workspace / branchBase / prTarget: existing > navori import > default (no detection exists for these)
  let workspace: string | undefined = existing?.workspace ?? navori?.workspace;
  rows.push({
    field: "workspace",
    value: workspace ?? "(sin asignar)",
    source: existing?.workspace ? "preserved" : navori?.workspace ? "imported" : "default",
  });
  markRowEditedIfOverridden(rows, "workspace", workspace, options.overrides?.workspace);
  workspace = resolveOverride(workspace, options.overrides?.workspace);

  let branchBase = existing?.branchBase ?? navori?.branchBase ?? "main";
  rows.push({
    field: "branchBase",
    value: branchBase,
    source: existing?.branchBase ? "preserved" : navori?.branchBase ? "imported" : "default",
  });
  markRowEditedIfOverridden(rows, "branchBase", branchBase, options.overrides?.branchBase);
  branchBase = resolveOverride(branchBase, options.overrides?.branchBase);

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
  markRowEditedIfOverridden(rows, "qualityGate.fast", qualityGate.fast, options.overrides?.qualityGateFast);
  qualityGate = { ...qualityGate, fast: resolveOverride(qualityGate.fast, options.overrides?.qualityGateFast) };

  // identity: always freshly detected from the git remote.
  const remoteUrl = getRemoteOriginUrl(cwd);
  let identity = remoteUrl ? (parseIdentityFromRemote(remoteUrl) ?? undefined) : undefined;
  rows.push({ field: "identity", value: identity ?? "(no detectada)", source: "detected" });
  markRowEditedIfOverridden(rows, "identity", identity, options.overrides?.identity);
  identity = resolveOverride(identity, options.overrides?.identity);

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

interface AdoptDefaults {
  name: string;
  branchBase: string;
  qualityGateFast: string;
  identity?: string;
  workspaceDefault?: string;
  workspaceAmbiguousCandidates?: string[];
  /** Human-readable description of the resolution chain that found `workspaceDefault`/the ambiguity, for display only. */
  workspaceChain: string;
}

/**
 * Read-only preview of the values `runAdopt` would detect/import, used only
 * to seed the interactive wizard's editable prompts (spec 0004 "argos
 * adopt": "Enter = aceptar lo detectado"). Deliberately duplicates a slice
 * of `runAdopt`'s own detection logic instead of factoring it out from
 * there — this function never writes anything (no config, no ficha, no
 * registry), so it's safe to call before deciding what to write, but it must
 * stay obviously side-effect-free rather than becoming a shared code path
 * with the writing core.
 */
function computeAdoptDefaults(cwd: string): AdoptDefaults {
  let existing: ArgosConfig | undefined;
  if (hasConfig(cwd)) {
    try {
      existing = readConfig(cwd);
    } catch {
      existing = undefined;
    }
  }
  const naviorResult = readNaviorConfig(cwd);
  const navori = naviorResult.kind === "imported" ? naviorResult.data : undefined;
  const pkg = readPackageJson(cwd);

  const name = existing?.name ?? navori?.name ?? pkg?.name ?? basename(cwd);
  const branchBase = existing?.branchBase ?? navori?.branchBase ?? "main";

  const packageManager = detectPackageManager(cwd);
  const importedFast = existing?.qualityGate?.fast || navori?.qualityGate?.fast;
  const qualityGateFast =
    importedFast || (pkg && packageManager ? buildQualityGateFast(pkg, packageManager) : "") || NO_GATE_PLACEHOLDER;

  const remoteUrl = getRemoteOriginUrl(cwd);
  const identity = remoteUrl ? (parseIdentityFromRemote(remoteUrl) ?? undefined) : undefined;

  const configWorkspace = existing?.workspace ?? navori?.workspace;
  let workspaceDefault: string | undefined = configWorkspace;
  let workspaceAmbiguousCandidates: string[] | undefined;
  let workspaceChain: string;
  if (configWorkspace) {
    workspaceChain = existing?.workspace ? "argos.config.json existente" : "importado de navori.config.json";
  } else {
    let registry: ReturnType<typeof loadRegistry>;
    try {
      registry = loadRegistry();
    } catch {
      registry = {};
    }
    const resolution = resolveWorkspaceForRepo(registry, { remoteUrl, repoPath: cwd });
    if (resolution.kind === "resolved") {
      workspaceDefault = resolution.name;
      workspaceChain = `match rule (${resolution.source})`;
    } else if (resolution.kind === "ambiguous") {
      workspaceAmbiguousCandidates = resolution.candidates;
      workspaceChain = `ambiguo (${resolution.source})`;
    } else {
      workspaceChain = "sin resolver";
    }
  }

  return { name, branchBase, qualityGateFast, identity, workspaceDefault, workspaceAmbiguousCandidates, workspaceChain };
}

export interface AdoptInteractiveOptions extends AdoptOptions {
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
function cancelledAdoptReport(): AdoptReport {
  return { rows: [], exitCode: 1 };
}

/**
 * Interactive layer over `runAdopt` (spec 0004 F5 "argos adopt"). A pure
 * additive wrapper — the core `runAdopt` never changes behavior or
 * contract. Without a real TTY, or with `--yes`, this delegates to
 * `runAdopt(options)` unchanged. With a TTY, and only when the underlying
 * call would otherwise proceed to detection (repo exists, config doesn't
 * already block without `--refresh`), it presents every detected/imported
 * value as an editable prompt (Enter = accept detected), resolves an
 * ambiguous workspace match via a `select` instead of erroring, and shows a
 * final confirm before writing anything.
 */
export async function runAdoptInteractive(options: AdoptInteractiveOptions): Promise<AdoptReport> {
  if (!isInteractive({ yes: options.yes })) {
    return runAdopt(options);
  }

  const { cwd, refresh = false } = options;

  // Same 2 early-exit guards `runAdopt` itself has — reproduce them here
  // unprompted so the wizard never even starts when the underlying call is
  // just going to error out anyway.
  const gitCheck = checkGitRepo(cwd);
  if (!gitCheck.isRepo) return runAdopt(options);
  if (hasConfig(cwd) && !refresh) return runAdopt(options);

  const prompter = options.prompter ?? clackPrompter;
  const defaults = computeAdoptDefaults(cwd);

  prompter.intro("argos adopt — revisión interactiva");

  const name = await prompter.text({ message: "Nombre del repo", initialValue: defaults.name, defaultValue: defaults.name });
  if (prompter.isCancel(name)) {
    prompter.cancel("argos adopt cancelado — no se tocó nada.");
    return cancelledAdoptReport();
  }

  const branchBase = await prompter.text({
    message: "Rama base",
    initialValue: defaults.branchBase,
    defaultValue: defaults.branchBase,
  });
  if (prompter.isCancel(branchBase)) {
    prompter.cancel("argos adopt cancelado — no se tocó nada.");
    return cancelledAdoptReport();
  }

  const qualityGateFast = await prompter.text({
    message: "Quality gate (fast)",
    initialValue: defaults.qualityGateFast,
    defaultValue: defaults.qualityGateFast,
  });
  if (prompter.isCancel(qualityGateFast)) {
    prompter.cancel("argos adopt cancelado — no se tocó nada.");
    return cancelledAdoptReport();
  }

  let workspace: string | undefined = defaults.workspaceDefault;
  if (defaults.workspaceAmbiguousCandidates) {
    const chosen = await prompter.select<string>({
      message: `Workspace ambiguo — resolución vía ${defaults.workspaceChain}. Elegí uno:`,
      options: defaults.workspaceAmbiguousCandidates.map((c) => ({ value: c })),
    });
    if (prompter.isCancel(chosen)) {
      prompter.cancel("argos adopt cancelado — no se tocó nada.");
      return cancelledAdoptReport();
    }
    workspace = chosen;
  } else {
    const edited = await prompter.text({
      message: `Workspace (resuelto vía: ${defaults.workspaceChain})`,
      initialValue: workspace ?? "",
      defaultValue: workspace ?? "",
    });
    if (prompter.isCancel(edited)) {
      prompter.cancel("argos adopt cancelado — no se tocó nada.");
      return cancelledAdoptReport();
    }
    workspace = edited || undefined;
  }

  const identity = await prompter.text({
    message: "Identidad",
    initialValue: defaults.identity ?? "",
    defaultValue: defaults.identity ?? "",
  });
  if (prompter.isCancel(identity)) {
    prompter.cancel("argos adopt cancelado — no se tocó nada.");
    return cancelledAdoptReport();
  }

  prompter.note(
    [
      `nombre: ${name}`,
      `branchBase: ${branchBase}`,
      `qualityGate.fast: ${qualityGateFast}`,
      `workspace: ${workspace ?? "(sin asignar)"}`,
      `identity: ${identity || "(no detectada)"}`,
    ].join("\n"),
    "Resumen (config + ficha)",
  );

  const proceed = await prompter.confirm({ message: "¿Escribir argos.config.json y la ficha?", initialValue: true });
  if (prompter.isCancel(proceed) || !proceed) {
    prompter.cancel("argos adopt cancelado — no se tocó nada.");
    return cancelledAdoptReport();
  }

  const report = runAdopt({
    cwd,
    refresh,
    overrides: {
      name: name || undefined,
      branchBase: branchBase || undefined,
      qualityGateFast: qualityGateFast || undefined,
      workspace,
      identity: identity || undefined,
    },
  });
  prompter.outro(`argos.config.json escrito en ${report.configPath}`);
  return report;
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
    yes: {
      type: "boolean",
      default: false,
      description: "Fuerza modo no interactivo aunque haya una TTY real (defaults + flags, sin wizard).",
    },
  },
  async run({ args }) {
    const report = await runAdoptInteractive({
      cwd: process.cwd(),
      refresh: Boolean(args.refresh),
      yes: Boolean(args.yes),
    });

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
