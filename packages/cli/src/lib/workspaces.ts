import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { parseIdentityFromRemote } from "./git.js";
import { resolveArgosHome } from "./paths.js";

export const WORKSPACES_FILENAME = "workspaces.json";

export interface WorkspaceMatch {
  remotes: string[];
  paths: string[];
}

export interface WorkspaceRepoEntry {
  name: string;
  path: string;
}

export interface WorkspaceEntry {
  match: WorkspaceMatch;
  repos: WorkspaceRepoEntry[];
}

/** `name -> workspace` machine-local registry, per spec 0003. */
export type WorkspaceRegistry = Record<string, WorkspaceEntry>;

/**
 * Thrown by `loadRegistry` when `workspaces.json` exists but isn't valid
 * JSON. Typed so callers can tell "the registry is corrupt" apart from any
 * other unexpected throw and surface a clean, structured message instead of
 * an unhandled parse-error stack trace.
 */
export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function workspacesPath(): string {
  return join(resolveArgosHome(), WORKSPACES_FILENAME);
}

/**
 * Load `~/.argos/workspaces.json`. A missing file is a fresh install —
 * returns `{}`. Throws `RegistryError` when the file exists but isn't valid
 * JSON — callers must not let that crash bubble up as a raw stack trace
 * (see commands/workspace.ts, commands/doctor.ts, commands/adopt.ts).
 */
export function loadRegistry(): WorkspaceRegistry {
  const path = workspacesPath();
  if (!existsSync(path)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new RegistryError("workspaces.json corrupto — arregla o borra el archivo.");
  }
  return raw as WorkspaceRegistry;
}

/** Persist the registry (pretty JSON, trailing newline), creating `~/.argos` if needed. */
export function saveRegistry(registry: WorkspaceRegistry): void {
  mkdirSync(resolveArgosHome(), { recursive: true });
  writeFileAtomic(workspacesPath(), `${JSON.stringify(registry, null, 2)}\n`);
}

// --- resolution chain ------------------------------------------------------

export interface ResolveWorkspaceInput {
  /** An explicit name the user passed on the command line, e.g. `workspace link bonum`. */
  explicit?: string;
  /** The `workspace` field from the repo's argos.config.json, if set. */
  configWorkspace?: string;
  /** The repo's `origin` remote URL, if it has one. */
  remoteUrl?: string | null;
  /** Absolute path to the repo, used for path-based match rules. */
  repoPath: string;
}

export type ResolveMatchSource = "match-remote" | "match-path";
export type ResolveSource = "explicit" | "config" | ResolveMatchSource;

export type ResolveWorkspaceResult =
  | { kind: "resolved"; name: string; source: ResolveSource }
  | { kind: "ambiguous"; candidates: string[]; source: ResolveMatchSource }
  | { kind: "unresolved" };

/**
 * True when any entry in `matchRemotes` is a substring of the repo's remote
 * identity — matched against both the parsed identity token (e.g.
 * `github.com-bonum`) and the raw remote URL, so a rule can be as narrow as
 * `bonum` or as specific as the full identity token.
 */
function remoteMatches(remoteUrl: string | null | undefined, matchRemotes: string[]): boolean {
  if (!remoteUrl || matchRemotes.length === 0) return false;
  const identity = parseIdentityFromRemote(remoteUrl);
  return matchRemotes.some((rule) => (identity?.includes(rule) ?? false) || remoteUrl.includes(rule));
}

/** Escape regex metacharacters other than `*`, then turn `*` into `.*`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Prefix match for plain patterns, glob match (`*` wildcard) for patterns containing `*`. */
function pathMatches(repoPath: string, matchPaths: string[]): boolean {
  return matchPaths.some((pattern) =>
    pattern.includes("*") ? globToRegExp(pattern).test(repoPath) : repoPath.startsWith(pattern),
  );
}

/**
 * Resolve which workspace a repo belongs to, per spec 0003's chain:
 * explicit name > `workspace` in argos.config.json > match rules (remote
 * substring match first, path prefix/glob as fallback) > unresolved.
 * 2+ candidates at a match stage is ambiguous — resolution never guesses
 * between identities, it reports the candidates for the caller to surface.
 */
export function resolveWorkspaceForRepo(
  registry: WorkspaceRegistry,
  input: ResolveWorkspaceInput,
): ResolveWorkspaceResult {
  if (input.explicit) {
    return { kind: "resolved", name: input.explicit, source: "explicit" };
  }
  if (input.configWorkspace) {
    return { kind: "resolved", name: input.configWorkspace, source: "config" };
  }

  const remoteCandidates = Object.entries(registry)
    .filter(([, ws]) => remoteMatches(input.remoteUrl, ws.match.remotes))
    .map(([name]) => name);
  if (remoteCandidates.length === 1) {
    return { kind: "resolved", name: remoteCandidates[0] as string, source: "match-remote" };
  }
  if (remoteCandidates.length > 1) {
    return { kind: "ambiguous", candidates: remoteCandidates, source: "match-remote" };
  }

  const pathCandidates = Object.entries(registry)
    .filter(([, ws]) => pathMatches(input.repoPath, ws.match.paths))
    .map(([name]) => name);
  if (pathCandidates.length === 1) {
    return { kind: "resolved", name: pathCandidates[0] as string, source: "match-path" };
  }
  if (pathCandidates.length > 1) {
    return { kind: "ambiguous", candidates: pathCandidates, source: "match-path" };
  }

  return { kind: "unresolved" };
}

// --- linking ----------------------------------------------------------------

export type LinkAction = "added" | "updated-path" | "unchanged";

