import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Check whether a binary exists in PATH without spawning a shell — safer
 * than `execSync('command -v ...')`, which risks shell interpretation of the
 * name. Used to gate `argos workspace agents --apply` on the `openclaw`
 * binary being present before it tries to spawn it.
 */
export function hasBinary(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = pathEnv.split(sep).filter(Boolean);
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) return true;
        } catch {
          // Race between existsSync and statSync (file removed) — keep looking.
        }
      }
    }
  }
  return false;
}
