import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the `@argos/cli` package root (the directory holding both
 * `package.json` and `assets/`) relative to the currently running module.
 *
 * Walks up from the calling module's directory. This works from compiled
 * `dist/**` (package root is the parent of `dist/`) and from `src/**` during
 * ts-node/vitest dev runs, without depending on a fixed nesting depth or a
 * build-time asset-copy step.
 */
export function resolvePackageRoot(fromUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "assets"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not resolve the @argos/cli package root from ${fromUrl}`);
}
