import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasNaviorConfig, NAVORI_CONFIG_MAX_BYTES, readNaviorConfig } from "./navori-import.js";

describe("readNaviorConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-navori-import-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns { kind: 'absent' } when the file is missing", () => {
    expect(readNaviorConfig(dir)).toEqual({ kind: "absent" });
    expect(hasNaviorConfig(dir)).toBe(false);
  });

  it("returns { kind: 'imported', data } for a valid partial config", () => {
    writeFileSync(
      join(dir, "navori.config.json"),
      JSON.stringify({ name: "legacy-repo", workspace: "bonum" }),
      "utf-8",
    );

    const result = readNaviorConfig(dir);
    expect(result.kind).toBe("imported");
    if (result.kind === "imported") {
      expect(result.data.name).toBe("legacy-repo");
      expect(result.data.workspace).toBe("bonum");
    }
  });

  it("returns { kind: 'unreadable', error } for malformed JSON, never 'absent'", () => {
    writeFileSync(join(dir, "navori.config.json"), "{ not valid json ", "utf-8");

    const result = readNaviorConfig(dir);
    expect(result.kind).toBe("unreadable");
    if (result.kind === "unreadable") {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  it("returns { kind: 'unreadable' } for a JSON primitive (e.g. a bare string)", () => {
    writeFileSync(join(dir, "navori.config.json"), JSON.stringify("just a string"), "utf-8");

    const result = readNaviorConfig(dir);
    expect(result.kind).toBe("unreadable");
  });

  it("returns { kind: 'unreadable' } for a file over the size guard, without attempting to parse it", () => {
    const oversized = "x".repeat(NAVORI_CONFIG_MAX_BYTES + 1);
    writeFileSync(join(dir, "navori.config.json"), oversized, "utf-8");

    const result = readNaviorConfig(dir);
    expect(result.kind).toBe("unreadable");
    if (result.kind === "unreadable") {
      expect(result.error).toMatch(/tamaño|bytes|máximo/i);
    }
  });
});
