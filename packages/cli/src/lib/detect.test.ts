import { describe, expect, it } from "vitest";
import {
  buildQualityGateFast,
  detectFramework,
  detectLibs,
  FRAMEWORK_DETECTORS,
  type PackageJsonShape,
} from "./detect.js";

describe("detectFramework", () => {
  it("returns undefined for an empty package.json (no deps at all)", () => {
    expect(detectFramework({})).toBeUndefined();
  });

  it("returns undefined when deps exist but none match a known framework", () => {
    expect(detectFramework({ dependencies: { lodash: "^4.0.0" } })).toBeUndefined();
  });

  it("honors FRAMEWORK_DETECTORS precedence — next wins over react when both are present", () => {
    const pkg: PackageJsonShape = { dependencies: { next: "^14.0.0", react: "^18.0.0" } };
    expect(detectFramework(pkg)).toBe("next");
    // Sanity: next really is declared before react in the detector list.
    expect(FRAMEWORK_DETECTORS.findIndex((d) => d.id === "next")).toBeLessThan(
      FRAMEWORK_DETECTORS.findIndex((d) => d.id === "react"),
    );
  });

  it("honors precedence — react wins over react-native when both are present", () => {
    const pkg: PackageJsonShape = { dependencies: { react: "^18.0.0", expo: "^50.0.0" } };
    expect(detectFramework(pkg)).toBe("react");
  });

  it("falls through to a later detector when earlier ones don't match", () => {
    const pkg: PackageJsonShape = { dependencies: { express: "^4.0.0" } };
    expect(detectFramework(pkg)).toBe("express");
  });

  it("matches a devDependency too, not just dependencies", () => {
    expect(detectFramework({ devDependencies: { astro: "^4.0.0" } })).toBe("astro");
  });
});

describe("detectLibs", () => {
  it("returns an empty array for an empty package.json", () => {
    expect(detectLibs({})).toEqual([]);
  });

  it("returns only the known libs present, ignoring unknown deps", () => {
    const pkg: PackageJsonShape = { dependencies: { zod: "^4.0.0", lodash: "^4.0.0", axios: "^1.0.0" } };
    expect(detectLibs(pkg)).toEqual(["axios", "zod"]);
  });
});

describe("buildQualityGateFast", () => {
  it("returns '' when no lint/typecheck/test scripts exist", () => {
    expect(buildQualityGateFast({ scripts: {} }, "pnpm")).toBe("");
    expect(buildQualityGateFast({}, "pnpm")).toBe("");
  });

  it("builds only the lint script when it's the only one present", () => {
    expect(buildQualityGateFast({ scripts: { lint: "eslint ." } }, "npm")).toBe("npm run lint");
  });

  it("builds only the typecheck script when it's the only one present", () => {
    expect(buildQualityGateFast({ scripts: { typecheck: "tsc --noEmit" } }, "pnpm")).toBe("pnpm typecheck");
  });

  it("builds only the test script when it's the only one present", () => {
    expect(buildQualityGateFast({ scripts: { test: "vitest run" } }, "yarn")).toBe("yarn test");
  });

  it("joins lint, typecheck, and test in that order when all three are present", () => {
    const scripts = { test: "vitest run", lint: "eslint .", typecheck: "tsc --noEmit" };
    expect(buildQualityGateFast({ scripts }, "pnpm")).toBe("pnpm lint && pnpm typecheck && pnpm test");
  });

  it("renders each package manager's run idiom", () => {
    const scripts = { lint: "eslint ." };
    expect(buildQualityGateFast({ scripts }, "pnpm")).toBe("pnpm lint");
    expect(buildQualityGateFast({ scripts }, "yarn")).toBe("yarn lint");
    expect(buildQualityGateFast({ scripts }, "bun")).toBe("bun run lint");
    expect(buildQualityGateFast({ scripts }, "npm")).toBe("npm run lint");
    // Unknown package managers fall back to the npm idiom.
    expect(buildQualityGateFast({ scripts }, "some-other-pm")).toBe("npm run lint");
  });
});
