import { defineCommand } from "citty";
import { existsSync } from "node:fs";
import pc from "picocolors";
import { hasConfig, readConfig, type ArgosConfig } from "../lib/config.js";
import { getRemoteOriginUrl } from "../lib/git.js";
import {
  OPENCLAW_BINARY,
  planWorkspaceAgents,
  type OpenclawRunner,
  type WorkspaceAgentRow,
  type WorkspaceAgentStatus,
} from "../lib/openclaw-agents.js";
import { isInteractive, clackPrompter, type Prompter } from "../lib/prompter.js";
import {
  addRemoteMatchRule,
  linkRepo,
  loadRegistry,
  offerMatchRule,
  resolveWorkspaceForRepo,
  WorkspaceNameCollisionError,
  type LinkAction,
} from "../lib/workspaces.js";
import { hasBinary as hasBinaryDefault } from "../lib/which.js";
import { runWorkspaceGraph, type WorkspaceGraphReport, type WorkspaceGraphRunner } from "../lib/workspace-graph.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- link --------------------------------------------------------------

export interface WorkspaceLinkOptions {
  cwd: string;
  /** Explicit workspace name passed on the command line, if any. */
  explicit?: string;
  /** Overwrite a name collision (same config.name, different physical repo) instead of refusing. */
  force?: boolean;
}

export interface WorkspaceLinkCollision {
  workspaceName: string;
  repoName: string;
  oldPath: string;
  newPath: string;
}

export interface WorkspaceLinkReport {
  exitCode: 0 | 1;
  error?: string;
  ambiguousCandidates?: string[];
  workspaceName?: string;
  action?: LinkAction;
  createdWorkspace?: boolean;
  /** Remote identity persisted as a new match rule, if the offer fired. */
  matchRuleAdded?: string;
  /**
   * Populated instead of a bare `error` string when `linkRepo` refused with
   * `WorkspaceNameCollisionError` (see lib/workspaces.ts) — lets the
   * interactive layer offer overwrite/cancel (the equivalent of `--force`)
   * without having to string-parse `error`. Additive: `error` is still set
   * alongside it, so any caller only reading `error` behaves exactly as
   * before.
   */
  collision?: WorkspaceLinkCollision;
}

/**
 * Core, testable implementation of `argos workspace link [nombre]`: resolves
 * which workspace the repo at `cwd` belongs to (explicit name > config >
 * match rules) and registers it. When a brand-new workspace was created via
 * an explicit name and the repo has a remote, teaches the registry that
 * remote as a match rule so future repos under the same identity auto-link.
 */
export function runWorkspaceLink(options: WorkspaceLinkOptions): WorkspaceLinkReport {
  const { cwd, explicit, force } = options;

  if (!hasConfig(cwd)) {
    return {
      exitCode: 1,
      error: "No se encontró argos.config.json en este directorio — corre `argos adopt` primero.",
    };
  }

  let config: ArgosConfig;
  try {
    config = readConfig(cwd);
  } catch (err) {
    return { exitCode: 1, error: `argos.config.json inválido — ${errorMessage(err)}` };
  }

  const remoteUrl = getRemoteOriginUrl(cwd);
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    return { exitCode: 1, error: errorMessage(err) };
  }
  const resolution = resolveWorkspaceForRepo(registry, {
    explicit,
    configWorkspace: config.workspace,
    remoteUrl,
    repoPath: cwd,
  });

  if (resolution.kind === "unresolved") {
    return {
      exitCode: 1,
      error:
        "No se pudo resolver un workspace para este repo — pasá un nombre explícito: " +
        "`argos workspace link <nombre>`.",
    };
  }
  if (resolution.kind === "ambiguous") {
    return {
      exitCode: 1,
      error: `Match ambiguo entre workspaces (${resolution.candidates.join(", ")}) — pasá un nombre explícito.`,
      ambiguousCandidates: resolution.candidates,
    };
  }

  let linkResult;
  try {
    linkResult = linkRepo(resolution.name, { name: config.name, path: cwd }, { force });
  } catch (err) {
    if (err instanceof WorkspaceNameCollisionError) {
      return {
        exitCode: 1,
        error: errorMessage(err),
        collision: {
          workspaceName: err.workspaceName,
          repoName: err.repoName,
          oldPath: err.oldPath,
          newPath: err.newPath,
        },
      };
    }
    return { exitCode: 1, error: errorMessage(err) };
  }

  let matchRuleAdded: string | undefined;
  if (resolution.source === "explicit") {
    const currentMatch = loadRegistry()[resolution.name]?.match ?? { remotes: [], paths: [] };
    const offer = offerMatchRule({
      createdWorkspace: linkResult.createdWorkspace,
      viaExplicitName: true,
      remoteUrl,
      currentMatch,
    });
    if (offer.shouldPersist && offer.identity) {
      addRemoteMatchRule(resolution.name, offer.identity);
      matchRuleAdded = offer.identity;
    }
  }

  return {
    exitCode: 0,
    workspaceName: resolution.name,
    action: linkResult.action,
    createdWorkspace: linkResult.createdWorkspace,
    matchRuleAdded,
  };
}

