import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ArgosHookSpec, isArgosHookCommand, mergeHooksIntoSettings } from "./settings-merge.js";

describe("isArgosHookCommand", () => {
  it("is true for a command targeting a /hooks/argos-* script", () => {
    expect(isArgosHookCommand('bash "/home/x/.claude/hooks/argos-guard-destructive.sh"')).toBe(true);
  });

  it("is false for a foreign hook command", () => {
    expect(isArgosHookCommand('bash "/home/x/.claude/hooks/my-own-hook.sh"')).toBe(false);
  });

  it("is false for a non-string value", () => {
    expect(isArgosHookCommand(undefined)).toBe(false);
    expect(isArgosHookCommand(42)).toBe(false);
  });
});

describe("mergeHooksIntoSettings", () => {
  let dir: string;
  let settingsPath: string;
  let guardScript: string;
  let gateScript: string;
  let specs: ArgosHookSpec[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-settings-merge-"));
    settingsPath = join(dir, "settings.json");
    guardScript = join(dir, "hooks", "argos-guard-destructive.sh");
    gateScript = join(dir, "hooks", "argos-quality-gate.sh");
    specs = [
      { scriptPath: guardScript, matcher: "Bash", timeout: 10, statusMessage: "argos: guard-destructive" },
      { scriptPath: gateScript, matcher: "Bash", timeout: 600, statusMessage: "argos: quality-gate" },
    ];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates settings.json from scratch with both hook entries", () => {
    const result = mergeHooksIntoSettings(settingsPath, specs);

    expect(result.status).toBe("created");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const commands = written.hooks.PreToolUse.flatMap((b) => b.hooks.map((h) => h.command));
    expect(commands).toEqual([`bash "${guardScript}"`, `bash "${gateScript}"`]);
  });

  it("is idempotent — a second run with identical specs reports unchanged", () => {
    mergeHooksIntoSettings(settingsPath, specs);
    const before = readFileSync(settingsPath, "utf-8");

    const second = mergeHooksIntoSettings(settingsPath, specs);

    expect(second.status).toBe("unchanged");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("updates an argos entry in place (same slot) when its timeout changes, without reordering", () => {
    mergeHooksIntoSettings(settingsPath, specs);

    const bumped: ArgosHookSpec[] = [
      { ...specs[0]!, timeout: 20 },
      specs[1]!,
    ];
    const result = mergeHooksIntoSettings(settingsPath, bumped);

    expect(result.status).toBe("updated");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string; timeout: number }> }> };
    };
    const allHooks = written.hooks.PreToolUse.flatMap((b) => b.hooks);
    const guardHook = allHooks.find((h) => h.command.includes("argos-guard-destructive"));
    expect(guardHook?.timeout).toBe(20);
    // Still exactly 2 hook entries — updated in place, not appended as a 3rd.
    expect(allHooks).toHaveLength(2);
  });

  it("preserves foreign hooks.PreToolUse entries exactly — never removed or reordered", () => {
    const foreign = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "echo foreign-first" }] },
          { matcher: "Write", hooks: [{ type: "command", command: "echo foreign-write-hook" }] },
        ],
      },
      permissions: { allow: ["Read(**)"] },
      someUnknownTopLevelKey: { nested: true },
    };
    writeFileSync(settingsPath, JSON.stringify(foreign, null, 2), "utf-8");

    const result = mergeHooksIntoSettings(settingsPath, specs);

    expect(result.status).toBe("updated");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
      permissions: { allow: string[] };
      someUnknownTopLevelKey: { nested: boolean };
    };

    // Foreign top-level keys untouched.
    expect(written.permissions).toEqual({ allow: ["Read(**)"] });
    expect(written.someUnknownTopLevelKey).toEqual({ nested: true });

    // Foreign PreToolUse bucket order preserved, foreign hook untouched...
    expect(written.hooks.PreToolUse[0]!.matcher).toBe("Bash");
    expect(written.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("echo foreign-first");
    expect(written.hooks.PreToolUse[1]!.matcher).toBe("Write");
    expect(written.hooks.PreToolUse[1]!.hooks[0]!.command).toBe("echo foreign-write-hook");

    // ...and argos's own 2 hooks appended into the existing "Bash" bucket
    // (found by matcher), right after the foreign one — never a new
    // duplicate "Bash" bucket, never reordering the foreign entry.
    const bashBucket = written.hooks.PreToolUse[0]!;
    expect(bashBucket.hooks.map((h) => h.command)).toEqual([
      "echo foreign-first",
      `bash "${guardScript}"`,
      `bash "${gateScript}"`,
    ]);
  });

  it("re-serializes with 2-space indentation, normalizing formatting but preserving content", () => {
    writeFileSync(settingsPath, '{"permissions":{"allow":["Read(**)"]}}', "utf-8");

    mergeHooksIntoSettings(settingsPath, specs);

    const raw = readFileSync(settingsPath, "utf-8");
    expect(raw).toContain('{\n  "permissions"');
    expect(JSON.parse(raw)).toMatchObject({ permissions: { allow: ["Read(**)"] } });
  });

  it("refuses to write and reports an error when settings.json has invalid JSON", () => {
    writeFileSync(settingsPath, "{ not valid json", "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = mergeHooksIntoSettings(settingsPath, specs);

    expect(result.status).toBe("error");
    expect(result.detail).toBeTruthy();
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("refuses to write when settings.json's top level is not an object", () => {
    writeFileSync(settingsPath, "[1, 2, 3]", "utf-8");

    const result = mergeHooksIntoSettings(settingsPath, specs);

    expect(result.status).toBe("error");
    expect(readFileSync(settingsPath, "utf-8")).toBe("[1, 2, 3]");
  });

  it("refuses to write when hooks.PreToolUse exists but isn't an array", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: "not-an-array" } }), "utf-8");

    const result = mergeHooksIntoSettings(settingsPath, specs);

    expect(result.status).toBe("error");
  });

  it("treats a present-but-empty settings.json as an empty object (not corrupt)", () => {
    writeFileSync(settingsPath, "", "utf-8");

    const result = mergeHooksIntoSettings(settingsPath, specs);

    // The file already existed (empty) → "updated", not "created" — same
    // created/updated convention as writeManagedFile.
    expect(result.status).toBe("updated");
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toHaveProperty("hooks.PreToolUse");
  });

  it("removeScriptPaths strips out a stale entry instead of leaving it dangling", () => {
    mergeHooksIntoSettings(settingsPath, specs); // seed both entries, as a prior successful run would

    // Simulate the gate script breaking on a later run: only re-assert the
    // guard hook, and ask for the gate's stale entry to be removed.
    const result = mergeHooksIntoSettings(settingsPath, [specs[0] as ArgosHookSpec], {
      removeScriptPaths: [gateScript],
    });

    expect(result.status).toBe("updated");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const commands = written.hooks.PreToolUse.flatMap((b) => b.hooks.map((h) => h.command));
    expect(commands.some((c) => c.includes("argos-guard-destructive.sh"))).toBe(true);
    expect(commands.some((c) => c.includes("argos-quality-gate.sh"))).toBe(false);
  });

  it("leaves no .tmp file behind after a write", () => {
    mergeHooksIntoSettings(settingsPath, specs);
    const residue = readdirSync(dirname(settingsPath)).filter((f) => f.includes(".tmp"));
    expect(residue).toEqual([]);
  });

  it("refuses to write and reports an error when hooks is present but not a plain object", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: "not-an-object" }), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = mergeHooksIntoSettings(settingsPath, specs);

    expect(result.status).toBe("error");
    expect(result.detail).toBeTruthy();
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("refuses to write when hooks is an array instead of an object", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: [] }), "utf-8");

    const result = mergeHooksIntoSettings(settingsPath, specs);

    expect(result.status).toBe("error");
  });

  it("refuses with a clear message when settings.json changed concurrently between read and write", () => {
    mergeHooksIntoSettings(settingsPath, [specs[0] as ArgosHookSpec]); // seed a first entry

    const result = mergeHooksIntoSettings(settingsPath, specs, {
      onBeforeWrite: () => {
        // Simulate a concurrent writer racing this merge: touch the file
        // with different content right before the guard re-stats it.
        writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read(**)"] } }, null, 2), "utf-8");
      },
    });

    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/cambió durante el merge/);
    // The concurrent writer's content survives — we never clobbered it.
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ permissions: { allow: ["Read(**)"] } });
  });
});
