import type { ArgosConfig } from "./config.js";

export const FICHA_BLOCK_ID = "ficha";

/**
 * Render the repo ficha content (the ~10 lines injected into `./CLAUDE.md`
 * under the `ficha` managed block) from the current `argos.config.json`.
 * Shared by `adopt` (writes it) and `doctor` (checks it for drift) so both
 * always agree on what "up to date" means.
 */
export function buildFichaContent(config: ArgosConfig): string {
  const lines: string[] = [`## Ficha del repo: ${config.name}`, ""];

  const gate = config.qualityGate.full
    ? `${config.qualityGate.fast} (full: ${config.qualityGate.full})`
    : config.qualityGate.fast;
  lines.push(`- Quality gate fast: \`${gate}\``);
  lines.push(`- Rama base: \`${config.branchBase}\``);
  lines.push(`- Workspace: ${config.workspace ?? "sin asignar"}`);

  const criticalAreas = config.project.criticalAreas;
  const legacyPaths = config.project.legacyPaths;
  if (criticalAreas.length > 0 || legacyPaths.length > 0) {
    const areas = [...criticalAreas, ...legacyPaths];
    lines.push(`- Áreas críticas: ${areas.join(", ")}`);
  }

  lines.push(`- Skills aplicables: ${config.skills.join(", ")}`);
  lines.push("");
  lines.push("Datos de argos.config.json — regenerar con `argos adopt --refresh`.");

  return lines.join("\n");
}
