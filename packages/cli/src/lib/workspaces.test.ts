import { mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addRemoteMatchRule,
  linkRepo,
  loadRegistry,
  offerMatchRule,
  resolveWorkspaceForRepo,
  RegistryError,
  saveRegistry,
  WorkspaceNameCollisionError,
  type WorkspaceRegistry,
} from "./workspaces.js";

describe("lib/workspaces", () => {
  let argosHome: string;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    argosHome = mkdtempSync(join(tmpdir(), "argos-workspaces-home-"));
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(argosHome, { recursive: true, force: true });
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  describe("loadRegistry / saveRegistry", () => {
    it("returns {} when workspaces.json doesn't exist yet", () => {
      expect(loadRegistry()).toEqual({});
    });

    it("round-trips a saved registry", () => {
      const registry: WorkspaceRegistry = {
        bonum: { match: { remotes: ["github.com-bonum"], paths: [] }, repos: [] },
      };
      saveRegistry(registry);
      expect(loadRegistry()).toEqual(registry);
    });

    it("leaves no .tmp file behind after saveRegistry", () => {
      saveRegistry({ bonum: { match: { remotes: [], paths: [] }, repos: [] } });
      const residue = readdirSync(argosHome).filter((f) => f.includes(".tmp"));
      expect(residue).toEqual([]);
    });

    it("throws a RegistryError instead of a raw JSON parse error on a corrupt workspaces.json", () => {
      writeFileSync(join(argosHome, "workspaces.json"), "{ not valid json", "utf-8");
      expect(() => loadRegistry()).toThrow(RegistryError);
      expect(() => loadRegistry()).toThrow(/corrupto/);
    });
  });

  describe("resolveWorkspaceForRepo", () => {
    const registry: WorkspaceRegistry = {
      bonum: { match: { remotes: ["bonum"], paths: ["/Users/x/bonum"] }, repos: [] },
      personal: { match: { remotes: ["personal"], paths: [] }, repos: [] },
      "bonum-2": { match: { remotes: ["bonum"], paths: [] }, repos: [] },
    };

    it("explicit name wins over everything else", () => {
      const result = resolveWorkspaceForRepo(registry, {
        explicit: "personal",
        configWorkspace: "bonum",
        remoteUrl: "git@github.com:bonum/repo.git",
        repoPath: "/repos/x",
      });
      expect(result).toEqual({ kind: "resolved", name: "personal", source: "explicit" });
    });

    it("configWorkspace wins over match rules when no explicit name given", () => {
      const result = resolveWorkspaceForRepo(registry, {
        configWorkspace: "personal",
        remoteUrl: "git@github.com:bonum/repo.git",
        repoPath: "/repos/x",
      });
      expect(result).toEqual({ kind: "resolved", name: "personal", source: "config" });
    });

    it("falls back to a unique remote match rule", () => {
      const result = resolveWorkspaceForRepo(
        { personal: registry.personal as WorkspaceRegistry[string] },
        { remoteUrl: "git@github.com:personal/repo.git", repoPath: "/repos/x" },
      );
      expect(result).toEqual({ kind: "resolved", name: "personal", source: "match-remote" });
    });

    it("reports ambiguity when 2+ workspaces match the same remote", () => {
      const result = resolveWorkspaceForRepo(registry, {
        remoteUrl: "git@github.com:bonum/repo.git",
        repoPath: "/repos/x",
      });
      expect(result.kind).toBe("ambiguous");
      expect(result.kind === "ambiguous" && result.candidates.sort()).toEqual(["bonum", "bonum-2"]);
    });

    it("falls back to path match only when no remote rule matched anything", () => {
      const result = resolveWorkspaceForRepo(
        { bonum: registry.bonum as WorkspaceRegistry[string] },
        { remoteUrl: undefined, repoPath: "/Users/x/bonum/sub-repo" },
      );
      expect(result).toEqual({ kind: "resolved", name: "bonum", source: "match-path" });
    });

    it("supports glob patterns in path match rules", () => {
      const glob: WorkspaceRegistry = {
        work: { match: { remotes: [], paths: ["/Users/x/work-*"] }, repos: [] },
      };
      const result = resolveWorkspaceForRepo(glob, { repoPath: "/Users/x/work-repo1" });
      expect(result).toEqual({ kind: "resolved", name: "work", source: "match-path" });
    });

    it("returns unresolved when nothing matches", () => {
      const result = resolveWorkspaceForRepo(registry, {
        remoteUrl: "git@gitlab.com:someone-else/repo.git",
        repoPath: "/repos/nowhere",
      });
      expect(result).toEqual({ kind: "unresolved" });
    });
  });

  describe("linkRepo", () => {
    let repoDir: string;

    beforeEach(() => {
      repoDir = mkdtempSync(join(tmpdir(), "argos-workspaces-repo-"));
    });

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
    });

    it("creates the workspace on first link and adds the repo", () => {
      const result = linkRepo("bonum", { name: "webapp", path: repoDir });
      expect(result.createdWorkspace).toBe(true);
      expect(result.action).toBe("added");

      const registry = loadRegistry();
      expect(registry.bonum?.repos).toEqual([{ name: "webapp", path: realpathSync(repoDir) }]);
    });

    it("is idempotent when re-linking the same path", () => {
      linkRepo("bonum", { name: "webapp", path: repoDir });
      const second = linkRepo("bonum", { name: "webapp", path: repoDir });
      expect(second.createdWorkspace).toBe(false);
      expect(second.action).toBe("unchanged");
    });

    it("updates the path when re-linking a repo that moved (old path gone from disk)", () => {
      linkRepo("bonum", { name: "webapp", path: repoDir });
      const originalRealPath = realpathSync(repoDir);
      // Simulate the repo actually moving away — the old path no longer
      // exists on disk, so this must NOT be treated as a name collision.
      rmSync(repoDir, { recursive: true, force: true });
      const otherDir = mkdtempSync(join(tmpdir(), "argos-workspaces-repo2-"));
      try {
        const result = linkRepo("bonum", { name: "webapp", path: otherDir });
        expect(result.action).toBe("updated-path");
        expect(result.previousPath).toBe(originalRealPath);
        const registry = loadRegistry();
        expect(registry.bonum?.repos).toEqual([{ name: "webapp", path: realpathSync(otherDir) }]);
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it("refuses a name collision when the old path still exists on disk pointing at a different repo", () => {
      linkRepo("bonum", { name: "webapp", path: repoDir });
      const otherDir = mkdtempSync(join(tmpdir(), "argos-workspaces-repo2-"));
      try {
        expect(() => linkRepo("bonum", { name: "webapp", path: otherDir })).toThrow(WorkspaceNameCollisionError);
        try {
          linkRepo("bonum", { name: "webapp", path: otherDir });
        } catch (err) {
          expect(err).toBeInstanceOf(WorkspaceNameCollisionError);
          const collision = err as WorkspaceNameCollisionError;
          expect(collision.oldPath).toBe(realpathSync(repoDir));
          expect(collision.newPath).toBe(realpathSync(otherDir));
        }
        // Old entry left completely untouched — no silent eviction.
        const registry = loadRegistry();
        expect(registry.bonum?.repos).toEqual([{ name: "webapp", path: realpathSync(repoDir) }]);
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it("--force (options.force) overwrites a name collision instead of refusing", () => {
      linkRepo("bonum", { name: "webapp", path: repoDir });
      const otherDir = mkdtempSync(join(tmpdir(), "argos-workspaces-repo2-"));
      try {
        const result = linkRepo("bonum", { name: "webapp", path: otherDir }, { force: true });
        expect(result.action).toBe("updated-path");
        const registry = loadRegistry();
        expect(registry.bonum?.repos).toEqual([{ name: "webapp", path: realpathSync(otherDir) }]);
      } finally {
        rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it("normalizes a symlinked path to its real target", () => {
      const linkPath = join(tmpdir(), `argos-workspaces-symlink-${Date.now()}`);
      symlinkSync(repoDir, linkPath);
      try {
        linkRepo("bonum", { name: "webapp", path: linkPath });
        const registry = loadRegistry();
        expect(registry.bonum?.repos[0]?.path).toBe(realpathSync(repoDir));
      } finally {
        rmSync(linkPath, { force: true });
      }
    });

    it("throws when the repo directory doesn't exist on disk", () => {
      expect(() => linkRepo("bonum", { name: "webapp", path: "/no/such/dir" })).toThrow(/no existe/i);
    });
  });

  describe("offerMatchRule / addRemoteMatchRule", () => {
    it("offers to persist the remote identity for a brand-new explicit workspace", () => {
      const result = offerMatchRule({
        createdWorkspace: true,
        viaExplicitName: true,
        remoteUrl: "git@github.com:bonum/webapp.git",
        currentMatch: { remotes: [], paths: [] },
      });
      expect(result).toEqual({ shouldPersist: true, identity: "github.com-bonum" });
    });

    it("does not offer when the workspace already existed", () => {
      const result = offerMatchRule({
        createdWorkspace: false,
        viaExplicitName: true,
        remoteUrl: "git@github.com:bonum/webapp.git",
        currentMatch: { remotes: [], paths: [] },
      });
      expect(result.shouldPersist).toBe(false);
    });

    it("does not offer when the workspace was resolved via match rules, not an explicit name", () => {
      const result = offerMatchRule({
        createdWorkspace: true,
        viaExplicitName: false,
        remoteUrl: "git@github.com:bonum/webapp.git",
        currentMatch: { remotes: [], paths: [] },
      });
      expect(result.shouldPersist).toBe(false);
    });

    it("does not offer when there is no remote to learn from", () => {
      const result = offerMatchRule({
        createdWorkspace: true,
        viaExplicitName: true,
        remoteUrl: null,
        currentMatch: { remotes: [], paths: [] },
      });
      expect(result.shouldPersist).toBe(false);
    });

    it("does not re-offer an identity already recorded", () => {
      const result = offerMatchRule({
        createdWorkspace: true,
        viaExplicitName: true,
        remoteUrl: "git@github.com:bonum/webapp.git",
        currentMatch: { remotes: ["github.com-bonum"], paths: [] },
      });
      expect(result.shouldPersist).toBe(false);
    });

    it("addRemoteMatchRule persists the identity into the workspace's match.remotes", () => {
      linkAndSeed();
      addRemoteMatchRule("bonum", "github.com-bonum");
      const registry = loadRegistry();
      expect(registry.bonum?.match.remotes).toEqual(["github.com-bonum"]);
    });

    it("addRemoteMatchRule is a no-op for an unknown workspace", () => {
      addRemoteMatchRule("does-not-exist", "github.com-bonum");
      expect(loadRegistry()).toEqual({});
    });

    function linkAndSeed(): void {
      const registry: WorkspaceRegistry = { bonum: { match: { remotes: [], paths: [] }, repos: [] } };
      saveRegistry(registry);
    }
  });
});
