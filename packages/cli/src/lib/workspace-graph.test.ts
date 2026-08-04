import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfig } from "./config.js";
import type { GraphifyCliResult } from "./graphify-plugin.js";
import {
  discoverGraphRepos,
  resolveWorkspaceRoot,
  runWorkspaceGraph,
  shouldTriggerWorkspaceGraph,
  triggerWorkspaceGraphBackground,
  writeWorkspaceGraphStamp,
  type WorkspaceGraphRunner,
} from "./workspace-graph.js";
import type { WorkspaceRegistry } from "./workspaces.js";

function ok(stdout = ""): GraphifyCliResult {
  return { status: 0, stdout, stderr: "" };
}

function failure(stderr: string, status = 1): GraphifyCliResult {
  return { status, stdout: "", stderr };
}

function enoent(): GraphifyCliResult {
  return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
}

/** Writes `<dir>/graphify-out/graph.json`, marking `dir` as a discoverable graph repo. */
function makeGraphRepo(dir: string): void {
  const outDir = join(dir, "graphify-out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "graph.json"), "{}", "utf-8");
}

describe("resolveWorkspaceRoot", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "argos-wsg-root-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves via explicit name to the repos' common parent", () => {
    const registry: WorkspaceRegistry = {
      bonum: {
        match: { remotes: [], paths: [] },
        repos: [
          { name: "a", path: join(root, "a") },
          { name: "b", path: join(root, "b") },
        ],
      },
    };
    const result = resolveWorkspaceRoot("bonum", "/nonexistent", registry);
    expect(result).toEqual({ kind: "resolved", root, workspaceName: "bonum" });
  });

  it("reports workspace-not-found for an unregistered name", () => {
    const result = resolveWorkspaceRoot("ghost", "/nonexistent", {});
    expect(result).toEqual({ kind: "workspace-not-found", name: "ghost" });
  });

  it("reports workspace-empty when the workspace has no repos", () => {
    const registry: WorkspaceRegistry = { empty: { match: { remotes: [], paths: [] }, repos: [] } };
    const result = resolveWorkspaceRoot("empty", "/nonexistent", registry);
    expect(result).toEqual({ kind: "workspace-empty", name: "empty" });
  });

  it("reports workspace-dispersed when repos live under different parents", () => {
    const registry: WorkspaceRegistry = {
      scattered: {
        match: { remotes: [], paths: [] },
        repos: [
          { name: "a", path: "/one/a" },
          { name: "b", path: "/two/b" },
        ],
      },
    };
    const result = resolveWorkspaceRoot("scattered", "/nonexistent", registry);
    expect(result.kind).toBe("workspace-dispersed");
    if (result.kind === "workspace-dispersed") {
      expect(result.parents.sort()).toEqual(["/one", "/two"]);
    }
  });

  it("resolves from cwd via argos.config.json#workspace when no name is passed", () => {
    const repoDir = join(root, "myrepo");
    mkdirSync(repoDir, { recursive: true });
    writeConfig(repoDir, { name: "myrepo", workspace: "bonum", qualityGate: { fast: "true" } });
    const registry: WorkspaceRegistry = {
      bonum: {
        match: { remotes: [], paths: [] },
        repos: [
          { name: "a", path: join(root, "a") },
          { name: "b", path: join(root, "b") },
        ],
      },
    };
    const result = resolveWorkspaceRoot(undefined, repoDir, registry);
    expect(result).toEqual({ kind: "resolved", root, workspaceName: "bonum" });
  });

  it("reports unresolved when no name is passed and cwd's workspace can't be determined", () => {
    const repoDir = join(root, "myrepo");
    mkdirSync(repoDir, { recursive: true });
    const result = resolveWorkspaceRoot(undefined, repoDir, {});
    expect(result).toEqual({ kind: "unresolved" });
  });
});

describe("discoverGraphRepos", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "argos-wsg-discover-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds only immediate subdirectories carrying graphify-out/graph.json", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    mkdirSync(join(root, "no-graph"));
    writeFileSync(join(root, "a-file.txt"), "x");

    const repos = discoverGraphRepos(root);
    expect(repos.map((r) => r.name)).toEqual(["repo-a", "repo-b"]);
  });

  it("returns an empty list for a missing root", () => {
    expect(discoverGraphRepos(join(root, "does-not-exist"))).toEqual([]);
  });
});

