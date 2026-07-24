import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArgosConfigSchema, hasConfig, readConfig, writeConfig } from "./config.js";

describe("ArgosConfigSchema", () => {
  it("applies defaults for optional fields", () => {
    const parsed = ArgosConfigSchema.parse({
      name: "my-repo",
      qualityGate: { fast: "pnpm test" },
    });

    expect(parsed).toEqual({
      name: "my-repo",
      language: "es",
      branchBase: "main",
      qualityGate: { fast: "pnpm test" },
      project: { criticalAreas: [], legacyPaths: [] },
      skills: [],
    });
  });

  it("accepts a fully populated config", () => {
    const input = {
      name: "my-repo",
      language: "en" as const,
      workspace: "bonum",
      branchBase: "develop",
      prTarget: "develop",
      qualityGate: { fast: "pnpm test", full: "pnpm test:full" },
      project: { criticalAreas: ["src/auth"], legacyPaths: ["src/legacy"] },
      identity: "work-remote",
      stack: { framework: "next", packageManager: "pnpm", libs: ["react"] },
      skills: ["review-readability"],
    };

    expect(ArgosConfigSchema.parse(input)).toEqual(input);
  });

  it("rejects a config missing the required name field", () => {
    expect(() => ArgosConfigSchema.parse({ qualityGate: { fast: "pnpm test" } })).toThrow();
  });

  it("rejects a config missing the required qualityGate.fast field", () => {
    expect(() => ArgosConfigSchema.parse({ name: "my-repo", qualityGate: {} })).toThrow();
  });

  it("rejects an invalid language value", () => {
    expect(() =>
      ArgosConfigSchema.parse({ name: "my-repo", language: "fr", qualityGate: { fast: "pnpm test" } }),
    ).toThrow();
  });
});

describe("readConfig / writeConfig", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "argos-config-"));
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("writes pretty JSON with a trailing newline and reads it back", () => {
    writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "pnpm test" } });

    const raw = readFileSync(join(repoDir, "argos.config.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('"name": "my-repo"');

    const config = readConfig(repoDir);
    expect(config.name).toBe("my-repo");
    expect(config.language).toBe("es");
  });

  it("reports whether a config file exists", () => {
    expect(hasConfig(repoDir)).toBe(false);
    writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "pnpm test" } });
    expect(hasConfig(repoDir)).toBe(true);
  });

  it("throws when writing an invalid config", () => {
    expect(() =>
      // @ts-expect-error intentionally invalid input for the runtime check
      writeConfig(repoDir, { qualityGate: { fast: "pnpm test" } }),
    ).toThrow();
  });
});
