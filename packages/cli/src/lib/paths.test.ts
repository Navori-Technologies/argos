import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveArgosHome, resolveClaudeDir } from "./paths.js";

describe("resolveArgosHome", () => {
  const original = process.env.ARGOS_HOME;

  afterEach(() => {
    if (original === undefined) delete process.env.ARGOS_HOME;
    else process.env.ARGOS_HOME = original;
  });

  it("defaults to ~/.argos", () => {
    delete process.env.ARGOS_HOME;
    expect(resolveArgosHome()).toBe(join(homedir(), ".argos"));
  });

  it("honors the ARGOS_HOME env override", () => {
    process.env.ARGOS_HOME = "/tmp/custom-argos-home";
    expect(resolveArgosHome()).toBe("/tmp/custom-argos-home");
  });
});

describe("resolveClaudeDir", () => {
  const original = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = original;
  });

  it("defaults to ~/.claude", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeDir()).toBe(join(homedir(), ".claude"));
  });

  it("honors the CLAUDE_CONFIG_DIR env override", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude-dir";
    expect(resolveClaudeDir()).toBe("/tmp/custom-claude-dir");
  });
});
