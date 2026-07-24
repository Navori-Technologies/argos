import { describe, expect, it } from "vitest";
import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binPath = join(packageRoot, "bin/argos.js");

describe("bin/argos.js", () => {
  it("starts with a node shebang", () => {
    const firstLine = readFileSync(binPath, "utf8").split("\n")[0];
    expect(firstLine).toBe("#!/usr/bin/env node");
  });

  it("is executable on disk", () => {
    const mode = statSync(binPath).mode;
    // Owner, group, and other execute bits (0o111) must all be set so the
    // shipped file is directly invocable as `argos` after npm install.
    expect(mode & 0o111).toBe(0o111);
  });
});
