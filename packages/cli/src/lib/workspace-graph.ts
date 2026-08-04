import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveAssetsDir } from "./assets.js";
import { writeFileAtomic } from "./atomic-write.js";
import { hasConfig, readConfig } from "./config.js";
import type { GraphifyCliResult } from "./graphify-plugin.js";
import { getRemoteOriginUrl } from "./git.js";
import { resolveArgosHome } from "./paths.js";
import { hasBinary as hasBinaryReal } from "./which.js";
import { resolveWorkspaceForRepo, type WorkspaceRegistry } from "./workspaces.js";

/**
 * `argos workspace graph [name]` (spec 0007): productizes the external
 * `~/.claude/scripts/workspace-graph.sh` + `graphify-bridge.py` pipeline as a
 * native CLI command — rebuild each repo's graphify graph, merge them into
 * one workspace-wide graph, then bridge cross-repo contracts (HTTP calls,
 * shared constants) into edges so `graphify path/query` can traverse repo
 * boundaries. Also wired into `argos adopt`'s success path to trigger a
 * debounced background regeneration (see `triggerWorkspaceGraphBackground`).
 */

// --- root resolution ---------------------------------------------------

export type ResolveWorkspaceRootResult =
  | { kind: "resolved"; root: string; workspaceName: string }
  | { kind: "unresolved" }
  | { kind: "workspace-not-found"; name: string }
  | { kind: "workspace-empty"; name: string }
  | { kind: "workspace-dispersed"; name: string; parents: string[] };

/**
 * Resolve the root directory of a workspace: with an explicit `name`, looks
 * it up in the registry directly; without one, resolves the workspace of the
 * repo at `cwd` first (its `argos.config.json#workspace` or a registry match
 * rule, same chain `resolveWorkspaceForRepo` implements for `workspace
 * link`/`adopt`). Either way, the root is the common parent directory of the
 * workspace's registered repos (mirrors `resolve_workspace_name` in
 * `workspace-graph.sh`, which used `dirname` + a uniqueness check on the
 * repos' paths) — repos scattered across more than one parent directory are
 * reported as `workspace-dispersed` rather than guessed at.
 */
export function resolveWorkspaceRoot(
  name: string | undefined,
  cwd: string,
  registry: WorkspaceRegistry,
): ResolveWorkspaceRootResult {
  let workspaceName = name;

  if (!workspaceName) {
    let configWorkspace: string | undefined;
    if (hasConfig(cwd)) {
      try {
        configWorkspace = readConfig(cwd).workspace;
      } catch {
        configWorkspace = undefined;
      }
    }
    const remoteUrl = getRemoteOriginUrl(cwd);
    const resolution = resolveWorkspaceForRepo(registry, { configWorkspace, remoteUrl, repoPath: cwd });
    if (resolution.kind !== "resolved") {
      return { kind: "unresolved" };
    }
    workspaceName = resolution.name;
  }

  const workspace = registry[workspaceName];
  if (!workspace) {
    return { kind: "workspace-not-found", name: workspaceName };
  }
  if (workspace.repos.length === 0) {
    return { kind: "workspace-empty", name: workspaceName };
  }

  const parents = [...new Set(workspace.repos.map((r) => dirname(r.path)))];
  if (parents.length > 1) {
    return { kind: "workspace-dispersed", name: workspaceName, parents };
  }
  return { kind: "resolved", root: parents[0] as string, workspaceName };
}

// --- graph repo discovery ------------------------------------------------

export interface GraphRepo {
  name: string;
  path: string;
}

/**
 * Immediate subdirectories of `root` that carry a `graphify-out/graph.json`
 * — the generic definition of "a workspace's repos" per `workspace-graph.sh`
 * (any directory works, not just registry-linked ones; the registry is only
 * used to resolve `root` itself in `resolveWorkspaceRoot`). Sorted for
 * deterministic output. Missing/unreadable `root` yields an empty list
 * rather than throwing — callers check the `>= 2` requirement themselves.
 */
export function discoverGraphRepos(root: string): GraphRepo[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const repos: GraphRepo[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, "graphify-out", "graph.json"))) {
      repos.push({ name: entry.name, path });
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name));
}

// --- runner ---------------------------------------------------------------

export type WorkspaceGraphBinary = "graphify" | "python3";

/**
 * Runs one invocation of `graphify` or `python3` (the bridge script asset).
 * Injectable so tests never shell out — same idiom as `GraphifyRunner` in
 * `graphify-plugin.ts`.
 */
