import { describe, it, expect, vi } from "vitest";
import {
  buildAgentName,
  buildOpenclawAddArgs,
  formatOpenclawAddCommand,
  classifyOpenclawAddResult,
  planWorkspaceAgents,
  runOpenclawAgentAdd,
  type OpenclawRunner,
  type OpenclawAddResult,
} from "./openclaw-agents.js";
import { spawnSync } from "node:child_process";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

describe("buildAgentName", () => {
  it("uses the repo name unprefixed by default", () => {
    expect(buildAgentName("webapp")).toBe("webapp");
  });

  it("prepends the prefix when given", () => {
    expect(buildAgentName("webapp", "bonum-")).toBe("bonum-webapp");
  });
});

describe("buildOpenclawAddArgs / formatOpenclawAddCommand", () => {
  it("builds the exact argv openclaw expects", () => {
    expect(buildOpenclawAddArgs("webapp", "/repos/webapp")).toEqual([
      "agents",
      "add",
      "webapp",
      "--workspace",
      "/repos/webapp",
      "--non-interactive",
    ]);
  });

  it("formats the human-readable preview command", () => {
    expect(formatOpenclawAddCommand("webapp", "/repos/webapp")).toBe(
      "openclaw agents add webapp --workspace /repos/webapp --non-interactive",
    );
  });
});

describe("classifyOpenclawAddResult", () => {
  it("classifies exit code 0 as created", () => {
    expect(classifyOpenclawAddResult(0, "agent added\n", "")).toEqual({
      outcome: "created",
      detail: "agent added",
    });
  });

  it("classifies a duplicate-agent stderr as exists", () => {
    expect(classifyOpenclawAddResult(1, "", "Error: agent 'webapp' already exists\n")).toEqual({
      outcome: "exists",
      detail: "Error: agent 'webapp' already exists",
    });
  });

  it("classifies 'already registered' wording as exists too", () => {
    expect(classifyOpenclawAddResult(1, "", "agent already registered")).toEqual({
      outcome: "exists",
      detail: "agent already registered",
    });
  });

  it("classifies any other non-zero exit as error", () => {
    expect(classifyOpenclawAddResult(2, "", "permission denied")).toEqual({
      outcome: "error",
      detail: "permission denied",
    });
  });

  it("falls back to a generic message when both streams are empty", () => {
    expect(classifyOpenclawAddResult(1, "", "")).toEqual({
      outcome: "error",
      detail: "openclaw exited with status 1",
    });
  });

  it("classifies 'name already in use' wording as exists", () => {
    expect(classifyOpenclawAddResult(1, "", "Error: name 'webapp' already in use")).toEqual({
      outcome: "exists",
      detail: "Error: name 'webapp' already in use",
    });
  });

  it("does NOT classify an unrelated bare 'duplicate' error as exists (regression)", () => {
    expect(classifyOpenclawAddResult(1, "", "duplicate key violation in database")).toEqual({
      outcome: "error",
      detail: "duplicate key violation in database",
    });
  });
});

describe("runOpenclawAgentAdd", () => {
  it("classifies an ETIMEDOUT spawnSync result as an error naming the stuck agent", () => {
    const mockedSpawnSync = vi.mocked(spawnSync);
    mockedSpawnSync.mockReturnValue({
      status: null,
      signal: null,
      pid: 1,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawnSync openclaw ETIMEDOUT"), { code: "ETIMEDOUT" }),
    } as unknown as ReturnType<typeof spawnSync>);

    const result = runOpenclawAgentAdd("webapp", "/repos/webapp");

    expect(result.outcome).toBe("error");
    expect(result.detail).toContain("webapp");
    expect(result.detail).toMatch(/timed out/i);
    expect(result.detail).toMatch(/interactive input/i);
  });
});

describe("planWorkspaceAgents", () => {
  const repos = [
    { name: "webapp", path: "/repos/webapp" },
    { name: "api", path: "/repos/api" },
  ];

  it("preview mode never calls the runner and reports the exact command per repo", () => {
    const runner = vi.fn() as unknown as OpenclawRunner;
    const rows = planWorkspaceAgents(repos, {
      preview: true,
      runner,
      pathExists: () => true,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(rows).toEqual([
      {
        name: "webapp",
        status: "would-create",
        detail: "openclaw agents add webapp --workspace /repos/webapp --non-interactive",
      },
      {
        name: "api",
        status: "would-create",
        detail: "openclaw agents add api --workspace /repos/api --non-interactive",
      },
    ]);
  });

  it("applies the prefix to the agent name used in the command", () => {
    const rows = planWorkspaceAgents(repos, {
      preview: true,
      prefix: "bonum-",
      pathExists: () => true,
    });
    expect(rows[0]?.detail).toContain("agents add bonum-webapp ");
  });

  it("marks a repo whose path is missing on disk as 'missing' and skips it", () => {
    const runner: OpenclawRunner = vi.fn(
      (): OpenclawAddResult => ({ outcome: "created", detail: "" }),
    );
    const rows = planWorkspaceAgents(repos, {
      preview: false,
      runner,
      pathExists: (path) => path !== "/repos/webapp",
    });
    expect(rows[0]).toEqual({ name: "webapp", status: "missing", detail: "/repos/webapp" });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("api", "/repos/api");
  });

  it("apply mode calls the runner per repo and continues past a per-repo failure", () => {
    const runner: OpenclawRunner = vi.fn(
      (agentName): OpenclawAddResult => {
        if (agentName === "webapp") return { outcome: "exists", detail: "already exists" };
        return { outcome: "created", detail: "" };
      },
    );
    const rows = planWorkspaceAgents(repos, { preview: false, runner, pathExists: () => true });
    expect(rows).toEqual([
      { name: "webapp", status: "exists", detail: "already exists" },
      { name: "api", status: "created", detail: "" },
    ]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("apply mode records 'error' without aborting the loop", () => {
    const runner: OpenclawRunner = vi.fn(
      (agentName): OpenclawAddResult => {
        if (agentName === "webapp") return { outcome: "error", detail: "permission denied" };
        return { outcome: "created", detail: "" };
      },
    );
    const rows = planWorkspaceAgents(repos, { preview: false, runner, pathExists: () => true });
    expect(rows[0]).toEqual({ name: "webapp", status: "error", detail: "permission denied" });
    expect(rows[1]).toEqual({ name: "api", status: "created", detail: "" });
  });
});
