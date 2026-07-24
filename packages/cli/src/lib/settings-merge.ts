import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
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
const BASH_HOOK_COMMAND_RE = /^bash "(.+)"$/;
const ARGOS_HOOK_BASENAME_RE = /^argos-/;

/**
 * True when a hook `command` string points at an Argos-owned script (`.../hooks/argos-*`).
 *
 * This is a bare substring match — good enough for the non-destructive
 * `doctor` diagnostic that uses it, but NOT anchored to any real directory.
 * Destructive operations (deleting hook entries from the user's
 * settings.json) must use `isArgosOwnedHookCommand` below instead, which
 * requires the script to actually resolve inside the managed hooks
 * directory.
 */
export function isArgosHookCommand(command: unknown): command is string {
  return typeof command === "string" && ARGOS_HOOK_PATH_RE.test(command);
}

/** Extract the script path from Argos's own `bash "<scriptPath>"` hook command shape (see `buildHookCommand`). */
function extractBashScriptPath(command: string): string | undefined {
  return BASH_HOOK_COMMAND_RE.exec(command)?.[1];
}

/** True when `candidate` resolves to a path inside (a descendant of) `dir`, via real path resolution — not string matching. */
function isPathInsideDir(candidate: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(candidate));
  if (rel === "" || isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * True when a hook `command` string is Argos-owned for the purposes of
 * DESTRUCTIVE removal: it must match Argos's own `bash "<scriptPath>"`
 * invocation shape, have a basename starting with `argos-`, AND resolve to a
 * location actually inside `hooksDir` (the real, resolved
 * `<claudeDir>/hooks` directory this install manages).
 *
 * This is intentionally stricter than `isArgosHookCommand`/`ARGOS_HOOK_PATH_RE`,
 * which only substring-match `/hooks/argos-` anywhere in the command string.
 * A user's own hook living at an unrelated path that happens to contain that
 * substring — e.g. `/Users/x/my/hooks/argos-custom.sh`, which is NOT under
 * the managed hooks directory — would false-match the substring check and be
 * silently deleted. Anchoring to the resolved hooks directory (via
 * `path.resolve` + an ancestor check, not `.includes()`) closes that hole.
 */
function isArgosOwnedHookCommand(command: unknown, hooksDir: string): command is string {
  if (typeof command !== "string") return false;
  const scriptPath = extractBashScriptPath(command);
  if (!scriptPath) return false;
  if (!ARGOS_HOOK_BASENAME_RE.test(basename(scriptPath))) return false;
  return isPathInsideDir(scriptPath, hooksDir);
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
      bucket.hooks = (bucket.hooks as unknown[]).filter((h) => {
        if (!isPlainObject(h) || typeof h.command !== "string") return true;
        const command = h.command;
        return !removeScriptPaths.some((p) => command.includes(p));
      });
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

// --- output-style ("voice activation") — spec 0004 "Activación de la voz" ---

/**
 * True when `value` (a `settings.json.outputStyle` value) points at the
 * predecessor harness's voice (`navori`) — matched EXACTLY, never by
 * substring. Claude Code custom output styles are typically just the bare
 * style name (e.g. `"navori"`, backed by `~/.claude/output-styles/navori.md`),
 * but a hand-edited value could plausibly carry a path-ish form instead
 * (`.../output-styles/navori.md`) — this also matches that shape, but only
 * when the FINAL path segment, split on `/` or `\`, is exactly `navori.md`
 * (case-insensitive extension). A bare `.includes("navori.md")` or
 * `.includes("output-styles/navori")` substring check would false-positive
 * on a user's own unrelated voice whose name merely starts with "navori"
 * (e.g. `navori-fork.md`, `navori-team-voice`) — and since
 * `applyOutputStylePolicy` defaults to taking this over unconditionally on
 * the non-interactive path (`--yes`/no-TTY, the common CI/agent path), a
 * false match there would silently clobber an unrelated user setting with
 * zero confirmation. Anchoring to exact equality closes that hole.
 */
export function isNavoriOutputStyle(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === "navori") return true;
  const lastSegment = value.split(/[/\\]/).pop() ?? "";
  return lastSegment.toLowerCase() === "navori.md";
}

export type OutputStyleStatus = "created" | "updated" | "unchanged" | "untouched" | "error";

export interface ApplyOutputStyleResult {
  status: OutputStyleStatus;
  detail?: string;
}

export interface ApplyOutputStyleOptions {
  /**
   * Whether to take over a `navori`-matched value into `"Argos"`. Only
   * consulted when the current value matches `isNavoriOutputStyle` — ignored
   * when the key is absent (always set) or matches some other foreign voice
   * (never touched, regardless of this flag). Default `true`, matching the
   * `--yes`/no-TTY "replace unconditionally" behavior from spec 0004;
   * callers backing an interactive confirm prompt pass `false` when the user
   * declines.
   */
  takeoverNavori?: boolean;
  /** Same test-only race seam as `MergeHooksOptions.onBeforeWrite` above. */
  onBeforeWrite?: () => void;
}

/**
 * Surgical policy for `settings.json.outputStyle` (spec 0004 "Activación de
 * la voz"), same mechanics as `mergeHooksIntoSettings`: read (missing file →
 * `{}`), mtime captured at read time, corrupt/unexpected JSON shape → writes
 * nothing and returns `status: "error"`, mutate in memory, re-stat right
 * before an atomic write and bail if the file moved underneath us.
 *
 * - Key absent → set to `"Argos"` (`created`/`updated` depending on whether
 *   the file itself existed).
 * - Key already `"Argos"` → `unchanged`, no write.
 * - Key matches the predecessor voice (`isNavoriOutputStyle`) → takeover
 *   governed by `options.takeoverNavori` (default `true`): accepted →
 *   overwritten to `"Argos"`, `status: "updated"` with an explicit detail
 *   naming the takeover; declined → `status: "untouched"`, nothing written.
 * - Key matches any other value → NEVER touched, `status: "untouched"`.
 *
 * Every other top-level key in `settings.json` is left exactly as found —
 * same surgical contract as the hooks merge.
 */
export function applyOutputStylePolicy(
  settingsPath: string,
  options: ApplyOutputStyleOptions = {},
): ApplyOutputStyleResult {
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

  const current = settings.outputStyle;

  if (current === "Argos") {
    return { status: "unchanged" };
  }

  if (current !== undefined && !isNavoriOutputStyle(current)) {
    return {
      status: "untouched",
      detail: `outputStyle ya apunta a otra voz ('${String(current)}') — no se toca`,
    };
  }

  if (current !== undefined && isNavoriOutputStyle(current)) {
    const takeover = options.takeoverNavori ?? true;
    if (!takeover) {
      return {
        status: "untouched",
        detail: `outputStyle sigue en '${String(current)}' (voz del harness predecesor) — takeover declinado`,
      };
    }
  }

  const previous = current;
  settings.outputStyle = "Argos";

  options.onBeforeWrite?.();

  if (existed && mtimeAtRead !== undefined) {
    let mtimeNow: number | undefined;
    try {
      mtimeNow = statSync(settingsPath).mtimeMs;
    } catch {
      mtimeNow = undefined;
    }
    if (mtimeNow !== undefined && mtimeNow !== mtimeAtRead) {
      return { status: "error", detail: "settings.json cambió durante el merge — reintenta." };
    }
  }

  try {
    writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    return { status: "error", detail: errorMessage(err) };
  }

  if (previous !== undefined) {
    return { status: "updated", detail: `reemplazó ${String(previous)} → Argos` };
  }
  // `previous === undefined` here means the KEY was absent (not that the
  // file itself was absent) — always "created" regardless of `existed`,
  // since another writer (e.g. `mergeHooksIntoSettings`, in the same
  // `runInit` call) may have already created the file moments earlier for
  // an unrelated reason.
  return { status: "created" };
}

export type RemoveOutputStyleStatus = "removed" | "unchanged" | "error";

export interface RemoveOutputStyleResult {
  status: RemoveOutputStyleStatus;
  detail?: string;
}

export interface RemoveOutputStyleOptions {
  /** Same `argos remove` preview-mode seam as `RemoveHooksOptions.dryRun` above. */
  dryRun?: boolean;
  /** Same test-only race seam as `MergeHooksOptions.onBeforeWrite` above. */
  onBeforeWrite?: () => void;
}

/**
 * `argos remove`'s mirror of `applyOutputStylePolicy`: removes
 * `settings.json.outputStyle` ONLY when it's exactly `"Argos"` — Argos's own
 * value. Any other value (including a foreign voice `argos init` never
 * touched, or the key simply absent) is left exactly as found; this command
 * only ever cleans up after itself, never after the user's own choice of
 * voice. Same missing-file/corrupt-JSON/mtime-guard/atomic-write mechanics
 * as the rest of this module.
 */
export function removeOutputStyleIfArgos(
  settingsPath: string,
  options: RemoveOutputStyleOptions = {},
): RemoveOutputStyleResult {
  if (!existsSync(settingsPath)) return { status: "unchanged" };

  let raw: string;
  let mtimeAtRead: number;
  try {
    raw = readFileSync(settingsPath, "utf-8");
    mtimeAtRead = statSync(settingsPath).mtimeMs;
  } catch (err) {
    return { status: "error", detail: errorMessage(err) };
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
      detail: `settings.json existente tiene JSON inválido (${errorMessage(err)}) — arreglalo a mano.`,
    };
  }

  if (settings.outputStyle !== "Argos") return { status: "unchanged" };
  if (options.dryRun) return { status: "removed" };

  delete settings.outputStyle;

  options.onBeforeWrite?.();

  let mtimeNow: number | undefined;
  try {
    mtimeNow = statSync(settingsPath).mtimeMs;
  } catch {
    mtimeNow = undefined;
  }
  if (mtimeNow !== undefined && mtimeNow !== mtimeAtRead) {
    return { status: "error", detail: "settings.json cambió durante el remove — reintenta." };
  }

  try {
    writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    return { status: "error", detail: errorMessage(err) };
  }

  return { status: "removed" };
}