describe("runWorkspaceGraph", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "argos-wsg-run-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function registryFor(root: string): WorkspaceRegistry {
    return {
      bonum: {
        match: { remotes: [], paths: [] },
        repos: [
          { name: "repo-a", path: join(root, "repo-a") },
          { name: "repo-b", path: join(root, "repo-b") },
        ],
      },
    };
  }

  it("errors with insufficient-repos when fewer than 2 repos have a graph", () => {
    makeGraphRepo(join(root, "repo-a"));
    mkdirSync(join(root, "repo-b"), { recursive: true });
    const report = runWorkspaceGraph({ cwd: root, name: "bonum", registry: registryFor(root) });
    expect(report.exitCode).toBe(1);
    expect(report.reason).toBe("insufficient-repos");
  });

  it("dry-run reports the plan without spawning anything or touching the filesystem", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const runner = vi.fn<WorkspaceGraphRunner>();
    const report = runWorkspaceGraph({
      cwd: root,
      name: "bonum",
      registry: registryFor(root),
      dryRun: true,
      runner,
    });
    expect(report.exitCode).toBe(0);
    expect(report.dryRun).toBe(true);
    expect(report.planLines?.join("\n")).toMatch(/repo-a[\s\S]*repo-b/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("errors with graphify-missing without spawning anything when graphify isn't in PATH", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const runner = vi.fn<WorkspaceGraphRunner>();
    const report = runWorkspaceGraph({
      cwd: root,
      name: "bonum",
      registry: registryFor(root),
      hasBinary: () => false,
      runner,
    });
    expect(report.exitCode).toBe(1);
    expect(report.reason).toBe("graphify-missing");
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs update per repo, merge, and the bridge on the happy path", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const calls: Array<{ binary: string; args: string[] }> = [];
    const runner: WorkspaceGraphRunner = (binary, args) => {
      calls.push({ binary, args });
      return ok();
    };
    const report = runWorkspaceGraph({
      cwd: root,
      name: "bonum",
      registry: registryFor(root),
      hasBinary: () => true,
      runner,
    });
    expect(report.exitCode).toBe(0);
    expect(report.mergedGraphPath).toContain("merged-graph.json");
    expect(report.bridgeReportPath).toContain("bridge-report.md");
    expect(report.bridgeSkipped).toBeUndefined();

    const updateCalls = calls.filter((c) => c.args[0] === "update");
    expect(updateCalls).toHaveLength(2);
    const mergeCall = calls.find((c) => c.args[0] === "merge-graphs");
    expect(mergeCall?.args).toContain("--out");
    const bridgeCall = calls.find((c) => c.binary === "python3");
    expect(bridgeCall?.args).toContain("--graph");
    expect(bridgeCall?.args).toContain("--report");
  });

  it("skips the per-repo update when noUpdate is set", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const calls: string[][] = [];
    const runner: WorkspaceGraphRunner = (_binary, args) => {
      calls.push(args);
      return ok();
    };
    runWorkspaceGraph({ cwd: root, name: "bonum", registry: registryFor(root), hasBinary: () => true, runner, noUpdate: true });
    expect(calls.some((a) => a[0] === "update")).toBe(false);
  });

  it("tolerates a per-repo update failure and still merges", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const runner: WorkspaceGraphRunner = (_binary, args) => (args[0] === "update" ? failure("boom") : ok());
    const report = runWorkspaceGraph({ cwd: root, name: "bonum", registry: registryFor(root), hasBinary: () => true, runner });
    expect(report.exitCode).toBe(0);
    expect(report.mergedGraphPath).toBeDefined();
  });

  it("errors merge-failed when graphify merge-graphs exits non-zero", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const runner: WorkspaceGraphRunner = (_binary, args) => (args[0] === "merge-graphs" ? failure("merge exploded") : ok());
    const report = runWorkspaceGraph({ cwd: root, name: "bonum", registry: registryFor(root), hasBinary: () => true, runner });
    expect(report.exitCode).toBe(1);
    expect(report.reason).toBe("merge-failed");
    expect(report.error).toMatch(/merge exploded/);
  });

  it("degrades gracefully (exit 0, bridgeSkipped) when python3 is absent", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const runner: WorkspaceGraphRunner = () => ok();
    const report = runWorkspaceGraph({
      cwd: root,
      name: "bonum",
      registry: registryFor(root),
      hasBinary: (name) => name !== "python3",
      runner,
    });
    expect(report.exitCode).toBe(0);
    expect(report.bridgeSkipped).toBe(true);
    expect(report.bridgeWarning).toMatch(/python3/);
    expect(report.mergedGraphPath).toBeDefined();
  });

  it("degrades gracefully (exit 0, bridgeSkipped) when the bridge script itself fails", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const runner: WorkspaceGraphRunner = (binary, args) => (binary === "python3" ? enoent() : ok());
    const report = runWorkspaceGraph({ cwd: root, name: "bonum", registry: registryFor(root), hasBinary: () => true, runner });
    expect(report.exitCode).toBe(0);
    expect(report.bridgeSkipped).toBe(true);
    expect(report.bridgeWarning).toMatch(/bridge de contratos falló/);
  });

  it("uses <root>/blueprint/workspace-graph as out dir when it already exists", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    mkdirSync(join(root, "blueprint", "workspace-graph"), { recursive: true });
    const runner: WorkspaceGraphRunner = () => ok();
    const report = runWorkspaceGraph({ cwd: root, name: "bonum", registry: registryFor(root), hasBinary: () => true, runner });
    expect(report.outDir).toBe(join(root, "blueprint", "workspace-graph"));
  });

  it("respects an explicit --out override", () => {
    makeGraphRepo(join(root, "repo-a"));
    makeGraphRepo(join(root, "repo-b"));
    const runner: WorkspaceGraphRunner = () => ok();
    const customOut = join(root, "custom-out");
    const report = runWorkspaceGraph({
      cwd: root,
      name: "bonum",
      registry: registryFor(root),
      hasBinary: () => true,
      runner,
      out: customOut,
    });
    expect(report.outDir).toBe(customOut);
  });

  describe("bridge-graph.html (viz)", () => {
    // Mimics graphify merge-graphs actually writing a merged-graph.json (the
    // real runner shells out; here the injected runner does it directly so
    // the viz step downstream has something real to read).
    function runnerWritingMergedGraph(): WorkspaceGraphRunner {
      return (_binary, args) => {
        const outIdx = args.indexOf("--out");
        if (outIdx !== -1) {
          const mergedGraphPath = args[outIdx + 1] as string;
          writeFileSync(
            mergedGraphPath,
            JSON.stringify({
              nodes: [
                { id: "repo-a::foo", repo: "repo-a", label: "foo()" },
                { id: "repo-b::bar", repo: "repo-b", label: "bar()" },
              ],
              links: [
                { source: "repo-a::foo", target: "repo-b::bar", relation: "http_call", _origin: "bridge" },
              ],
            }),
            "utf-8",
          );
        }
        return ok();
      };
    }

    it("writes bridge-graph.html on the happy path", () => {
      makeGraphRepo(join(root, "repo-a"));
      makeGraphRepo(join(root, "repo-b"));
      const report = runWorkspaceGraph({
        cwd: root,
        name: "bonum",
        registry: registryFor(root),
        hasBinary: () => true,
        runner: runnerWritingMergedGraph(),
      });
      expect(report.exitCode).toBe(0);
      expect(report.bridgeVizPath).toBe(join(report.outDir as string, "bridge-graph.html"));
      expect(existsSync(report.bridgeVizPath as string)).toBe(true);
      const html = readFileSync(report.bridgeVizPath as string, "utf-8");
      expect(html).toContain("repo-a::foo");
      expect(html).toContain("bonum — bridge graph");
    });

    it("--no-viz (viz: false) skips generating bridge-graph.html", () => {
      makeGraphRepo(join(root, "repo-a"));
      makeGraphRepo(join(root, "repo-b"));
      const report = runWorkspaceGraph({
        cwd: root,
        name: "bonum",
        registry: registryFor(root),
        hasBinary: () => true,
        runner: runnerWritingMergedGraph(),
        viz: false,
      });
      expect(report.exitCode).toBe(0);
      expect(report.bridgeVizPath).toBeUndefined();
      expect(existsSync(join(report.outDir as string, "bridge-graph.html"))).toBe(false);
    });

    it("dry-run never generates bridge-graph.html", () => {
      makeGraphRepo(join(root, "repo-a"));
      makeGraphRepo(join(root, "repo-b"));
      const runner = vi.fn<WorkspaceGraphRunner>();
      const report = runWorkspaceGraph({
        cwd: root,
        name: "bonum",
        registry: registryFor(root),
        dryRun: true,
        runner,
      });
      expect(report.dryRun).toBe(true);
      expect(report.bridgeVizPath).toBeUndefined();
      expect(runner).not.toHaveBeenCalled();
    });
  });
});

