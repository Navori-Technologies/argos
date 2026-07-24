import { describe, expect, it } from "vitest";
import { isInteractive } from "./prompter.js";

describe("isInteractive", () => {
  it("is false when --yes is passed, even under a real TTY", () => {
    expect(isInteractive({ yes: true })).toBe(false);
  });

  it("reflects the real process TTY state when --yes isn't passed (false in this test runner, no TTY attached)", () => {
    // vitest never runs attached to a real TTY, so this is deterministic
    // across CI and local runs without needing to fake process.stdout/stdin.
    expect(isInteractive({})).toBe(process.stdout.isTTY === true && process.stdin.isTTY === true);
  });
});
