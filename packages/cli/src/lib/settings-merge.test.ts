import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDefaultModePolicy,
  applyOutputStylePolicy,
  type ArgosHookSpec,
  isArgosHookCommand,
  isNavoriOutputStyle,
  mergeHooksIntoSettings,
  removeAllArgosHooksFromSettings,
  removeDefaultModeIfAuto,
  removeOutputStyleIfArgos,
} from "./settings-merge.js";

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

describe("removeAllArgosHooksFromSettings", () => {
  let dir: string;
  let settingsPath: string;
  let hooksDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-settings-remove-"));
    settingsPath = join(dir, "settings.json");
    hooksDir = join(dir, "hooks");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not remove a foreign hook whose path substring-matches /hooks/argos- but is outside the resolved hooksDir", () => {
    // This path contains the literal substring "/hooks/argos-" (what the old
    // bare-regex ownership check matched on) but lives under `dir/my/hooks`,
    // NOT under the actual managed `hooksDir` (`dir/hooks`) — a user's own
    // hook that must never be treated as Argos-owned.
    const foreignScriptPath = join(dir, "my", "hooks", "argos-custom.sh");
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `bash "${foreignScriptPath}"` }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    const result = removeAllArgosHooksFromSettings(settingsPath, hooksDir);

    expect(result.status).toBe("unchanged");
    expect(result.removedCount).toBe(0);
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(written.hooks.PreToolUse[0]!.hooks[0]!.command).toBe(`bash "${foreignScriptPath}"`);
  });

  it("preserves a matcher bucket whose hooks include zero Argos-owned entries, even when another bucket does have entries removed", () => {
    const realArgosScriptPath = join(hooksDir, "argos-guard-destructive.sh");
    const foreignScriptPath = join(dir, "my", "hooks", "argos-custom.sh");
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: `bash "${realArgosScriptPath}"` }] },
          { matcher: "Write", hooks: [{ type: "command", command: `bash "${foreignScriptPath}"` }] },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

    const result = removeAllArgosHooksFromSettings(settingsPath, hooksDir);

    expect(result.status).toBe("removed");
    expect(result.removedCount).toBe(1);
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    // The real Argos hook's own bucket is gone — it only ever held that one entry.
    expect(written.hooks.PreToolUse.some((b) => b.matcher === "Bash")).toBe(false);
    // The foreign-only "Write" bucket survives untouched, with its hook intact.
    const writeBucket = written.hooks.PreToolUse.find((b) => b.matcher === "Write");
    expect(writeBucket?.hooks).toEqual([{ type: "command", command: `bash "${foreignScriptPath}"` }]);
  });
});

describe("isNavoriOutputStyle", () => {
  it("is true for the bare 'navori' value", () => {
    expect(isNavoriOutputStyle("navori")).toBe(true);
  });

  it("is true for a path-ish value whose FINAL segment is exactly navori.md", () => {
    expect(isNavoriOutputStyle("/home/x/.claude/output-styles/navori.md")).toBe(true);
    expect(isNavoriOutputStyle("output-styles\\navori.md")).toBe(true);
    expect(isNavoriOutputStyle("NAVORI.MD")).toBe(true); // extension case-insensitive
  });

  it("never false-positive-matches on substring — a user's own similarly-named voice is untouched", () => {
    expect(isNavoriOutputStyle("navori-fork")).toBe(false);
    expect(isNavoriOutputStyle("navori-team-voice")).toBe(false);
    expect(isNavoriOutputStyle("/home/x/.claude/output-styles/navori-fork.md")).toBe(false);
    expect(isNavoriOutputStyle("output-styles/navori")).toBe(false); // no .md extension — not an exact navori.md filename
  });

  it("is false for any other voice, and for non-string values", () => {
    expect(isNavoriOutputStyle("my-custom-voice")).toBe(false);
    expect(isNavoriOutputStyle("Argos")).toBe(false);
    expect(isNavoriOutputStyle(undefined)).toBe(false);
    expect(isNavoriOutputStyle(42)).toBe(false);
  });
});

