import { execFileSync } from "node:child_process";

export interface GitCheckResult {
  isRepo: boolean;
  /** True when `git` itself could not be spawned (not installed / not on PATH). */
  gitMissing: boolean;
}

function isSpawnEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Check whether `cwd` sits inside a git working tree, distinguishing a real
 * infra problem (the `git` binary itself is missing) from the normal "not a
 * repo" case — collapsing both into one message hides a broken environment
 * behind what looks like an ordinary state.
 */
export function checkGitRepo(cwd: string): GitCheckResult {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { isRepo: true, gitMissing: false };
  } catch (err) {
    return { isRepo: false, gitMissing: isSpawnEnoent(err) };
  }
}

/** True when `cwd` sits inside a git working tree. */
export function isGitRepo(cwd: string): boolean {
  return checkGitRepo(cwd).isRepo;
}

/** `git remote get-url origin`, or null when there is no such remote. */
export function getRemoteOriginUrl(cwd: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Derive a short identity token from a git remote URL, e.g.
 * `https://github.com/bonum/repo.git` or `git@github.com:bonum/repo.git`
 * both become `github.com-bonum` (host + first path segment, which is the
 * org/user account on every common host — GitHub, GitLab, Bitbucket).
 *
 * Returns null when the URL doesn't match either the scp-like SSH form
 * (`user@host:path`) or a URL form (`scheme://host/path`).
 */
export function parseIdentityFromRemote(remoteUrl: string): string | null {
  // scp-like SSH form: git@host:org/repo(.git)?
  const scpMatch = /^[^@/]+@([^:/]+):([^/]+)\//.exec(remoteUrl);
  if (scpMatch) return `${scpMatch[1]}-${scpMatch[2]}`;

  // URL form: ssh://git@host/org/repo(.git)?, https://host/org/repo(.git)?
  try {
    const url = new URL(remoteUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 1 && url.hostname) return `${url.hostname}-${segments[0]}`;
  } catch {
    // not a parseable URL — give up
  }

  return null;
}
