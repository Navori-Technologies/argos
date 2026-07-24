import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * OpenClaw fixes one cwd per "agent". `argos workspace agents <name>` needs
 * one OpenClaw agent per repo registered in an Argos workspace so that
 * Claude Code sessions anchor inside each repo and use the global motor from
 * that repo's own working directory. This module holds the pure per-repo
 * planning/classification logic so `commands/workspace.ts` stays a thin
 * formatter — mirroring how `commands/adopt.ts` exports `runAdopt` for the
 * same reason. Ported from the proven design in navori-harness (F2 spec's
 * "hereda de navori-harness" list).
 */

export const OPENCLAW_BINARY = "openclaw";

/** OpenClaw agent name for a repo: optional prefix + repo name, no other transform. */
export function buildAgentName(repoName: string, prefix = ""): string {
  return `${prefix}${repoName}`;
}

export function buildOpenclawAddArgs(agentName: string, repoPath: string): string[] {
  return ["agents", "add", agentName, "--workspace", repoPath, "--non-interactive"];
}

/** Human-readable form of the command, for preview output only (never parsed back). */
export function formatOpenclawAddCommand(agentName: string, repoPath: string): string {
  return `${OPENCLAW_BINARY} ${buildOpenclawAddArgs(agentName, repoPath).join(" ")}`;
}

export type OpenclawAddOutcome = "created" | "exists" | "error";

export interface OpenclawAddResult {
  outcome: OpenclawAddOutcome;
  detail: string;
}

// openclaw's exact wording for "this agent name is already registered" isn't
// part of any published contract, so this is a best-effort classifier over
// common phrasings. Widen it here if a real openclaw error message doesn't match.
// Deliberately does NOT match a bare "duplicate" — that also fires on unrelated
// errors like "duplicate key violation in database", which must surface as a
// real failure instead of being swallowed as a benign "already exists".
const DUPLICATE_PATTERN =
  /\bagent\b[^\n]{0,80}\balready (?:exists|registered)\b|\bname\b[^\n]{0,80}\balready in use\b|\balready exists\b|\balready registered\b/i;

/** Classify a finished `openclaw agents add` invocation into created/exists/error. */
export function classifyOpenclawAddResult(
  status: number | null,
  stdout: string,
  stderr: string,
): OpenclawAddResult {
  if (status === 0) {
    return { outcome: "created", detail: stdout.trim() };
  }
  const combined = `${stderr}\n${stdout}`;
  if (DUPLICATE_PATTERN.test(combined)) {
    return { outcome: "exists", detail: stderr.trim() || stdout.trim() || "agent already exists" };
  }
  return {
    outcome: "error",
    detail: stderr.trim() || stdout.trim() || `openclaw exited with status ${status}`,
  };
}

/** Runs `openclaw agents add ...` for real. Injectable so tests never shell out. */
export type OpenclawRunner = (agentName: string, repoPath: string) => OpenclawAddResult;

// A non-interactive "register an agent" call should never legitimately run
// for minutes, but stays bounded so a hang (e.g. openclaw waiting on a stuck
// interactive prompt) can't freeze the whole per-repo agent-add loop forever
// — a real risk when this runs unattended from cron on the VPS.
const OPENCLAW_ADD_TIMEOUT_MS = 120_000; // 120s, per spec

export const runOpenclawAgentAdd: OpenclawRunner = (agentName, repoPath) => {
  const result = spawnSync(OPENCLAW_BINARY, buildOpenclawAddArgs(agentName, repoPath), {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENCLAW_ADD_TIMEOUT_MS,
  });
  if (result.error) {
    // spawnSync sets result.error with this code when the timeout fires.
    if ((result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return {
        outcome: "error",
        detail:
          `Timed out adding agent '${agentName}' after ${OPENCLAW_ADD_TIMEOUT_MS / 1000}s. ` +
          `openclaw may be waiting for interactive input — check for a stuck prompt.`,
      };
    }
    return { outcome: "error", detail: (result.error as Error).message };
  }
  return classifyOpenclawAddResult(result.status, result.stdout ?? "", result.stderr ?? "");
};

export type WorkspaceAgentStatus = "created" | "would-create" | "exists" | "missing" | "error";

export interface WorkspaceAgentRow {
  name: string;
  status: WorkspaceAgentStatus;
  detail: string;
}

export interface PlanWorkspaceAgentsOptions {
  /** true = preview only, never calls the runner. */
  preview: boolean;
  prefix?: string;
  /** Injectable for tests; defaults to runOpenclawAgentAdd. */
  runner?: OpenclawRunner;
  /** Injectable for tests; defaults to node:fs existsSync. */
  pathExists?: (path: string) => boolean;
}

/**
 * Build the per-repo plan for `workspace agents`: one OpenClaw agent per
 * registered repo. Preview mode never shells out — it only formats the
 * command that would run. Apply mode calls the runner per repo and keeps
 * going on a per-repo failure (e.g. the agent already exists), since one
 * bad repo must not abort the rest of the workspace.
 */
export function planWorkspaceAgents(
  repos: Array<{ name: string; path: string }>,
  options: PlanWorkspaceAgentsOptions,
): WorkspaceAgentRow[] {
  const { preview, prefix = "", runner = runOpenclawAgentAdd, pathExists = existsSync } = options;
  return repos.map((repo) => {
    const agentName = buildAgentName(repo.name, prefix);
    if (!pathExists(repo.path)) {
      return { name: repo.name, status: "missing", detail: repo.path };
    }
    if (preview) {
      return {
        name: repo.name,
        status: "would-create",
        detail: formatOpenclawAddCommand(agentName, repo.path),
      };
    }
    const result = runner(agentName, repo.path);
    return { name: repo.name, status: result.outcome, detail: result.detail };
  });
}
