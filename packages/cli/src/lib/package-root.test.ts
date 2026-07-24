import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePackageRoot } from "./package-root.js";

const REAL_PACKAGE_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

describe("package.json packaging", () => {
  it("includes assets in the published files array", () => {
    const pkg = JSON.parse(readFileSync(REAL_PACKAGE_JSON_PATH, "utf-8")) as { files?: string[] };
    expect(pkg.files).toContain("assets");
  });
});

describe("resolvePackageRoot", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "argos-package-root-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("resolves the package root from a simulated installed (node_modules) layout with no src/", () => {
    // Mimic what actually ships to node_modules after `npm publish`: package.json,
    // assets/, and dist/ — but no src/, since it's excluded from `files`.
    writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "@argos/cli" }), "utf-8");
    mkdirSync(join(tempDir, "assets"), { recursive: true });
    writeFileSync(join(tempDir, "assets", "marker.txt"), "ok", "utf-8");
    mkdirSync(join(tempDir, "dist"), { recursive: true });
    writeFileSync(join(tempDir, "dist", "index.js"), "// built entrypoint\n", "utf-8");

    const fromUrl = pathToFileURL(join(tempDir, "dist", "index.js")).toString();
    expect(resolvePackageRoot(fromUrl)).toBe(tempDir);
  });

  it("throws a clear error when walk-up hits its limit without finding a package root", () => {
    let deepDir = tempDir;
    for (let i = 0; i < 10; i++) {
      deepDir = join(deepDir, `level-${i}`);
    }
    mkdirSync(deepDir, { recursive: true });

    const fromUrl = pathToFileURL(join(deepDir, "module.js")).toString();
    expect(() => resolvePackageRoot(fromUrl)).toThrow(/Could not resolve the @argos\/cli package root/);
  });
});
