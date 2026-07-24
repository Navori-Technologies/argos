import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const NAVORI_CONFIG_FILENAME = "navori.config.json";

/** Refuse to parse foreign input larger than this — unsanitized host-repo content. */
export const NAVORI_CONFIG_MAX_BYTES = 1_000_000;

export interface NaviorImport {
  name?: string;
  qualityGate?: { fast?: string; full?: string };
  project?: { criticalAreas?: string[]; legacyPaths?: string[] };
  workspace?: string;
  branchBase?: string;
  prTarget?: string;
}

/**
 * Discriminated read result for `navori.config.json`. Per "lo no visto se
 * declara": a present-but-broken file must never collapse silently into
 * "absent" — callers need to be able to tell the two apart and warn.
 */
export type NaviorImportResult =
  | { kind: "absent" }
  | { kind: "imported"; data: NaviorImport }
  | { kind: "unreadable"; error: string };

/** True when a `navori.config.json` exists in `dir` (harness coexistence). */
export function hasNaviorConfig(dir: string): boolean {
  return existsSync(join(dir, NAVORI_CONFIG_FILENAME));
}

/**
 * Best-effort import of `navori.config.json` fields Argos also models. This
 * is a foreign file with its own (unvalidated) shape — read leniently, take
 * only the fields we recognize, and never throw on unexpected shapes. A
 * present file that can't be read/parsed/used is reported as `"unreadable"`,
 * never silently treated as `"absent"`.
 */
export function readNaviorConfig(dir: string): NaviorImportResult {
  const path = join(dir, NAVORI_CONFIG_FILENAME);
  if (!existsSync(path)) return { kind: "absent" };

  try {
    if (statSync(path).size > NAVORI_CONFIG_MAX_BYTES) {
      return {
        kind: "unreadable",
        error: `navori.config.json excede el máximo permitido de ${NAVORI_CONFIG_MAX_BYTES} bytes`,
      };
    }

    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof raw !== "object" || raw === null) {
      return { kind: "unreadable", error: "navori.config.json no es un objeto JSON" };
    }
    const obj = raw as Record<string, unknown>;

    const result: NaviorImport = {};
    if (typeof obj.name === "string") result.name = obj.name;
    if (typeof obj.workspace === "string") result.workspace = obj.workspace;
    if (typeof obj.branchBase === "string") result.branchBase = obj.branchBase;
    if (typeof obj.prTarget === "string") result.prTarget = obj.prTarget;

    if (typeof obj.qualityGate === "object" && obj.qualityGate !== null) {
      const qg = obj.qualityGate as Record<string, unknown>;
      result.qualityGate = {
        fast: typeof qg.fast === "string" ? qg.fast : undefined,
        full: typeof qg.full === "string" ? qg.full : undefined,
      };
    }

    if (typeof obj.project === "object" && obj.project !== null) {
      const project = obj.project as Record<string, unknown>;
      result.project = {
        criticalAreas: Array.isArray(project.criticalAreas)
          ? project.criticalAreas.filter((v): v is string => typeof v === "string")
          : undefined,
        legacyPaths: Array.isArray(project.legacyPaths)
          ? project.legacyPaths.filter((v): v is string => typeof v === "string")
          : undefined,
      };
    }

    return { kind: "imported", data: result };
  } catch (err) {
    return { kind: "unreadable", error: err instanceof Error ? err.message : String(err) };
  }
}
