import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkGitRepo, isGitRepo, parseIdentityFromRemote } from "./git.js";

describe("parseIdentityFromRemote", () => {
  it("parses an scp-style SSH remote URL", () => {
    expect(parseIdentityFromRemote("git@github.com:bonum/my-repo.git")).toBe("github.com-bonum");
  });

  it("parses an https remote URL", () => {
    expect(parseIdentityFromRemote("https://github.com/bonum/my-repo.git")).toBe("github.com-bonum");
  });

  it("parses an ssh:// URL form remote", () => {
    expect(parseIdentityFromRemote("ssh://git@gitlab.com/bonum/my-repo.git")).toBe("gitlab.com-bonum");
  });

  it("returns null for a malformed remote string, never throws", () => {
    expect(() => parseIdentityFromRemote("not a url at all")).not.toThrow();
    expect(parseIdentityFromRemote("not a url at all")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseIdentityFromRemote("")).toBeNull();
  });
});

describe("isGitRepo / checkGitRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-git-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is true for a real git working tree", () => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    expect(isGitRepo(dir)).toBe(true);
    expect(checkGitRepo(dir)).toEqual({ isRepo: true, gitMissing: false });
  });

  it("is false, with gitMissing=false, for a plain (non-git) directory", () => {
    expect(isGitRepo(dir)).toBe(false);
    expect(checkGitRepo(dir)).toEqual({ isRepo: false, gitMissing: false });
  });

  it.skipIf(process.platform === "win32")(
    "reports gitMissing=true when the git binary cannot be found on PATH",
    () => {
      const originalPath = process.env.PATH;
      process.env.PATH = "";
      try {
        const result = checkGitRepo(dir);
        expect(result.isRepo).toBe(false);
        expect(result.gitMissing).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    },
  );
});
