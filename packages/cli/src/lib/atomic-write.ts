import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Write `content` to `path` atomically.
 *
 * Every plain `writeFileSync` in this codebase writes in place — if the
 * process dies mid-write (OOM kill, power loss, a killed CI job), `path`
 * is left holding truncated/torn content. For a hook shell script that
 * means a syntax error, which turns into a hard PreToolUse block on every
 * single Bash call until the user manually deletes or fixes the file.
 *
 * This writes to a randomly-named `.tmp` file in the SAME directory as
 * `path` (so the follow-up rename stays on one filesystem and is atomic),
 * then `renameSync`s it into place. A crash before the rename leaves
 * `path` completely untouched; the stray tmp file is cleaned up on any
 * failure this function can observe.
 */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  const dir = dirname(path);
  const tmpPath = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);

  try {
    writeFileSync(tmpPath, content, "utf-8");
    // Force the exact mode on the tmp file (not just the create-time `mode`
    // option, which is subject to the process umask) so callers get the
    // same guarantee a direct `chmodSync` on the final path would have —
    // rename() preserves whatever permissions the tmp file already has.
    if (mode !== undefined) chmodSync(tmpPath, mode);
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort cleanup — the original error is what matters to the caller.
    }
    throw err;
  }
}
