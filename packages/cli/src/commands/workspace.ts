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
import {
  addRemoteMatchRule,
  linkRepo,
  loadRegistry,
  offerMatchRule,
  resolveWorkspaceForRepo,
  type LinkAction,
} from "../lib/workspaces.js";
import { hasBinary as hasBinaryDefault } from "../lib/which.js";

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

export interface WorkspaceLinkReport {
  exitCode: 0 | 1;
  error?: string;
  ambiguousCandidates?: string[];
  workspaceName?: string;
  action?: LinkAction;
  createdWorkspace?: boolean;
  /** Remote identity persisted as a new match rule, if the offer fired. */
  matchRuleAdded?: string;
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
  run({ args }) {
    const report = runWorkspaceLink({
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

export const workspaceCommand = defineCommand({
  meta: {
    name: "workspace",
    description: "Registro machine-local de workspaces (match rules + flota OpenClaw).",
  },
  subCommands: {
    link: linkSubCommand,
    show: showSubCommand,
    agents: agentsSubCommand,
  },
});