describe("applyOutputStylePolicy", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-settings-outputstyle-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets outputStyle to Argos when the key is absent (missing file)", () => {
    const result = applyOutputStylePolicy(settingsPath);

    expect(result.status).toBe("created");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
    expect(written.outputStyle).toBe("Argos");
  });

  it("sets outputStyle to Argos when the key is absent from an existing file, preserving every other key", () => {
    writeFileSync(settingsPath, JSON.stringify({ foo: "bar" }, null, 2), "utf-8");

    const result = applyOutputStylePolicy(settingsPath);

    expect(result.status).toBe("created");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string; foo: string };
    expect(written.outputStyle).toBe("Argos");
    expect(written.foo).toBe("bar");
  });

  it("is unchanged when outputStyle is already Argos", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "Argos" }, null, 2), "utf-8");

    const result = applyOutputStylePolicy(settingsPath);

    expect(result.status).toBe("unchanged");
  });

  it("takes over a navori value by default (takeoverNavori unset = true)", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "navori" }, null, 2), "utf-8");

    const result = applyOutputStylePolicy(settingsPath);

    expect(result.status).toBe("updated");
    expect(result.detail).toContain("navori");
    expect(result.detail).toContain("Argos");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
    expect(written.outputStyle).toBe("Argos");
  });

  it("leaves a navori value untouched when takeoverNavori is false (declined)", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "navori" }, null, 2), "utf-8");

    const result = applyOutputStylePolicy(settingsPath, { takeoverNavori: false });

    expect(result.status).toBe("untouched");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
    expect(written.outputStyle).toBe("navori");
  });

  it("never touches a foreign (non-navori) voice, regardless of takeoverNavori", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "my-custom-voice" }, null, 2), "utf-8");

    const result = applyOutputStylePolicy(settingsPath, { takeoverNavori: true });

    expect(result.status).toBe("untouched");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
    expect(written.outputStyle).toBe("my-custom-voice");
  });

  it("returns status: error and writes nothing on corrupt JSON", () => {
    writeFileSync(settingsPath, "{ not json", "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyOutputStylePolicy(settingsPath);

    expect(result.status).toBe("error");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});

describe("removeOutputStyleIfArgos", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-settings-outputstyle-remove-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes outputStyle when it's exactly Argos, preserving every other key", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "Argos", foo: "bar" }, null, 2), "utf-8");

    const result = removeOutputStyleIfArgos(settingsPath);

    expect(result.status).toBe("removed");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle?: string; foo: string };
    expect(written.outputStyle).toBeUndefined();
    expect(written.foo).toBe("bar");
  });

  it("leaves a foreign (non-Argos) outputStyle untouched", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "my-custom-voice" }, null, 2), "utf-8");

    const result = removeOutputStyleIfArgos(settingsPath);

    expect(result.status).toBe("unchanged");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { outputStyle: string };
    expect(written.outputStyle).toBe("my-custom-voice");
  });

  it("is unchanged when the key is absent, or the file is missing", () => {
    expect(removeOutputStyleIfArgos(settingsPath).status).toBe("unchanged");

    writeFileSync(settingsPath, JSON.stringify({ foo: "bar" }, null, 2), "utf-8");
    expect(removeOutputStyleIfArgos(settingsPath).status).toBe("unchanged");
  });

  it("dryRun reports removed without writing anything", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "Argos" }, null, 2), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = removeOutputStyleIfArgos(settingsPath, { dryRun: true });

    expect(result.status).toBe("removed");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});

describe("applyDefaultModePolicy", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-settings-defaultmode-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Covers: R5, R6
  it("creates settings.json from scratch with permissions.defaultMode = auto when absent", () => {
    const result = applyDefaultModePolicy(settingsPath);

    expect(result.status).toBe("created");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { permissions: { defaultMode: string } };
    expect(written.permissions.defaultMode).toBe("auto");
  });

  // Covers: R5
  it("updates in place when permissions exists but defaultMode is absent", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read(**)"] } }, null, 2), "utf-8");

    const result = applyDefaultModePolicy(settingsPath);

    expect(result.status).toBe("updated");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      permissions: { allow: string[]; defaultMode: string };
    };
    expect(written.permissions.defaultMode).toBe("auto");
    // Foreign permissions.* keys untouched.
    expect(written.permissions.allow).toEqual(["Read(**)"]);
  });

  // Covers: R6
  it("is unchanged, no write, when defaultMode is already 'auto'", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: "auto" } }, null, 2), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyDefaultModePolicy(settingsPath);

    expect(result.status).toBe("unchanged");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  // Covers: R6
  it("never touches a foreign defaultMode value, reporting skipped-foreign with the current value", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }, null, 2), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyDefaultModePolicy(settingsPath);

    expect(result.status).toBe("skipped-foreign");
    expect(result.detail).toContain("bypassPermissions");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  // Covers: R5, R6
  it("refuses to write and reports an error when settings.json has invalid JSON", () => {
    writeFileSync(settingsPath, "{ not valid json", "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyDefaultModePolicy(settingsPath);

    expect(result.status).toBe("error");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  // Covers: R5, R6
  it("refuses with a clear message when settings.json changed concurrently between read and write (mtime guard)", () => {
    writeFileSync(settingsPath, JSON.stringify({ outputStyle: "Argos" }, null, 2), "utf-8"); // file must pre-exist for the mtime guard to engage
    const result = applyDefaultModePolicy(settingsPath, {
      onBeforeWrite: () => {
        writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read(**)"] } }, null, 2), "utf-8");
      },
    });

    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/cambió durante el merge/);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ permissions: { allow: ["Read(**)"] } });
  });

  // Covers: R5
  it("errors when permissions is not a plain object (e.g. an array), file left untouched", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: ["not", "an", "object"] }, null, 2), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = applyDefaultModePolicy(settingsPath);

    expect(result.status).toBe("error");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});

