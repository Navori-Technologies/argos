import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.js";

/**
 * Surgical merge of Argos's `hooks.PreToolUse` entries into
 * `~/.claude/settings.json` — the JSON analogue of the managed-block model
 * used for CLAUDE.md (see `lib/markers.ts`): Argos manages only its own
 * entries and leaves every other key, hook, and array position in the
 * user's file untouched.
 *
 * Ownership identification: a hook command is Argos-owned when it points at
 * a script under `.../hooks/argos-*` — `isArgosHookCommand` below is the
 * general check (any Argos hook), while the merge itself pins each entry to
 * ONE specific `scriptPath`, so re-running `argos init` updates the exact
 * same array slot instead of appending a duplicate.
 */

const ARGOS_HOOK_PATH_RE = /\/hooks\/argos-/;

/** True when a hook `command` string points at an Argos-owned script (`.../hooks/argos-*`). */
export function isArgosHookCommand(command: unknown): command is string {
  return typeof command === "string" && ARGOS_HOOK_PATH_RE.test(command);
}

export interface ArgosHookSpec {
  /** Absolute path to the installed hook script, e.g. `<claudeDir>/hooks/argos-guard-destructive.sh`. */
  scriptPath: string;
  /** Claude Code hook matcher, e.g. "Bash". */
  matcher: string;
  /** Hook timeout in seconds (Claude Code's own outer bound on the hook process). */
  timeout?: number;
  statusMessage?: string;
}

export type SettingsMergeStatus = "created" | "updated" | "unchanged" | "error";

export interface SettingsMergeResult {
  status: SettingsMergeStatus;
  detail?: string;
}

export interface MergeHooksOptions {
  /**
   * Script paths whose entries should be stripped out of `hooks.PreToolUse`
   * entirely (not overwritten with a new `specs` entry — REMOVED), wherever
   * they're found. Used by `argos init` for a hook whose script write just
   * failed: an entry pointing at a script that doesn't exist (or is broken)
   * is a dangling PreToolUse entry that hard-blocks every Bash call, whether
   * it was never written this run or used to work and just broke.
   */
  removeScriptPaths?: string[];
  /**
   * Test-only seam: invoked immediately before the pre-write mtime re-check
   * (see the concurrency guard below), so a test can simulate a concurrent
   * writer racing this merge — mutate `settingsPath` from inside the
   * callback, then let the merge proceed and observe it refuse. Never used
   * outside tests.
   */
  onBeforeWrite?: () => void;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function buildHookCommand(spec: ArgosHookSpec): Record<string, unknown> {
  const hook: Record<string, unknown> = { type: "command", command: `bash "${spec.scriptPath}"` };
  if (spec.timeout !== undefined) hook.timeout = spec.timeout;
  if (spec.statusMessage !== undefined) hook.statusMessage = spec.statusMessage;
  return hook;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Merge `specs` into `settingsPath` (normally `resolveClaudeDir()/settings.json`).
 *
 * - Missing file → starts from `{}` (created).
 * - An existing hook entry whose command already targets a spec's
 *   `scriptPath` → overwritten in place, at its current array index (never
 *   moved, never removed).
 * - No existing entry for a spec → appended into the first `PreToolUse`
 *   bucket whose `matcher` equals the spec's matcher, or a new bucket is
 *   pushed at the end of `PreToolUse` if none matches. Every other bucket,
 *   hook, and top-level key is left exactly as found.
 * - `options.removeScriptPaths` → any existing entry whose command targets
 *   one of those paths is stripped out entirely (not replaced) — for a hook
 *   whose script write just failed, so it never leaves a dangling entry.
 * - Corrupt JSON (unparsable, not an object, `hooks` present but not an
 *   object, or `hooks.PreToolUse` present but not an array) → returns
 *   `status: "error"` and writes NOTHING. Never clobber a file the caller
 *   can't safely reason about, and never silently discard a foreign `hooks`
 *   value just because its shape is unexpected.
 * - Concurrency guard: the file's mtime is captured at read time and
 *   re-checked immediately before the write; if it moved, someone else wrote
 *   settings.json in the meantime and this call refuses with `status:
 *   "error"` rather than silently clobbering that write (last-writer-wins).
 * - The write itself is atomic (temp file + rename, see
 *   lib/atomic-write.ts) — a crash mid-write can never leave settings.json
 *   torn, which would otherwise hard-block every subsequent Bash call.
 *
 * The file is always re-serialized with 2-space indentation on a write —
 * this normalizes the user's original formatting/whitespace, but every key
 * and value it did not own is preserved (structurally byte-identical
 * content, not necessarily byte-identical bytes).
 */
export function mergeHooksIntoSettings(
  settingsPath: string,
  specs: ArgosHookSpec[],
  options: MergeHooksOptions = {},
): SettingsMergeResult {
  const existed = existsSync(settingsPath);
  let raw = "{}";
  let mtimeAtRead: number | undefined;
  if (existed) {
    try {
      raw = readFileSync(settingsPath, "utf-8");
      mtimeAtRead = statSync(settingsPath).mtimeMs;
    } catch (err) {
      return { status: "error", detail: errorMessage(err) };
    }
  }

  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return { status: "error", detail: "settings.json existente no es un objeto JSON — arreglalo a mano." };
    }
    settings = parsed;
  } catch (err) {
    return {
      status: "error",
      detail: `settings.json existente tiene JSON inválido (${errorMessage(err)}) — arreglalo a mano y volvé a correr argos init.`,
    };
  }

