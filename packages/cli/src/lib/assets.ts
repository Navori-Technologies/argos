import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "./package-root.js";

/**
 * Ordered ids of the 5 managed CLAUDE.md blocks. Order defines the order the
 * blocks appear in the rendered file. Ids are the basenames (without `.md`)
 * of `assets/managed/*.md`.
 */
export const MANAGED_BLOCK_IDS = [
  "identidad",
  "formato-respuesta",
  "aterrizaje",
  "orquestacion",
  "operaciones-seguras",
] as const;

/**
 * Resolve the Argos assets directory (`managed/`, `agents/`, `skills/`,
 * `output-styles/`) relative to the currently running module. See
 * `resolvePackageRoot` for the resolution strategy.
 */
export function resolveAssetsDir(fromUrl: string = import.meta.url): string {
  return join(resolvePackageRoot(fromUrl), "assets");
}

/** Read a text asset file relative to the assets directory. */
export function readAsset(assetsDir: string, ...relPath: string[]): string {
  return readFileSync(join(assetsDir, ...relPath), "utf-8");
}

/** List agent ids (basenames without `.md`) found under `assets/agents/`. */
export function listAgentIds(assetsDir: string): string[] {
  return readdirSync(join(assetsDir, "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/** List skill ids (directory names) found under `assets/skills/`. */
export function listSkillIds(assetsDir: string): string[] {
  return readdirSync(join(assetsDir, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * Recursively list every file shipped under a skill's asset directory
 * (`assets/skills/<skillId>/`), as relative paths from that directory with
 * forward slashes regardless of platform (e.g. `SKILL.md`,
 * `references/core.md`, `phases/0-product.md`). Sorted for deterministic
 * output. Some skills are a single `SKILL.md`; ~15 also ship load-bearing
 * subdirectories (`references/`, `phases/`, `assets/`) that this walks too —
 * without it, only `SKILL.md` would ever reach the user's `~/.claude/skills`.
 */
export function listSkillFiles(assetsDir: string, skillId: string): string[] {
  const root = join(assetsDir, "skills", skillId);
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}