describe("triggerWorkspaceGraphBackground / debounce", () => {
  let argosHome: string;
  let root: string;
  const originalArgosHome = process.env.ARGOS_HOME;

  beforeEach(() => {
    argosHome = mkdtempSync(join(tmpdir(), "argos-wsg-home-"));
    root = mkdtempSync(join(tmpdir(), "argos-wsg-trigger-root-"));
    process.env.ARGOS_HOME = argosHome;
  });

  afterEach(() => {
    rmSync(argosHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    if (originalArgosHome === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = originalArgosHome;
  });

  it("shouldTriggerWorkspaceGraph is true when there's no prior stamp", () => {
    expect(shouldTriggerWorkspaceGraph(root)).toBe(true);
  });

  it("shouldTriggerWorkspaceGraph is false right after a stamp is written, true after the debounce window", () => {
    let clock = 1_000_000;
    const now = () => clock;
    writeWorkspaceGraphStamp(root, now);
    expect(shouldTriggerWorkspaceGraph(root, now)).toBe(false);
    clock += 11 * 60 * 1000;
    expect(shouldTriggerWorkspaceGraph(root, now)).toBe(true);
  });

  it("triggerWorkspaceGraphBackground spawns once and skips a second call within the debounce window", () => {
    let clock = 0;
    const now = () => clock;
    const spawn = vi.fn();

    const first = triggerWorkspaceGraphBackground(root, "bonum", { spawn, now });
    expect(first).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(root, "bonum");

    const second = triggerWorkspaceGraphBackground(root, "bonum", { spawn, now });
    expect(second).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);

    clock += 11 * 60 * 1000;
    const third = triggerWorkspaceGraphBackground(root, "bonum", { spawn, now });
    expect(third).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("stamp is per-root: a different root is unaffected by another root's trigger", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "argos-wsg-other-root-"));
    try {
      const spawn = vi.fn();
      triggerWorkspaceGraphBackground(root, "bonum", { spawn, now: () => 0 });
      expect(shouldTriggerWorkspaceGraph(otherRoot)).toBe(true);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });
});