  const before = JSON.stringify(settings);

  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    return {
      status: "error",
      detail: "settings.json tiene hooks que no es un objeto — arreglalo a mano.",
    };
  }
  const hooksRoot: Record<string, unknown> = isPlainObject(settings.hooks)
    ? (settings.hooks as Record<string, unknown>)
    : {};

  const preToolUseRaw = hooksRoot.PreToolUse;
  if (preToolUseRaw !== undefined && !Array.isArray(preToolUseRaw)) {
    return {
      status: "error",
      detail: "settings.json tiene hooks.PreToolUse que no es un array — arreglalo a mano.",
    };
  }
  const preToolUse: unknown[] = Array.isArray(preToolUseRaw) ? preToolUseRaw : [];

  const removeScriptPaths = options.removeScriptPaths ?? [];
  if (removeScriptPaths.length > 0) {
    for (const bucket of preToolUse) {
      if (!isPlainObject(bucket) || !Array.isArray(bucket.hooks)) continue;
      bucket.hooks = (bucket.hooks as unknown[]).filter(
        (h) => !(isPlainObject(h) && typeof h.command === "string" && removeScriptPaths.some((p) => h.command.includes(p))),
      );
    }
  }

  for (const spec of specs) {
    const desired = buildHookCommand(spec);

    // Find our own previous entry anywhere in PreToolUse (matched by
    // scriptPath), to update it in place without moving it.
    let found = false;
    for (const bucket of preToolUse) {
      if (!isPlainObject(bucket) || !Array.isArray(bucket.hooks)) continue;
      const bucketHooks = bucket.hooks as unknown[];
      const idx = bucketHooks.findIndex(
        (h) => isPlainObject(h) && typeof h.command === "string" && h.command.includes(spec.scriptPath),
      );
      if (idx >= 0) {
        bucketHooks[idx] = desired;
        found = true;
        break;
      }
    }

    if (!found) {
      let bucket = preToolUse.find(
        (b): b is Record<string, unknown> => isPlainObject(b) && b.matcher === spec.matcher && Array.isArray(b.hooks),
      );
      if (!bucket) {
        bucket = { matcher: spec.matcher, hooks: [] };
        preToolUse.push(bucket);
      }
      (bucket.hooks as unknown[]).push(desired);
    }
  }

  hooksRoot.PreToolUse = preToolUse;
  settings.hooks = hooksRoot;

  if (existed && JSON.stringify(settings) === before) {
    return { status: "unchanged" };
  }

  options.onBeforeWrite?.();

  // Cheap concurrency guard: this is a read-modify-write with no locking, so
  // re-stat the file right before writing and bail if its mtime moved since
  // we read it — someone else wrote settings.json in between, and a plain
  // last-writer-wins here would silently drop their change.
  if (existed && mtimeAtRead !== undefined) {
    let mtimeNow: number | undefined;
    try {
      mtimeNow = statSync(settingsPath).mtimeMs;
    } catch {
      mtimeNow = undefined;
    }
    if (mtimeNow !== undefined && mtimeNow !== mtimeAtRead) {
      return {
        status: "error",
        detail: "settings.json cambió durante el merge — reintenta.",
      };
    }
  }

  try {
    writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    return { status: "error", detail: errorMessage(err) };
  }

  return { status: existed ? "updated" : "created" };
}