export interface WorkspaceLinkInteractiveOptions extends WorkspaceLinkOptions {
  /** Injectable for tests; defaults to the real `@clack/prompts`-backed prompter. */
  prompter?: Prompter;
}

/**
 * Interactive layer over `runWorkspaceLink` (spec 0004 F5 "argos workspace
 * link"). A pure additive wrapper — the core `runWorkspaceLink` never
 * changes behavior or contract. Without a real TTY this delegates to
 * `runWorkspaceLink(options)` unchanged (there's no `--yes` on this command:
 * absence of a real TTY is itself sufficient gate, per spec 0004). With a
 * TTY: an ambiguous match-rule resolution is resolved via `select` instead
 * of erroring, and a name collision (`WorkspaceNameCollisionError`) is
 * offered as an overwrite/cancel prompt — the interactive equivalent of
 * `--force`, which stays the non-interactive escape hatch unchanged.
 */
export async function runWorkspaceLinkInteractive(
  options: WorkspaceLinkInteractiveOptions,
): Promise<WorkspaceLinkReport> {
  if (!isInteractive({})) {
    return runWorkspaceLink(options);
  }

  const prompter = options.prompter ?? clackPrompter;
  const { cwd, explicit, force } = options;

  // Resolve ambiguity read-only first, mirroring runWorkspaceLink's own
  // resolution chain, before ever calling the writing core — an explicit
  // name (whether passed on the CLI or picked here) always short-circuits
  // resolveWorkspaceForRepo straight to "resolved", so no duplicate
  // ambiguity handling happens inside the core call below.
  let effectiveExplicit = explicit;
  if (!explicit) {
    if (!hasConfig(cwd)) return runWorkspaceLink(options); // identical error path, no prompts needed
    let config: ArgosConfig;
    try {
      config = readConfig(cwd);
    } catch {
      return runWorkspaceLink(options); // identical error path
    }
    const remoteUrl = getRemoteOriginUrl(cwd);
    let registry: ReturnType<typeof loadRegistry>;
    try {
      registry = loadRegistry();
    } catch {
      return runWorkspaceLink(options); // identical error path
    }
    const resolution = resolveWorkspaceForRepo(registry, { configWorkspace: config.workspace, remoteUrl, repoPath: cwd });
    if (resolution.kind === "ambiguous") {
      const chosen = await prompter.select<string>({
        message: `Match ambiguo entre workspaces (${resolution.source}) — elegí uno:`,
        options: resolution.candidates.map((c) => ({ value: c })),
      });
      if (prompter.isCancel(chosen)) {
        prompter.cancel("argos workspace link cancelado — no se tocó nada.");
        return { exitCode: 1, error: "argos workspace link cancelado por el usuario." };
      }
      effectiveExplicit = chosen;
    }
  }

  let report = runWorkspaceLink({ cwd, explicit: effectiveExplicit, force });

  if (report.collision && !force) {
    const overwrite = await prompter.confirm({
      message:
        `El repo '${report.collision.repoName}' ya está registrado en el workspace '${report.collision.workspaceName}' ` +
        `apuntando a otro path.\n  actual: ${report.collision.oldPath}\n  nuevo:  ${report.collision.newPath}\n` +
        "¿Sobrescribir con el path nuevo?",
      initialValue: false,
    });
    if (prompter.isCancel(overwrite) || !overwrite) {
      prompter.cancel("argos workspace link cancelado — no se tocó nada.");
      return report; // original failed report — nothing further was touched
    }
    report = runWorkspaceLink({ cwd, explicit: effectiveExplicit, force: true });
  }

  return report;
}