export type WorkspaceGraphRunner = (
  binary: WorkspaceGraphBinary,
  args: string[],
  timeoutMs: number,
  cwd?: string,
) => GraphifyCliResult;

/** Real default implementation, backed by `node:child_process.spawnSync`. */
export const runWorkspaceGraphCli: WorkspaceGraphRunner = (binary, args, timeoutMs, cwd) => {
  const result = spawnSync(binary, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    return { status: null, stdout: "", stderr: "", error: result.error as NodeJS.ErrnoException };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

// Per-repo `graphify update` builds a from-scratch AST graph (no LLM) — can
// be slow on large repos, same bound as `graphify-plugin.ts`'s own update.
const UPDATE_TIMEOUT_MS = 300_000;
const MERGE_TIMEOUT_MS = 120_000;
const BRIDGE_TIMEOUT_MS = 120_000;

/** Resolve the bundled `graphify-bridge.py` asset path (ships under `assets/scripts/`, run in place — no install step). */
export function resolveBridgeScriptPath(fromUrl: string = import.meta.url): string {
  return join(resolveAssetsDir(fromUrl), "scripts", "graphify-bridge.py");
}

// --- pipeline ---------------------------------------------------------------

export interface WorkspaceGraphOptions {
  /** Explicit workspace name, or `undefined` to resolve from `cwd`. */
  name?: string;
  cwd: string;
  /** Output dir override; default `<root>/blueprint/workspace-graph` if it exists, else `<root>/workspace-graph`. */
  out?: string;
  /** Skip the per-repo `graphify update` refresh (faster; reuses each repo's existing graph). */
  noUpdate?: boolean;
  /** Print the plan and exit without running anything. */
  dryRun?: boolean;
  /** Injectable for tests; defaults to `runWorkspaceGraphCli`. */
  runner?: WorkspaceGraphRunner;
  /** Injectable for tests; defaults to the real `hasBinary` from `which.ts`. */
  hasBinary?: (name: string) => boolean;
  /** Injectable for tests; defaults to the real registry loader's result — passed in rather than loaded here so callers control `~/.argos` in tests. */
  registry: WorkspaceRegistry;
}

export type WorkspaceGraphReason =
  | "unresolved"
  | "workspace-not-found"
  | "workspace-empty"
  | "workspace-dispersed"
  | "insufficient-repos"
  | "graphify-missing"
  | "merge-failed";

export interface WorkspaceGraphReport {
  exitCode: 0 | 1;
  reason?: WorkspaceGraphReason;
  error?: string;
  root?: string;
  outDir?: string;
  repos?: string[];
  dryRun?: boolean;
  planLines?: string[];
  mergedGraphPath?: string;
  mergeSummary?: string;
  bridgeReportPath?: string;
  /** True when the bridge step was skipped (no `python3`, or the bridge script itself failed) — always a warning, never fails the whole command. */
  bridgeSkipped?: boolean;
  bridgeWarning?: string;
}

function commandFailureDetail(result: GraphifyCliResult): string {
  return result.stderr.trim() || result.stdout.trim() || `el comando salió con status ${result.status}`;
}

function spawnFailureDetail(error: NodeJS.ErrnoException, binary: string): string {
  return error.code === "ENOENT" ? `el binario '${binary}' no está en PATH` : error.message;
}

/** Default out dir: `<root>/blueprint/workspace-graph` if it already exists, else `<root>/workspace-graph`. */
function defaultOutDir(root: string): string {
  const blueprintOut = join(root, "blueprint", "workspace-graph");
  return existsSync(blueprintOut) ? blueprintOut : join(root, "workspace-graph");
}

/**
 * Core, testable pipeline for `argos workspace graph [name]` (spec 0007):
 * `graphify update` per repo (unless `noUpdate`) → `graphify merge-graphs` →
 * the bundled `graphify-bridge.py` asset. Degradations, per spec:
 * - `graphify` not in PATH → `graphify-missing` error, nothing runs.
 * - a per-repo `graphify update` failure never aborts the pipeline — the
 *   repo's existing graph is merged as-is (mirrors `workspace-graph.sh`'s
 *   `|| echo "(update failed, using existing graph)"`).
 * - `python3` absent, or the bridge script itself fails, → the merge is kept
 *   (exit 0) and the report carries `bridgeSkipped`/`bridgeWarning` instead
 *   of failing the whole command — the bridge is a cross-repo enhancement on
 *   top of an already-valid merged graph, not a hard requirement.
 * `dryRun` prints the plan and returns without touching the filesystem or
 * spawning anything.
 */
export function runWorkspaceGraph(options: WorkspaceGraphOptions): WorkspaceGraphReport {
  const { cwd, registry } = options;
  const runner = options.runner ?? runWorkspaceGraphCli;
  const hasBinary = options.hasBinary ?? hasBinaryReal;

  const resolution = resolveWorkspaceRoot(options.name, cwd, registry);
  if (resolution.kind === "unresolved") {
    return {
      exitCode: 1,
      reason: "unresolved",
      error:
        "No se pudo resolver un workspace para este repo — pasá un nombre explícito: `argos workspace graph <nombre>`.",
    };
  }
  if (resolution.kind === "workspace-not-found") {
    return { exitCode: 1, reason: "workspace-not-found", error: `Workspace '${resolution.name}' no encontrado.` };
  }
  if (resolution.kind === "workspace-empty") {
    return {
      exitCode: 1,
      reason: "workspace-empty",
      error: `Workspace '${resolution.name}' no tiene repos registrados.`,
    };
  }
  if (resolution.kind === "workspace-dispersed") {
    return {
      exitCode: 1,
      reason: "workspace-dispersed",
      error:
        `Los repos del workspace '${resolution.name}' están bajo distintos directorios padre ` +
        `(${resolution.parents.join(", ")}) — pasá el directorio raíz explícito con --out o corre el comando desde ahí.`,
    };
  }

  const { root } = resolution;
  const repos = discoverGraphRepos(root);
  if (repos.length < 2) {
    return {
      exitCode: 1,
      reason: "insufficient-repos",
      root,
      repos: repos.map((r) => r.name),
      error: `Se necesitan >=2 repos con graphify-out/graph.json bajo ${root} (se encontraron ${repos.length}).`,
    };
  }

  const outDir = options.out ? resolve(cwd, options.out) : defaultOutDir(root);
  const mergedGraphPath = join(outDir, "merged-graph.json");
  const bridgeReportPath = join(outDir, "bridge-report.md");
  const noUpdate = Boolean(options.noUpdate);

  if (options.dryRun) {
    const planLines = [
      `workspace: ${root}`,
      `repos: ${repos.length}`,
      ...repos.map((r) => `  - ${r.name}`),
      `dry-run: update=${!noUpdate} out=${outDir} — nada ejecutado`,
    ];
    return { exitCode: 0, root, outDir, repos: repos.map((r) => r.name), dryRun: true, planLines };
  }

  if (!hasBinary("graphify")) {
    return {
      exitCode: 1,
      reason: "graphify-missing",
      root,
      outDir,
      repos: repos.map((r) => r.name),
      error: "el binario 'graphify' no está en PATH — instalalo (ver `argos doctor`) y volvé a intentar.",
    };
  }

  mkdirSync(outDir, { recursive: true });

  if (!noUpdate) {
    for (const repo of repos) {
      // A failed per-repo update never aborts the pipeline — the repo's
      // existing graph.json (already confirmed present by discoverGraphRepos)
      // is merged as-is, same tolerance as workspace-graph.sh.
      runner("graphify", ["update", repo.path], UPDATE_TIMEOUT_MS, repo.path);
    }
  }

  const graphPaths = repos.map((r) => join(r.path, "graphify-out", "graph.json"));
  const mergeResult = runner(
    "graphify",
    ["merge-graphs", ...graphPaths, "--out", mergedGraphPath],
    MERGE_TIMEOUT_MS,
  );
  if (mergeResult.error) {
    return {
      exitCode: 1,
      reason: "merge-failed",
      root,
      outDir,
      repos: repos.map((r) => r.name),
      error: spawnFailureDetail(mergeResult.error, "graphify"),
    };
  }
  if (mergeResult.status !== 0) {
    return {
      exitCode: 1,
      reason: "merge-failed",
      root,
      outDir,
      repos: repos.map((r) => r.name),
      error: commandFailureDetail(mergeResult),
    };
  }

  const report: WorkspaceGraphReport = {
    exitCode: 0,
    root,
    outDir,
    repos: repos.map((r) => r.name),
    mergedGraphPath,
    mergeSummary: mergeResult.stdout.trim() || undefined,
  };

  if (!hasBinary("python3")) {
    return {
      ...report,
      bridgeSkipped: true,
      bridgeWarning: "'python3' no está en PATH — se omitió el bridge de contratos cross-repo (merge sí se generó).",
    };
  }

  const bridgeScript = resolveBridgeScriptPath();
  const bridgeArgs = [
    bridgeScript,
    "--graph",
    mergedGraphPath,
    ...repos.map((r) => r.path),
    "--report",
    bridgeReportPath,
  ];
  const bridgeResult = runner("python3", bridgeArgs, BRIDGE_TIMEOUT_MS);
  if (bridgeResult.error) {
    return {
      ...report,
      bridgeSkipped: true,
      bridgeWarning: `el bridge de contratos falló (${spawnFailureDetail(bridgeResult.error, "python3")}) — merge sí se generó.`,
    };
  }
  if (bridgeResult.status !== 0) {
    return {
      ...report,
      bridgeSkipped: true,
      bridgeWarning: `el bridge de contratos falló (${commandFailureDetail(bridgeResult)}) — merge sí se generó.`,
    };
  }

  return { ...report, bridgeReportPath };
}

// --- adopt integration: debounced background trigger ------------------------

/** 10 minutes — adopting several repos of the same workspace back-to-back triggers only one regeneration. */
export const WORKSPACE_GRAPH_DEBOUNCE_MS = 10 * 60 * 1000;

function stampPath(root: string): string {
  const hash = createHash("sha1").update(root).digest("hex").slice(0, 16);
  return join(resolveArgosHome(), "workspace-graph-stamps", `${hash}.stamp`);
}

/** True when `root`'s workspace graph hasn't been (re)triggered within the debounce window (or ever). */
export function shouldTriggerWorkspaceGraph(root: string, now: () => number = Date.now): boolean {
  const p = stampPath(root);
  if (!existsSync(p)) return true;
  const raw = readFileSync(p, "utf-8").trim();
  const last = Number(raw);
  return !Number.isFinite(last) || now() - last > WORKSPACE_GRAPH_DEBOUNCE_MS;
}

/** Records `now()` as the last-triggered timestamp for `root`'s workspace graph. */
export function writeWorkspaceGraphStamp(root: string, now: () => number = Date.now): void {
  const p = stampPath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileAtomic(p, String(now()));
}

/** Injectable for tests; defaults to a real detached `argos workspace graph <name>` child process. */
export type WorkspaceGraphSpawnFn = (root: string, workspaceName: string) => void;

/**
 * Real default spawn: re-invokes the currently running CLI entry point
 * (`process.argv[1]`, e.g. `bin/argos.js`) as `argos workspace graph
 * <workspaceName>` in a detached, unref'd child process, logging to
 * `<root>/.argos/workspace-graph.log`. Passing the workspace name (rather
 * than relying on `cwd` resolution) means the child resolves its own root
 * via the registry regardless of `root`'s own `argos.config.json` state.
 */
const defaultSpawn: WorkspaceGraphSpawnFn = (root, workspaceName) => {
  const logDir = join(root, ".argos");
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, "workspace-graph.log"), "a");
  const child = spawn(process.execPath, [process.argv[1] ?? "argos", "workspace", "graph", workspaceName], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
};

export interface TriggerWorkspaceGraphOptions {
  /** Injectable for tests; defaults to `defaultSpawn`. */
  spawn?: WorkspaceGraphSpawnFn;
  /** Injectable clock for debounce checks in tests. */
  now?: () => number;
}

/**
 * Triggers a debounced background regeneration of `workspaceName`'s graph
 * (spec 0007, `adopt` integration): a no-op (returns `false`) when the last
 * trigger for `root` is within `WORKSPACE_GRAPH_DEBOUNCE_MS`; otherwise spawns
 * the background job and stamps `root` with the current time. Callers (e.g.
 * `runAdopt`) are responsible for deciding whether to call this at all
 * (workspace resolved + >=2 graph repos + `--no-workspace-graph` not passed).
 */
export function triggerWorkspaceGraphBackground(
  root: string,
  workspaceName: string,
  options: TriggerWorkspaceGraphOptions = {},
): boolean {
  const now = options.now ?? Date.now;
  if (!shouldTriggerWorkspaceGraph(root, now)) return false;
  const spawnFn = options.spawn ?? defaultSpawn;
  spawnFn(root, workspaceName);
  writeWorkspaceGraphStamp(root, now);
  return true;
}
