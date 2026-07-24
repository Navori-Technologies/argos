import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Read and JSON-parse `package.json` from `dir`, or null if absent/invalid. */
export function readPackageJson(dir: string): PackageJsonShape | null {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PackageJsonShape;
  } catch {
    return null;
  }
}

function allDeps(pkg: PackageJsonShape): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/** Lockfile basename → packageManager id, checked in this preference order. */
const LOCKFILES: Array<{ file: string; packageManager: string }> = [
  { file: "pnpm-lock.yaml", packageManager: "pnpm" },
  { file: "yarn.lock", packageManager: "yarn" },
  { file: "package-lock.json", packageManager: "npm" },
  { file: "bun.lockb", packageManager: "bun" },
];

/** Detect the package manager from lockfile presence in `dir`. */
export function detectPackageManager(dir: string): string | undefined {
  for (const { file, packageManager } of LOCKFILES) {
    if (existsSync(join(dir, file))) return packageManager;
  }
  return undefined;
}

/**
 * Ordered framework detectors — first dependency match wins. Kept as a
 * simple array so adding a new framework is a one-line change.
 */
export const FRAMEWORK_DETECTORS: ReadonlyArray<{ id: string; deps: readonly string[] }> = [
  { id: "next", deps: ["next"] },
  { id: "react", deps: ["react"] },
  { id: "react-native", deps: ["react-native", "expo"] },
  { id: "express", deps: ["express"] },
  { id: "nestjs", deps: ["@nestjs/core", "nestjs"] },
  { id: "astro", deps: ["astro"] },
];

/** Detect the framework from `package.json` deps, in FRAMEWORK_DETECTORS order. */
export function detectFramework(pkg: PackageJsonShape): string | undefined {
  const deps = allDeps(pkg);
  for (const detector of FRAMEWORK_DETECTORS) {
    if (detector.deps.some((dep) => dep in deps)) return detector.id;
  }
  return undefined;
}

/** Small, extensible list of libs worth recording in `argos.config.json`. */
export const KNOWN_LIBS: readonly string[] = [
  "axios",
  "zod",
  "react-hook-form",
  "@tanstack/react-query",
  "zustand",
  "mongoose",
  "socket.io",
  "stripe",
];

/** Intersection of `package.json` deps with KNOWN_LIBS. */
export function detectLibs(pkg: PackageJsonShape): string[] {
  const deps = allDeps(pkg);
  return KNOWN_LIBS.filter((lib) => lib in deps);
}

/** Candidate quality-gate scripts, checked/joined in this order when present. */
const GATE_SCRIPTS = ["lint", "typecheck", "test"] as const;

/** Render `pm run script` in the idiom of each package manager. */
function runScript(packageManager: string, script: string): string {
  switch (packageManager) {
    case "pnpm":
      return `pnpm ${script}`;
    case "yarn":
      return `yarn ${script}`;
    case "bun":
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/**
 * Build the "fast" quality-gate command from whichever of lint/typecheck/test
 * scripts actually exist in `package.json`. Returns "" when none exist —
 * callers should surface a warning in that case.
 */
export function buildQualityGateFast(pkg: PackageJsonShape, packageManager: string): string {
  const scripts = pkg.scripts ?? {};
  const present = GATE_SCRIPTS.filter((s) => s in scripts);
  if (present.length === 0) return "";
  return present.map((s) => runScript(packageManager, s)).join(" && ");
}

/** The 4 motor skills every repo gets in F1 — hardcoded pending dynamic detection. */
export const MOTOR_SKILLS: readonly string[] = [
  "verify-before-done",
  "review-diff",
  "pr-create",
  "loop-back-debug",
];

/**
 * Ordered `package.json` dependency → motor skill id(s) map, checked in this
 * order and evaluated against `deps ∪ devDeps`. Every entry is independent
 * and additive except the `react` entry: it's skipped when `next` is also
 * present, since `next`'s entry already includes `react-19` — this mirrors
 * the same precedence `FRAMEWORK_DETECTORS` uses for next-over-react.
 *
 * Deliberately NOT mapped:
 * - `expo` / `react-native` → `not-boring-mobile` is a visual/interaction
 *   style choice, not something to infer from a dependency being present.
 * - Python stacks (Django REST Framework, pytest) and Go testing have no
 *   entry here — F-now detection is `package.json`-only, so those skills
 *   stay trigger-available (installed in the skill catalog) but are never
 *   auto-mapped from a repo's manifest.
 */
export const DEP_SKILL_MAP: ReadonlyArray<{ dep: string; skills: readonly string[] }> = [
  { dep: "next", skills: ["nextjs-15", "react-19"] },
  { dep: "react", skills: ["react-19"] },
  { dep: "typescript", skills: ["typescript"] },
  { dep: "tailwindcss", skills: ["tailwind-4"] },
  { dep: "zod", skills: ["zod-4"] },
  { dep: "zustand", skills: ["zustand-5"] },
  { dep: "axios", skills: ["axios"] },
  { dep: "@tanstack/react-query", skills: ["tanstack-query"] },
  { dep: "mongoose", skills: ["mongoose"] },
  { dep: "react-hook-form", skills: ["react-hook-form"] },
  { dep: "@apollo/client", skills: ["apollo-client"] },
  { dep: "bullmq", skills: ["bullmq"] },
  { dep: "@mantine/form", skills: ["mantine-form"] },
  { dep: "react-router", skills: ["react-router"] },
  { dep: "react-router-dom", skills: ["react-router"] },
  { dep: "@reduxjs/toolkit", skills: ["redux-toolkit"] },
  { dep: "socket.io", skills: ["socketio"] },
  { dep: "socket.io-client", skills: ["socketio"] },
  { dep: "stripe", skills: ["stripe"] },
  { dep: "tamagui", skills: ["tamagui"] },
  { dep: "@tamagui/core", skills: ["tamagui"] },
  { dep: "winston", skills: ["winston-logging"] },
  { dep: "@playwright/test", skills: ["playwright"] },
  { dep: "astro", skills: ["astro"] },
  { dep: "@angular/core", skills: ["angular"] },
  { dep: "ai", skills: ["ai-sdk-5"] },
];

/**
 * Map `package.json` deps to motor skill ids via `DEP_SKILL_MAP`, deduped
 * and in stable (map declaration) order. Used by `adopt` to extend the
 * config's `skills` field beyond the always-on `MOTOR_SKILLS`.
 */
export function detectMappedSkills(pkg: PackageJsonShape): string[] {
  const deps = allDeps(pkg);
  const hasNext = "next" in deps;
  const result: string[] = [];
  for (const { dep, skills } of DEP_SKILL_MAP) {
    if (dep === "react" && hasNext) continue; // covered by the `next` entry already
    if (!(dep in deps)) continue;
    for (const id of skills) {
      if (!result.includes(id)) result.push(id);
    }
  }
  return result;
}