export interface LinkRepoResult {
  workspaceName: string;
  createdWorkspace: boolean;
  action: LinkAction;
  previousPath?: string;
  /** Normalized (absolute, symlink-resolved) repo path that was stored. */
  repoPath: string;
}

export interface LinkRepoOptions {
  /**
   * Bypass the name-collision refusal below and overwrite the existing
   * entry's path anyway. Mirrors `argos workspace link --force`.
   */
  force?: boolean;
}

/**
 * Thrown by `linkRepo` when `repo.name` is already registered in
 * `workspaceName` pointing at a DIFFERENT path that still exists on disk —
 * i.e. two distinct physical repos colliding on the same `config.name`.
 * Overwriting silently here would evict the old entry with no trace (data
 * loss for whoever relies on it), so `linkRepo` refuses unless `force` is
 * passed. Carries both paths so the caller can print a clear diagnostic.
 */
export class WorkspaceNameCollisionError extends Error {
  constructor(
    public readonly workspaceName: string,
    public readonly repoName: string,
    public readonly oldPath: string,
    public readonly newPath: string,
  ) {
    super(
      `El repo '${repoName}' ya está registrado en el workspace '${workspaceName}' apuntando a otro path.\n` +
        `  actual: ${oldPath}\n` +
        `  nuevo:  ${newPath}\n` +
        "Si son repos distintos, usá otro config.name; si el cambio es intencional, pasá --force.",
    );
    this.name = "WorkspaceNameCollisionError";
  }
}

/**
 * Register `repo` under workspace `workspaceName`, creating the workspace if
 * it doesn't exist yet. Re-linking the same repo name updates its path
 * (idempotent no-op when the path is unchanged). The path is normalized to
 * an absolute, symlink-resolved form before it's stored — `workspace show`
 * and `workspace agents` then compare disk state against exactly what's on
 * record. Throws when `repo.path` doesn't exist on disk.
 *
 * When an entry with the same name already exists at a DIFFERENT path, and
 * that old path still exists on disk with a different realpath, this
 * refuses with `WorkspaceNameCollisionError` instead of silently evicting
 * the old entry — unless `options.force` is set. If the old path is gone
 * from disk, it's treated as a legitimate move (repo relocated) and updated
 * as before, force or not.
 */
export function linkRepo(
  workspaceName: string,
  repo: WorkspaceRepoEntry,
  options: LinkRepoOptions = {},
): LinkRepoResult {
  let normalizedPath: string;
  try {
    normalizedPath = realpathSync(resolve(repo.path));
  } catch {
    throw new Error(`No existe el directorio del repo: ${repo.path}`);
  }

  const registry = loadRegistry();
  const existing = registry[workspaceName];
  const createdWorkspace = !existing;
  const workspace: WorkspaceEntry = existing ?? { match: { remotes: [], paths: [] }, repos: [] };

  const repoIndex = workspace.repos.findIndex((r) => r.name === repo.name);
  let action: LinkAction;
  let previousPath: string | undefined;
  if (repoIndex === -1) {
    workspace.repos.push({ name: repo.name, path: normalizedPath });
    action = "added";
  } else {
    const current = workspace.repos[repoIndex] as WorkspaceRepoEntry;
    if (current.path === normalizedPath) {
      action = "unchanged";
    } else {
      if (!options.force) {
        let isCollision = false;
        try {
          // Re-resolve rather than trusting the stored value verbatim: it's
          // normally already a realpath, but re-checking is what actually
          // proves the old path is still live and distinct on disk.
          isCollision = realpathSync(current.path) !== normalizedPath;
        } catch {
          isCollision = false; // old path is gone from disk -> legitimate move, not a collision
        }
        if (isCollision) {
          throw new WorkspaceNameCollisionError(workspaceName, repo.name, current.path, normalizedPath);
        }
      }
      previousPath = current.path;
      workspace.repos[repoIndex] = { name: repo.name, path: normalizedPath };
      action = "updated-path";
    }
  }

  registry[workspaceName] = workspace;
  saveRegistry(registry);

  return { workspaceName, createdWorkspace, action, previousPath, repoPath: normalizedPath };
}

// --- auto-teaching match rules ----------------------------------------------

export interface OfferMatchRuleInput {
  createdWorkspace: boolean;
  /** True when the workspace name came from an explicit `link <name>` argument. */
  viaExplicitName: boolean;
  remoteUrl?: string | null;
  currentMatch: WorkspaceMatch;
}

export interface OfferMatchRuleResult {
  shouldPersist: boolean;
  identity?: string;
}

/**
 * Decide whether a newly-created workspace should learn the repo's remote as
 * a match rule. Per spec: only offered when the workspace is brand new AND
 * the name was given explicitly (so it isn't a false positive from a match
 * rule that already matched something else) AND the repo actually has a
 * parseable remote that isn't already recorded.
 */
export function offerMatchRule(input: OfferMatchRuleInput): OfferMatchRuleResult {
  if (!input.createdWorkspace || !input.viaExplicitName || !input.remoteUrl) {
    return { shouldPersist: false };
  }
  const identity = parseIdentityFromRemote(input.remoteUrl);
  if (!identity || input.currentMatch.remotes.includes(identity)) {
    return { shouldPersist: false };
  }
  return { shouldPersist: true, identity };
}

/** Append `identity` to a workspace's `match.remotes`, if it isn't already there. */
export function addRemoteMatchRule(workspaceName: string, identity: string): void {
  const registry = loadRegistry();
  const workspace = registry[workspaceName];
  if (!workspace) return;
  if (workspace.match.remotes.includes(identity)) return;
  workspace.match.remotes.push(identity);
  saveRegistry(registry);
}
