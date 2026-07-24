import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfig } from "../lib/config.js";
import { loadRegistry, saveRegistry, type WorkspaceRegistry } from "../lib/workspaces.js";
import { runWorkspaceAgents, runWorkspaceLink, runWorkspaceShow } from "./workspace.js";

function initGitRepo(dir: string, remoteUrl?: string): void {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  if (remoteUrl) {
    execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: dir });
  }
}

describe("commands/workspace", () => {
  let repoDir: string;
  let argosHome: string;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "argos-ws-cmd-repo-"));
    argosHome = mkdtempSync(join(tmpdir(), "argos-ws-cmd-home-"));
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(argosHome, { recursive: true, force: true });
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  describe("runWorkspaceLink", () => {
    it("errors when there is no argos.config.json yet", () => {
      initGitRepo(repoDir);
      const report = runWorkspaceLink({ cwd: repoDir });
      expect(report.exitCode).toBe(1);
      expect(report.error).toMatch(/argos.config.json/);
    });

    it("errors asking for an explicit name when nothing resolves", () => {
      initGitRepo(repoDir, "git@github.com:nowhere/repo.git");
      writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "true" } });
      const report = runWorkspaceLink({ cwd: repoDir });
      expect(report.exitCode).toBe(1);
      expect(report.error).toMatch(/nombre explícito/);
    });

    it("auto-detects the workspace via a remote match rule already in the registry", () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "true" } });
      const registry: WorkspaceRegistry = {
        bonum: { match: { remotes: ["github.com-bonum"], paths: [] }, repos: [] },
      };
      saveRegistry(registry);

      const report = runWorkspaceLink({ cwd: repoDir });

      expect(report.exitCode).toBe(0);
      expect(report.workspaceName).toBe("bonum");
      expect(report.action).toBe("added");
      const after = loadRegistry();
      expect(after.bonum?.repos).toEqual([{ name: "my-repo", path: expect.stringContaining("argos-ws-cmd-repo") }]);
    });

    it("creating a brand-new workspace via explicit name teaches it the repo's remote as a match rule", () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "true" } });

      const report = runWorkspaceLink({ cwd: repoDir, explicit: "bonum" });

      expect(report.exitCode).toBe(0);
      expect(report.createdWorkspace).toBe(true);
      expect(report.matchRuleAdded).toBe("github.com-bonum");
      const after = loadRegistry();
      expect(after.bonum?.match.remotes).toEqual(["github.com-bonum"]);
    });

    it("reports a clean structured error instead of throwing when workspaces.json is corrupt", () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "true" } });
      writeFileSync(join(argosHome, "workspaces.json"), "{ not valid json", "utf-8");

      const report = runWorkspaceLink({ cwd: repoDir });

      expect(report.exitCode).toBe(1);
      expect(report.error).toMatch(/corrupto/);
    });

    it("--force overwrites a name collision instead of refusing", () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "true" } });
      const otherRepoDir = mkdtempSync(join(tmpdir(), "argos-ws-cmd-other-"));
      try {
        // Seed a collision: same repo name ("my-repo"), different physical path.
        const registry: WorkspaceRegistry = {
          bonum: { match: { remotes: [], paths: [] }, repos: [{ name: "my-repo", path: otherRepoDir }] },
        };
        saveRegistry(registry);

        const refused = runWorkspaceLink({ cwd: repoDir, explicit: "bonum" });
        expect(refused.exitCode).toBe(1);

        const forced = runWorkspaceLink({ cwd: repoDir, explicit: "bonum", force: true });
        expect(forced.exitCode).toBe(0);
        expect(forced.action).toBe("updated-path");
      } finally {
        rmSync(otherRepoDir, { recursive: true, force: true });
      }
    });

    it("reports ambiguity listing candidates instead of guessing", () => {
      initGitRepo(repoDir, "git@github.com:bonum/my-repo.git");
      writeConfig(repoDir, { name: "my-repo", qualityGate: { fast: "true" } });
      const registry: WorkspaceRegistry = {
        a: { match: { remotes: ["bonum"], paths: [] }, repos: [] },
        b: { match: { remotes: ["bonum"], paths: [] }, repos: [] },
      };
      saveRegistry(registry);

      const report = runWorkspaceLink({ cwd: repoDir });

      expect(report.exitCode).toBe(1);
      expect(report.ambiguousCandidates?.sort()).toEqual(["a", "b"]);
    });
  });

  describe("runWorkspaceShow", () => {
    it("errors when the named workspace doesn't exist", () => {
      const report = runWorkspaceShow("nope");
      expect(report.exitCode).toBe(1);
      expect(report.error).toMatch(/no encontrado/);
    });

    it("lists all repos across all workspaces when no name is given", () => {
      const registry: WorkspaceRegistry = {
        bonum: { match: { remotes: [], paths: [] }, repos: [{ name: "webapp", path: "/repos/webapp" }] },
        personal: { match: { remotes: [], paths: [] }, repos: [{ name: "blog", path: "/repos/blog" }] },
      };
      saveRegistry(registry);

      const report = runWorkspaceShow(undefined, { pathExists: () => true });
      expect(report.exitCode).toBe(0);
      expect(report.rows).toHaveLength(2);
    });

    it("reports a clean structured error instead of throwing when workspaces.json is corrupt", () => {
      writeFileSync(join(argosHome, "workspaces.json"), "{ not valid json", "utf-8");

      const report = runWorkspaceShow(undefined, { pathExists: () => true });

      expect(report.exitCode).toBe(1);
      expect(report.error).toMatch(/corrupto/);
    });

    it("flags a repo whose registered path no longer exists on disk", () => {
      const registry: WorkspaceRegistry = {
        bonum: { match: { remotes: [], paths: [] }, repos: [{ name: "webapp", path: "/repos/webapp" }] },
      };
      saveRegistry(registry);

      const report = runWorkspaceShow("bonum", { pathExists: () => false });
      expect(report.exitCode).toBe(0);
      expect(report.rows[0]).toEqual({
        workspace: "bonum",
        name: "webapp",
        path: "/repos/webapp",
        missing: true,
      });
    });
  });

  describe("runWorkspaceAgents", () => {
    it("errors when the workspace doesn't exist", () => {
      const result = runWorkspaceAgents("nope");
      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe("workspace-not-found");
    });

    it("preview mode never spawns and never even consults hasBinary", () => {
      const registry: WorkspaceRegistry = {
        bonum: { match: { remotes: [], paths: [] }, repos: [{ name: "webapp", path: "/repos/webapp" }] },
      };
      saveRegistry(registry);
      const runner = vi.fn();
      const checkBinary = vi.fn(() => false);

      const result = runWorkspaceAgents("bonum", {
        apply: false,
        runner: runner as never,
        hasBinary: checkBinary,
        pathExists: () => true,
      });

      expect(result.preview).toBe(true);
      expect(runner).not.toHaveBeenCalled();
      expect(checkBinary).not.toHaveBeenCalled();
      expect(result.rows[0]?.status).toBe("would-create");
    });

    it("--apply is gated on the openclaw binary and never calls the runner when it's missing", () => {
      const registry: WorkspaceRegistry = {
        bonum: { match: { remotes: [], paths: [] }, repos: [{ name: "webapp", path: "/repos/webapp" }] },
      };
      saveRegistry(registry);
      const runner = vi.fn();

      const result = runWorkspaceAgents("bonum", {
        apply: true,
        hasBinary: () => false,
        runner: runner as never,
      });

      expect(result.exitCode).toBe(1);
      expect(result.reason).toBe("binary-missing");
      expect(runner).not.toHaveBeenCalled();
    });

    it("reports an honest partial summary when one repo out of two fails", () => {
      const registry: WorkspaceRegistry = {
        bonum: {
          match: { remotes: [], paths: [] },
          repos: [
            { name: "webapp", path: "/repos/webapp" },
            { name: "api", path: "/repos/api" },
          ],
        },
      };
      saveRegistry(registry);
      const runner = vi.fn((agentName: string) =>
        agentName === "webapp"
          ? { outcome: "error" as const, detail: "boom" }
          : { outcome: "created" as const, detail: "" },
      );

      const result = runWorkspaceAgents("bonum", {
        apply: true,
        hasBinary: () => true,
        runner,
        pathExists: () => true,
      });

      expect(result.exitCode).toBe(1);
      expect(result.rows).toEqual([
        { name: "webapp", status: "error", detail: "boom" },
        { name: "api", status: "created", detail: "" },
      ]);
    });
  });
});
