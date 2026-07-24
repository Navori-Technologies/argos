import { describe, expect, it } from "vitest";
import {
  buildQualityGateFast,
  DEP_SKILL_MAP,
  detectFramework,
  detectLibs,
  detectMappedSkills,
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

describe("detectMappedSkills", () => {
  it("returns an empty array when no mapped dep is present", () => {
    expect(detectMappedSkills({})).toEqual([]);
    expect(detectMappedSkills({ dependencies: { lodash: "^4.0.0" } })).toEqual([]);
  });

  it("maps a bare react dependency (no next) to react-19 only", () => {
    const pkg: PackageJsonShape = { dependencies: { react: "^18.0.0" } };
    expect(detectMappedSkills(pkg)).toEqual(["react-19"]);
  });

  it("maps next to both nextjs-15 and react-19, without a duplicate react-19 when react is also present", () => {
    const pkg: PackageJsonShape = { dependencies: { next: "^14.0.0", react: "^18.0.0" } };
    const mapped = detectMappedSkills(pkg);
    expect(mapped).toEqual(["nextjs-15", "react-19"]);
    expect(mapped.filter((id) => id === "react-19")).toHaveLength(1);
  });

  it("maps a multi-lib repo to each lib's skill(s), deduped, in DEP_SKILL_MAP declaration order", () => {
    const pkg: PackageJsonShape = {
      dependencies: {
        next: "^14.0.0",
        react: "^18.0.0",
        zod: "^3.0.0",
        tailwindcss: "^4.0.0",
        axios: "^1.0.0",
      },
    };
    expect(detectMappedSkills(pkg)).toEqual(["nextjs-15", "react-19", "tailwind-4", "zod-4", "axios"]);
  });

  it("matches a devDependency too, not just dependencies", () => {
    expect(detectMappedSkills({ devDependencies: { "@playwright/test": "^1.40.0" } })).toEqual(["playwright"]);
  });

  it("does not auto-map expo/react-native to not-boring-mobile (deliberate exclusion — style choice, not inferable)", () => {
    const pkg: PackageJsonShape = { dependencies: { expo: "^50.0.0", "react-native": "^0.73.0" } };
    expect(detectMappedSkills(pkg)).toEqual([]);
  });

  it("does not auto-map Python/Go stacks — package.json-only detection can't see them", () => {
    // django-drf, pytest, go-testing have no DEP_SKILL_MAP entry by design.
    expect(DEP_SKILL_MAP.some((e) => e.skills.includes("django-drf"))).toBe(false);
    expect(DEP_SKILL_MAP.some((e) => e.skills.includes("pytest"))).toBe(false);
    expect(DEP_SKILL_MAP.some((e) => e.skills.includes("go-testing"))).toBe(false);
  });

  it("maps react-router-dom (not just react-router) to react-router", () => {
    expect(detectMappedSkills({ dependencies: { "react-router-dom": "^6.0.0" } })).toEqual(["react-router"]);
  });

  it("maps both socket.io and socket.io-client to socketio without duplicating it", () => {
    const pkg: PackageJsonShape = { dependencies: { "socket.io": "^4.0.0", "socket.io-client": "^4.0.0" } };
    expect(detectMappedSkills(pkg)).toEqual(["socketio"]);
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
