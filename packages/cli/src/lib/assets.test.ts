import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAgentIds, listSkillFiles, listSkillIds, MANAGED_BLOCK_IDS, readAsset, resolveAssetsDir } from "./assets.js";

describe("assets.ts", () => {
  let packageRoot: string;

  beforeEach(() => {
    packageRoot = mkdtempSync(join(tmpdir(), "argos-assets-"));
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@argos/cli" }), "utf-8");
    mkdirSync(join(packageRoot, "assets", "managed"), { recursive: true });
    mkdirSync(join(packageRoot, "assets", "agents"), { recursive: true });
    mkdirSync(join(packageRoot, "assets", "skills", "verify-before-done"), { recursive: true });
    mkdirSync(join(packageRoot, "assets", "skills", "review-diff"), { recursive: true });
    writeFileSync(join(packageRoot, "assets", "managed", "identidad.md"), "Identity content.\n", "utf-8");
    writeFileSync(join(packageRoot, "assets", "agents", "explorer.md"), "Explorer.\n", "utf-8");
    writeFileSync(join(packageRoot, "assets", "agents", "b-agent.md"), "B agent.\n", "utf-8");
    writeFileSync(
      join(packageRoot, "assets", "skills", "verify-before-done", "SKILL.md"),
      "Verify.\n",
      "utf-8",
    );
    writeFileSync(join(packageRoot, "assets", "skills", "review-diff", "SKILL.md"), "Review.\n", "utf-8");
  });

  afterEach(() => {
    rmSync(packageRoot, { recursive: true, force: true });
  });

  it("MANAGED_BLOCK_IDS has the 5 expected block ids in rendering order", () => {
    expect(MANAGED_BLOCK_IDS).toEqual([
      "identidad",
      "formato-respuesta",
      "aterrizaje",
      "orquestacion",
      "operaciones-seguras",
    ]);
  });

  it("resolveAssetsDir resolves to <packageRoot>/assets", () => {
    const fromUrl = pathToFileURL(join(packageRoot, "dist", "index.js")).toString();
    expect(resolveAssetsDir(fromUrl)).toBe(join(packageRoot, "assets"));
  });

  it("readAsset reads a text asset relative to the assets dir", () => {
    const assetsDir = join(packageRoot, "assets");
    expect(readAsset(assetsDir, "managed", "identidad.md")).toBe("Identity content.\n");
  });

  it("listAgentIds lists .md basenames under assets/agents, sorted", () => {
    const assetsDir = join(packageRoot, "assets");
    expect(listAgentIds(assetsDir)).toEqual(["b-agent", "explorer"]);
  });

  it("listSkillIds lists directory names under assets/skills, sorted", () => {
    const assetsDir = join(packageRoot, "assets");
    expect(listSkillIds(assetsDir)).toEqual(["review-diff", "verify-before-done"]);
  });

  it("listSkillFiles lists just SKILL.md for a skill with no supporting files", () => {
    const assetsDir = join(packageRoot, "assets");
    expect(listSkillFiles(assetsDir, "verify-before-done")).toEqual(["SKILL.md"]);
  });

  it("listSkillFiles recursively lists supporting files under subdirectories, sorted, with forward slashes", () => {
    const assetsDir = join(packageRoot, "assets");
    mkdirSync(join(assetsDir, "skills", "review-diff", "references"), { recursive: true });
    mkdirSync(join(assetsDir, "skills", "review-diff", "phases"), { recursive: true });
    writeFileSync(join(assetsDir, "skills", "review-diff", "references", "core.md"), "Core.\n", "utf-8");
    writeFileSync(join(assetsDir, "skills", "review-diff", "phases", "0-start.md"), "Start.\n", "utf-8");

    expect(listSkillFiles(assetsDir, "review-diff")).toEqual([
      "SKILL.md",
      "phases/0-start.md",
      "references/core.md",
    ]);
  });
});