export type RemoveHooksStatus = "removed" | "unchanged" | "error";

export interface RemoveHooksResult {
  status: RemoveHooksStatus;
  detail?: string;
  /** Count of Argos-owned hook entries actually removed (0 for "unchanged"/"error"). */
  removedCount: number;
}

export interface RemoveHooksOptions {
  /**
   * Compute what WOULD be removed without writing anything — `argos remove`'s
   * preview mode. Corrupt-JSON refusal still applies identically in dry-run:
   * a caller must not be told "removed" for a file it can't safely reason
   * about.
   */
  dryRun?: boolean;
  /** Same test-only seam as `MergeHooksOptions.onBeforeWrite` above. */
  onBeforeWrite?: () => void;
}

/**
 * Symmetric counterpart to `mergeHooksIntoSettings`: strips every Argos-owned
 * hook entry (any command matched by `isArgosOwnedHookCommand` against
 * `hooksDir`, not just the current `HOOK_IDS`) out of `hooks.PreToolUse`,
 * wherever it's found. Foreign hooks, buckets, and every other top-level key
 * are left exactly as found — same ownership/refusal contract as the merge
 * path:
 * - `hooksDir` is the resolved `<claudeDir>/hooks` directory this install
 *   manages (normally `join(resolveClaudeDir(), "hooks")`). A hook is only
 *   ever treated as Argos-owned — and therefore deletable — when its script
 *   path actually resolves inside `hooksDir` AND its basename starts with
 *   `argos-`; this is deliberately NOT the same as `isArgosHookCommand`'s
 *   bare `/hooks/argos-` substring match, which would also match (and
 *   delete) an unrelated user hook at a path like
 *   `/Users/x/my/hooks/argos-custom.sh`.
 * - Missing file, or no `hooks`/`hooks.PreToolUse` at all → "unchanged",
 *   nothing to remove.
 * - Corrupt JSON (unparsable, not an object, `hooks` present but not an
 *   object, or `hooks.PreToolUse` present but not an array) → `status:
 *   "error"`, writes NOTHING. Never guess at a shape it can't verify.
 * - A `PreToolUse` bucket that becomes empty after removing Argos's own
 *   entries is dropped entirely (it only ever existed to hold them — see
 *   `mergeHooksIntoSettings`, which creates a fresh bucket per matcher on
 *   demand); a bucket that still has foreign hooks left (including one with
 *   ZERO Argos-owned hooks in it) keeps its matcher, its hooks, and its
 *   position untouched.
 * - Same mtime concurrency guard and atomic write as the merge path.
 */
