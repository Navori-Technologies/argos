import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_FILENAME = "argos.config.json";

const QualityGateSchema = z.object({
  fast: z.string().min(1),
  full: z.string().optional(),
});

const ProjectSchema = z.object({
  criticalAreas: z.array(z.string()).default([]),
  legacyPaths: z.array(z.string()).default([]),
});

const StackSchema = z.object({
  framework: z.string().optional(),
  packageManager: z.string().optional(),
  libs: z.array(z.string()).default([]),
});

export const ArgosConfigSchema = z.object({
  name: z.string().min(1),
  language: z.enum(["es", "en"]).default("es"),
  workspace: z.string().optional(),
  branchBase: z.string().default("main"),
  prTarget: z.string().optional(),
  qualityGate: QualityGateSchema,
  project: ProjectSchema.default({ criticalAreas: [], legacyPaths: [] }),
  identity: z.string().optional(),
  stack: StackSchema.optional(),
  skills: z.array(z.string()).default([]),
});

export type ArgosConfig = z.infer<typeof ArgosConfigSchema>;
export type ArgosConfigInput = z.input<typeof ArgosConfigSchema>;

/** Read and validate `argos.config.json` from a repo directory. */
export function readConfig(repoDir: string): ArgosConfig {
  const configPath = join(repoDir, CONFIG_FILENAME);
  const raw = readFileSync(configPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  return ArgosConfigSchema.parse(parsed);
}

/** Write `argos.config.json` to a repo directory (pretty JSON, trailing newline). */
export function writeConfig(repoDir: string, config: ArgosConfigInput): void {
  const validated = ArgosConfigSchema.parse(config);
  const configPath = join(repoDir, CONFIG_FILENAME);
  writeFileSync(configPath, `${JSON.stringify(validated, null, 2)}\n`, "utf-8");
}

/** True when `argos.config.json` exists in a repo directory. */
export function hasConfig(repoDir: string): boolean {
  return existsSync(join(repoDir, CONFIG_FILENAME));
}