const linkSubCommand = defineCommand({
  meta: {
    name: "link",
    description: "Vincula el repo actual a un workspace (lo crea si no existe).",
  },
  args: {
    name: { type: "positional", description: "Nombre de workspace explícito", required: false },
    force: {
      type: "boolean",
      default: false,
      description: "Sobrescribe un choque de nombre (mismo config.name, repo físico distinto).",
    },
  },
  async run({ args }) {
    const report = await runWorkspaceLinkInteractive({
      cwd: process.cwd(),
      explicit: (args.name as string | undefined)?.trim() || undefined,
      force: Boolean(args.force),
    });

    if (report.error) {
      console.error(pc.red(report.error));
      process.exit(report.exitCode);
    }

    if (report.createdWorkspace) {
      console.log(pc.dim(`Workspace '${report.workspaceName}' creado.`));
    }
    const actionLabel: Record<LinkAction, string> = {
      added: "registrado",
      "updated-path": "path actualizado",
      unchanged: "sin cambios",
    };
    console.log(
      `${pc.green("✓")} repo ${actionLabel[report.action as LinkAction]} en workspace '${report.workspaceName}'.`,
    );
    if (report.matchRuleAdded) {
      console.log(
        pc.dim(`El remote '${report.matchRuleAdded}' se guardó como match rule del workspace.`),
      );
    }
    process.exit(report.exitCode);
  },
});

// --- show ----------------------------------------------------------------

export interface WorkspaceShowRepoRow {
  workspace: string;
  name: string;
  path: string;
  missing: boolean;
}

export interface WorkspaceShowReport {
  rows: WorkspaceShowRepoRow[];
  exitCode: 0 | 1;
  error?: string;
}

export interface WorkspaceShowOptions {
  /** Injectable for tests; defaults to node:fs existsSync. */
  pathExists?: (path: string) => boolean;
}

/** Core, testable implementation of `argos workspace show [nombre]`. */
export function runWorkspaceShow(name?: string, options: WorkspaceShowOptions = {}): WorkspaceShowReport {
  const pathExists = options.pathExists ?? existsSync;
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    return { rows: [], exitCode: 1, error: errorMessage(err) };
  }

  if (name) {
    const workspace = registry[name];
    if (!workspace) {
      return { rows: [], exitCode: 1, error: `Workspace '${name}' no encontrado.` };
    }
    const rows = workspace.repos.map((r) => ({
      workspace: name,
      name: r.name,
      path: r.path,
      missing: !pathExists(r.path),
    }));
    return { rows, exitCode: 0 };
  }

  const rows: WorkspaceShowRepoRow[] = [];
  for (const [wsName, workspace] of Object.entries(registry)) {
    for (const repo of workspace.repos) {
      rows.push({ workspace: wsName, name: repo.name, path: repo.path, missing: !pathExists(repo.path) });
    }
  }
  return { rows, exitCode: 0 };
}

const showSubCommand = defineCommand({
  meta: {
    name: "show",
    description: "Muestra los repos registrados en uno o todos los workspaces.",
  },
  args: {
    name: { type: "positional", description: "Nombre de workspace (default: todos)", required: false },
  },
  run({ args }) {
    const name = (args.name as string | undefined)?.trim() || undefined;
    const report = runWorkspaceShow(name);

    if (report.error) {
      console.error(pc.red(report.error));
      process.exit(report.exitCode);
    }

    if (report.rows.length === 0) {
      console.log("Ningún repo registrado todavía. Corre `argos workspace link` desde un repo.");
      process.exit(0);
    }

    for (const row of report.rows) {
      const flag = row.missing ? pc.red("(path inexistente)") : "";
      console.log(`${pc.dim(row.workspace.padEnd(16))} ${row.name.padEnd(24)} ${row.path} ${flag}`.trimEnd());
    }
    process.exit(0);
  },
});

// --- agents ----------------------------------------------------------------

