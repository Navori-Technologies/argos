import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveArgosHome } from "./paths.js";

/**
 * Copy `entries` (files or directories, relative to `claudeDir`) into a
 * timestamped backup directory under `<argos home>/backups/` before a
 * destructive write. Missing entries are skipped silently — there is
 * nothing to protect. Returns the backup directory path.
 *
 * The directory name carries a short random suffix alongside the ISO
 * timestamp so two backups taken within the same millisecond never collide.
 */
export function createBackup(claudeDir: string, entries: string[]): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(3).toString("hex");
  const backupDir = join(resolveArgosHome(), "backups", `${timestamp}-${suffix}`);
  mkdirSync(backupDir, { recursive: true });

  for (const entry of entries) {
    const src = join(claudeDir, entry);
    if (!existsSync(src)) continue;
    const dest = join(backupDir, entry);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }

  return backupDir;
}