describe("removeDefaultModeIfAuto", () => {
  let dir: string;
  let settingsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-settings-remove-defaultmode-"));
    settingsPath = join(dir, "settings.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Covers: R10
  it("removes defaultMode (and the now-empty permissions object) only when it's exactly 'auto'", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: "auto" } }, null, 2), "utf-8");

    const result = removeDefaultModeIfAuto(settingsPath);

    expect(result.status).toBe("removed");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    expect(written.permissions).toBeUndefined();
  });

  // Covers: R10
  it("keeps the permissions object when other keys remain after removing defaultMode", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { defaultMode: "auto", allow: ["Read(**)"] } }, null, 2),
      "utf-8",
    );

    const result = removeDefaultModeIfAuto(settingsPath);

    expect(result.status).toBe("removed");
    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { permissions: { allow: string[] } };
    expect(written.permissions).toEqual({ allow: ["Read(**)"] });
  });

  // Covers: R10
  it("leaves a foreign (non-'auto') defaultMode value untouched", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: "plan" } }, null, 2), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = removeDefaultModeIfAuto(settingsPath);

    expect(result.status).toBe("unchanged");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  // Covers: R10
  it("leaves settings.json.enabledPlugins fully untouched (Engram is never removed by argos remove)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ permissions: { defaultMode: "auto" }, enabledPlugins: { "engram@engram": true } }, null, 2),
      "utf-8",
    );

    removeDefaultModeIfAuto(settingsPath);

    const written = JSON.parse(readFileSync(settingsPath, "utf-8")) as { enabledPlugins: Record<string, boolean> };
    expect(written.enabledPlugins).toEqual({ "engram@engram": true });
  });

  // Covers: R10
  it("is unchanged when the key is absent, or the file is missing", () => {
    expect(removeDefaultModeIfAuto(settingsPath).status).toBe("unchanged");

    writeFileSync(settingsPath, JSON.stringify({ permissions: {} }, null, 2), "utf-8");
    expect(removeDefaultModeIfAuto(settingsPath).status).toBe("unchanged");
  });

  // Covers: R10
  it("dryRun reports removed without writing anything", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { defaultMode: "auto" } }, null, 2), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = removeDefaultModeIfAuto(settingsPath, { dryRun: true });

    expect(result.status).toBe("removed");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  // Covers: R10
  // Deliberate asymmetry with applyDefaultModePolicy (see the test above named
  // "errors when permissions is not a plain object"): apply is a write path,
  // so a malformed `permissions` fails loud (`status: "error"`) rather than
  // silently skipping the write the operator asked for. remove is a cleanup
  // path — its job is "undo my own auto-mode write if it's still there" — so
  // a foreign/malformed `permissions` just means there's nothing of ours to
  // undo; it reports "unchanged" and leaves the file byte-identical rather
  // than erroring on a shape it didn't create and isn't asked to fix.
  it("is unchanged (not error) when permissions is not a plain object (e.g. a string), file left untouched", () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: "not-an-object" }, null, 2), "utf-8");
    const before = readFileSync(settingsPath, "utf-8");

    const result = removeDefaultModeIfAuto(settingsPath);

    expect(result.status).toBe("unchanged");
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });
});