export interface RunWorkspaceAgentsOptions {
  /** false (default) = preview only; true = actually run `openclaw agents add`. */
  apply?: boolean;
  prefix?: string;
  /** Injectable for tests; defaults to lib/which.ts hasBinary. */
  hasBinary?: (name: string) => boolean;
  /** Injectable for tests; forwarded to planWorkspaceAgents. */
  runner?: OpenclawRunner;
  /** Injectable for tests; forwarded to planWorkspaceAgents. */
  pathExists?: (path: string) => boolean;
}

export type RunWorkspaceAgentsEarlyReason = "workspace-not-found" | "no-repos" | "binary-missing";

export interface RunWorkspaceAgentsResult {
  exitCode: 0 | 1;
  preview: boolean;
  reason?: RunWorkspaceAgentsEarlyReason;
  error?: string;
  rows: WorkspaceAgentRow[];
}

/**
 * Core logic for `workspace agents <nombre>`. Preview (default) never
 * spawns anything — it only formats the commands that would run. `--apply`
 * requires the `openclaw` binary on PATH; a per-repo failure never aborts
 * the rest of the workspace (planWorkspaceAgents already guarantees this),
 * so the exit code reflects the honest partial summary.
 */
export function runWorkspaceAgents(
  name: string,
  options: RunWorkspaceAgentsOptions = {},
): RunWorkspaceAgentsResult {
  const apply = Boolean(options.apply);
  const preview = !apply;

  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    return { exitCode: 1, preview, error: errorMessage(err), rows: [] };
  }
  const workspace = registry[name];
  if (!workspace) {
    return {
      exitCode: 1,
      preview,
      reason: "workspace-not-found",
      error: `Workspace '${name}' no encontrado.`,
      rows: [],
    };
  }

  if (workspace.repos.length === 0) {
    return { exitCode: 0, preview, reason: "no-repos", rows: [] };
  }

  const checkBinary = options.hasBinary ?? hasBinaryDefault;
  if (apply && !checkBinary(OPENCLAW_BINARY)) {
    return { exitCode: 1, preview, reason: "binary-missing", rows: [] };
  }

  const rows = planWorkspaceAgents(workspace.repos, {
    preview,
    prefix: options.prefix ?? "",
    runner: options.runner,
    pathExists: options.pathExists,
  });
  const failed = rows.filter((r) => r.status === "error" || r.status === "missing").length;
  return { exitCode: failed > 0 ? 1 : 0, preview, rows };
}

const agentsSubCommand = defineCommand({
  meta: {
    name: "agents",
    description: "Crea un agente OpenClaw por repo registrado en el workspace.",
  },
  args: {
    name: { type: "positional", description: "Nombre de workspace", required: true },
    apply: {
      type: "boolean",
      default: false,
      description: "Ejecuta 'openclaw agents add' de verdad. Sin esto, todo se previsualiza.",
    },
    prefix: {
      type: "string",
      description: "Prefijo para cada nombre de agente OpenClaw.",
    },
  },
  run({ args }) {
    const name = args.name as string;
    const apply = Boolean(args.apply);
    const prefix = (args.prefix as string | undefined) ?? "";

    const result = runWorkspaceAgents(name, { apply, prefix });

    if (result.reason === "workspace-not-found") {
      console.error(pc.red(result.error ?? `Workspace '${name}' no encontrado.`));
      process.exit(result.exitCode);
    }
    if (result.reason === "no-repos") {
      console.log("Ningún repo registrado en este workspace. Corre `argos workspace link` desde un repo.");
      process.exit(0);
    }
    if (result.reason === "binary-missing") {
      console.error(
        pc.red(
          `No se encontró el binario '${OPENCLAW_BINARY}' en PATH. Este comando crea agentes OpenClaw ` +
            `y está pensado para correr donde OpenClaw está instalado (típicamente el VPS de agentes).`,
        ),
      );
      process.exit(result.exitCode);
    }

    const marker: Record<WorkspaceAgentStatus, string> = {
      created: pc.green("✓"),
      "would-create": pc.yellow("•"),
      exists: pc.dim("•"),
      missing: pc.red("✗"),
      error: pc.red("✗"),
    };
    for (const row of result.rows) {
      console.log(`${marker[row.status]} ${row.name.padEnd(24)} ${pc.dim(row.status)}  ${row.detail}`);
    }

    const failed = result.rows.filter((r) => r.status === "error" || r.status === "missing").length;
    const ok = result.rows.length - failed;
    const summary = result.preview
      ? `${ok}/${result.rows.length} ok · ${failed} fallidos`
      : `${ok}/${result.rows.length} ok · ${failed} fallidos`;
    console.log("");
    console.log(result.preview ? pc.yellow(`Preview — ${summary}`) : pc.green(`Listo — ${summary}`));
    process.exit(result.exitCode);
  },
});