export function removeAllArgosHooksFromSettings(
  settingsPath: string,
  hooksDir: string,
  options: RemoveHooksOptions = {},
): RemoveHooksResult {
  if (!existsSync(settingsPath)) return { status: "unchanged", removedCount: 0 };

  let raw: string;
  let mtimeAtRead: number;
  try {
    raw = readFileSync(settingsPath, "utf-8");
    mtimeAtRead = statSync(settingsPath).mtimeMs;
  } catch (err) {
    return { status: "error", detail: errorMessage(err), removedCount: 0 };
  }

  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = raw.trim().length === 0 ? {} : JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        status: "error",
        detail: "settings.json existente no es un objeto JSON — arreglalo a mano.",
        removedCount: 0,
      };
    }
    settings = parsed;
  } catch (err) {
    return {
      status: "error",
      detail: `settings.json existente tiene JSON inválido (${errorMessage(err)}) — arreglalo a mano.`,
      removedCount: 0,
    };
  }

  if (settings.hooks !== undefined && !isPlainObject(settings.hooks)) {
    return {
      status: "error",
      detail: "settings.json tiene hooks que no es un objeto — arreglalo a mano.",
      removedCount: 0,
    };
  }
  const hooksRoot = settings.hooks as Record<string, unknown> | undefined;
  if (!hooksRoot) return { status: "unchanged", removedCount: 0 };

  const preToolUseRaw = hooksRoot.PreToolUse;
  if (preToolUseRaw !== undefined && !Array.isArray(preToolUseRaw)) {
    return {
      status: "error",
      detail: "settings.json tiene hooks.PreToolUse que no es un array — arreglalo a mano.",
      removedCount: 0,
    };
  }
  if (!Array.isArray(preToolUseRaw) || preToolUseRaw.length === 0) {
    return { status: "unchanged", removedCount: 0 };
  }

  let removedCount = 0;
  const nextPreToolUse: unknown[] = [];
  for (const bucket of preToolUseRaw) {
    if (!isPlainObject(bucket) || !Array.isArray(bucket.hooks)) {
      nextPreToolUse.push(bucket);
      continue;
    }
    const before = bucket.hooks.length;
    const filteredHooks = (bucket.hooks as unknown[]).filter(
      (h) => !(isPlainObject(h) && isArgosOwnedHookCommand(h.command, hooksDir)),
    );
    removedCount += before - filteredHooks.length;
    if (filteredHooks.length === 0) continue; // bucket only ever held Argos's own entries
    nextPreToolUse.push({ ...bucket, hooks: filteredHooks });
  }

  if (removedCount === 0) return { status: "unchanged", removedCount: 0 };
  if (options.dryRun) return { status: "removed", removedCount };

  hooksRoot.PreToolUse = nextPreToolUse;
  settings.hooks = hooksRoot;

  options.onBeforeWrite?.();

  // Same cheap concurrency guard as mergeHooksIntoSettings.
  let mtimeNow: number | undefined;
  try {
    mtimeNow = statSync(settingsPath).mtimeMs;
  } catch {
    mtimeNow = undefined;
  }
  if (mtimeNow !== undefined && mtimeNow !== mtimeAtRead) {
    return {
      status: "error",
      detail: "settings.json cambió durante el remove — reintenta.",
      removedCount: 0,
    };
  }

  try {
    writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    return { status: "error", detail: errorMessage(err), removedCount: 0 };
  }

  return { status: "removed", removedCount };
}
