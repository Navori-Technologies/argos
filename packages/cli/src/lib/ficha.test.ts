import { describe, expect, it } from "vitest";
import type { ArgosConfig } from "./config.js";
import { buildFichaContent, FICHA_BLOCK_ID } from "./ficha.js";
import { injectBlock, listBlocks } from "./markers.js";

function baseConfig(overrides: Partial<ArgosConfig> = {}): ArgosConfig {
  return {
    name: "my-repo",
    language: "es",
    branchBase: "main",
    qualityGate: { fast: "pnpm lint && pnpm test" },
    project: { criticalAreas: [], legacyPaths: [] },
    skills: ["verify-before-done", "review-diff"],
    ...overrides,
  };
}

describe("buildFichaContent", () => {
  it("includes the repo name, quality gate, branch base, workspace, and skills", () => {
    const content = buildFichaContent(baseConfig({ workspace: "bonum" }));

    expect(content).toContain("## Ficha del repo: my-repo");
    expect(content).toContain("`pnpm lint && pnpm test`");
    expect(content).toContain("`main`");
    expect(content).toContain("bonum");
    expect(content).toContain("verify-before-done, review-diff");
  });

  it("shows 'sin asignar' when workspace is unset", () => {
    expect(buildFichaContent(baseConfig())).toContain("sin asignar");
  });

  it("appends the full quality gate command when qualityGate.full is set", () => {
    const content = buildFichaContent(baseConfig({ qualityGate: { fast: "pnpm lint", full: "pnpm test:full" } }));
    expect(content).toContain("`pnpm lint (full: pnpm test:full)`");
  });

  it("includes an 'Áreas críticas' line only when criticalAreas/legacyPaths are non-empty", () => {
    const withoutAreas = buildFichaContent(baseConfig());
    expect(withoutAreas).not.toContain("Áreas críticas");

    const withAreas = buildFichaContent(
      baseConfig({ project: { criticalAreas: ["src/auth"], legacyPaths: ["src/legacy"] } }),
    );
    expect(withAreas).toContain("Áreas críticas: src/auth, src/legacy");
  });

  it("satisfies doctor's drift contract: the exact output survives a round trip through injectBlock unchanged", () => {
    // doctor.ts's checkRepo does `claudeMd.includes(buildFichaContent(config))` to detect
    // drift — so injecting this content must preserve it byte-for-byte inside the block.
    const config = baseConfig({ workspace: "bonum" });
    const fichaContent = buildFichaContent(config);

    const claudeMd = injectBlock("", FICHA_BLOCK_ID, "1.0.0", fichaContent);

    expect(claudeMd).toContain(fichaContent);
    expect(listBlocks(claudeMd)).toEqual([{ id: FICHA_BLOCK_ID, version: "1.0.0" }]);
  });
});