// --- graph -------------------------------------------------------------

export interface WorkspaceGraphCommandOptions {
  cwd: string;
  name?: string;
  out?: string;
  noUpdate?: boolean;
  dryRun?: boolean;
  viz?: boolean;
  /** Injectable for tests; forwarded to `runWorkspaceGraph`. */
  runner?: WorkspaceGraphRunner;
  /** Injectable for tests; forwarded to `runWorkspaceGraph`. */
  hasBinary?: (name: string) => boolean;
}

/**
 * Thin wrapper over `runWorkspaceGraph` (lib/workspace-graph.ts) that loads
 * the real registry — kept separate from the pure core so the core never has
 * to know how to load `~/.argos/workspaces.json` (same split as
 * `runWorkspaceLink`/`runWorkspaceShow` above).
 */
export function runWorkspaceGraphCommand(options: WorkspaceGraphCommandOptions): WorkspaceGraphReport {
  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    return { exitCode: 1, error: errorMessage(err) };
  }
  return runWorkspaceGraph({ ...options, registry });
}

const graphSubCommand = defineCommand({
  meta: {
    name: "graph",
    description: "Reconstruye, mergea y bridgea los grafos graphify de un workspace (spec 0007).",
  },
  args: {
    name: {
      type: "positional",
      description: "Nombre de workspace (default: resuelto desde el repo actual)",
      required: false,
    },
    out: {
      type: "string",
      description: "Directorio de salida (default: <root>/blueprint/workspace-graph o <root>/workspace-graph).",
    },
    update: {
      type: "boolean",
      default: true,
      description: "Corre `graphify update` por repo antes de mergear (--no-update para saltarlo).",
    },
    dryRun: {
      type: "boolean",
      default: false,
      description: "Imprime el plan y no ejecuta nada.",
    },
    viz: {
      type: "boolean",
      default: true,
      description:
        "Genera <out>/bridge-graph.html, visualización autocontenida del subgrafo puente cross-repo (--no-viz para saltarlo).",
    },
  },
  run({ args }) {
    const name = (args.name as string | undefined)?.trim() || undefined;
    const out = (args.out as string | undefined)?.trim() || undefined;
    const report = runWorkspaceGraphCommand({
      cwd: process.cwd(),
      name,
      out,
      noUpdate: !(args.update as boolean),
      dryRun: Boolean(args.dryRun),
      viz: Boolean(args.viz),
    });

    if (report.error) {
      console.error(pc.red(report.error));
      process.exit(report.exitCode);
    }

    if (report.dryRun) {
      for (const line of report.planLines ?? []) console.log(line);
      process.exit(0);
    }

    console.log(`workspace: ${report.root}`);
    console.log(`repos: ${(report.repos ?? []).length} (${(report.repos ?? []).join(", ")})`);
    console.log(`${pc.green("✓")} merged-graph -> ${report.mergedGraphPath}`);
    if (report.mergeSummary) console.log(pc.dim(report.mergeSummary));
    if (report.bridgeSkipped) {
      console.log(pc.yellow(`⚠ ${report.bridgeWarning}`));
    } else if (report.bridgeReportPath) {
      console.log(`${pc.green("✓")} bridge-report -> ${report.bridgeReportPath}`);
    }
    if (report.bridgeVizPath) {
      console.log(`${pc.green("✓")} bridge-graph -> ${report.bridgeVizPath}`);
    } else if (report.bridgeVizWarning) {
      console.log(pc.yellow(`⚠ ${report.bridgeVizWarning}`));
    }

    process.exit(report.exitCode);
  },
});

export const workspaceCommand = defineCommand({
  meta: {
    name: "workspace",
    description: "Registro machine-local de workspaces (match rules + flota OpenClaw + grafo cross-repo).",
  },
  subCommands: {
    link: linkSubCommand,
    show: showSubCommand,
    agents: agentsSubCommand,
    graph: graphSubCommand,
  },
});
