import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCliVersion } from "./version.js";

const REAL_PACKAGE_JSON_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

describe("readCliVersion", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-version-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads the real @argos/cli package.json version by default", () => {
    const pkg = JSON.parse(readFileSync(REAL_PACKAGE_JSON_PATH, "utf-8")) as { version: string };
    expect(readCliVersion()).toBe(pkg.version);
  });

  it("falls back to '0.0.0' when the package root can't be resolved at all", () => {
    // No package.json/assets anywhere up the walk from this fromUrl → resolvePackageRoot
    // throws internally, and readCliVersion swallows it into the "0.0.0" fallback.
    const fromUrl = pathToFileURL(join(dir, "module.js")).toString();
    expect(readCliVersion(fromUrl)).toBe("0.0.0");
  });
});
