import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { hasBinary as hasBinaryReal } from "./which.js";

/**
 * Installs and detects Graphify (PyPI `graphifyy`, repo `Graphify-Labs/graphify`
 * @ `v8`) as part of the engine (spec 0006 "Graphify como parte del motor").
 * Same idiom as `engram-plugin.ts`: a typed, injectable runner backed by a real
 * `spawnSync` default, read-only peeks that never throw, and callers that
 * never write `~/.claude/CLAUDE.md`, `settings.json`, or any repo file
 * directly — those writes are always `graphify install`'s own job.
 *
 * Two scopes, per the audit (`.claude/progress/audit_graphify.md`):
 * - User scope (`installGraphifyUserScope`): binary install (`uv tool
 *   install graphifyy` / `pipx install graphifyy`) + `graphify install`
 *   (writes `~/.claude/skills/graphify/SKILL.md` and a `## graphify` block
 *   in `~/.claude/CLAUDE.md`), confirmed with a `graphify --version` smoke
 *   test because `graphify install` has no documented exit-code contract.
 * - Project scope (`installGraphifyProjectScope`): `graphify install
 *   --project` + `graphify hook install` in a target repo, confirmed with a
 *   re-peek of `hooks.PreToolUse` in `<cwd>/.claude/settings.json` for the
 *   same reason.
 */

const UV_TOOL_INSTALL_ARGS = ["tool", "install", "graphifyy"];
const PIPX_INSTALL_ARGS = ["install", "graphifyy"];
const GRAPHIFY_INSTALL_ARGS = ["install"];
const GRAPHIFY_INSTALL_PROJECT_ARGS = ["install", "--project"];
const GRAPHIFY_HOOK_INSTALL_ARGS = ["hook", "install"];
const GRAPHIFY_VERSION_ARGS = ["--version"];
const GRAPHIFY_UPDATE_ARGS = ["update"];

// `uv tool install`/`pipx install` resolve Python deps, which can be slow;
// `graphify install`/`--project`/`hook install` are local file operations;
// `graphify --version` is a trivial smoke test. Each gets its own bound so a
// stuck subprocess can't freeze `argos init`/`argos adopt` forever.
const BINARY_INSTALL_TIMEOUT_MS = 300_000;
const GRAPHIFY_COMMAND_TIMEOUT_MS = 60_000;
const GRAPHIFY_VERSION_TIMEOUT_MS = 30_000;
// `graphify update` does a from-scratch AST build of the whole repo (no LLM,
// but still walks every file) — much slower than the local file operations
// above, especially on large repos, so it gets its own, wider bound.
const GRAPHIFY_UPDATE_TIMEOUT_MS = 300_000;

export type GraphifyBinaryName = "uv" | "pipx" | "graphify";

export interface GraphifyCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set instead of status/stdout/stderr when the process itself couldn't be spawned (e.g. ENOENT) or timed out. */
  error?: NodeJS.ErrnoException;
}

/**
 * Runs one invocation of `uv`, `pipx`, or `graphify`. Injectable so tests
 * never shell out; `cwd` is only ever passed by the project-scope install
 * (user-scope install runs in the process's own cwd, which tests must never
 * rely on implicitly).
 */
export type GraphifyRunner = (
  binary: GraphifyBinaryName,
  args: string[],
  timeoutMs: number,
  cwd?: string,
) => GraphifyCliResult;

/** Real default implementation, backed by `node:child_process.spawnSync`. */
export const runGraphifyCli: GraphifyRunner = (binary, args, timeoutMs, cwd) => {
  const result = spawnSync(binary, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    cwd,
    // `uv tool install` dep-resolution logs can exceed Node's default 1MB stdout/stderr buffer.
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    return { status: null, stdout: "", stderr: "", error: result.error as NodeJS.ErrnoException };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** The manual commands an operator can run themselves for the user-scope install (R4, R5). */
export function manualGraphifyCommands(): string[] {
  return ["uv tool install graphifyy", "pipx install graphifyy", "graphify install"];
}

/** The manual commands an operator can run themselves for the project-scope install (R12). */
function manualGraphifyProjectCommands(): string[] {
  return ["graphify install --project", "graphify hook install", "graphify update ."];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read-only check for whether the Graphify skill is registered: does
 * `<claudeDir>/skills/graphify/SKILL.md` exist? This is the only documented
 * user-scope side effect of `graphify install` that Argos can check without
 * spawning a process (the `## graphify` block in CLAUDE.md has no marker of
 * its own to check for reliably).
 */
export function isGraphifySkillRegistered(claudeDir: string): boolean {
  return existsSync(join(claudeDir, "skills", "graphify", "SKILL.md"));
}

/**
 * Read-only peek at `hooks.PreToolUse` in `<cwd>/.claude/settings.json`,
 * looking for the graphify hook. Never throws — a missing file, unreadable
 * file, or invalid/unexpected JSON shape all read as "not installed"
 * (`false`). There's no documented schema for the hook entry itself, so the
 * check is a best-effort substring match on the serialized value, same
 * philosophy as the "already registered" regex in `engram-plugin.ts`.
 */
export function hasGraphifyProjectHook(cwd: string): boolean {
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isPlainObject(parsed)) return false;
    const hooks = parsed.hooks;
    if (!isPlainObject(hooks)) return false;
    const preToolUse = hooks.PreToolUse;
    if (preToolUse === undefined) return false;
    return JSON.stringify(preToolUse).includes("graphify");
  } catch {
    return false;
  }
}

/**
 * Read-only peek for whether the initial graph bootstrap already ran:
 * does `<cwd>/graphify-out/graph.json` exist? Never throws — used to decide
 * whether `graphify update <cwd>` still needs to run, and to confirm it
 * worked afterwards (same "re-peek, no documented exit-code contract"
 * philosophy as `hasGraphifyProjectHook`).
 */
export function hasGraphifyGraph(cwd: string): boolean {
  return existsSync(join(cwd, "graphify-out", "graph.json"));
}

function commandFailureDetail(result: GraphifyCliResult, manualCommands: string[]): string {
  const reason = result.stderr.trim() || result.stdout.trim() || `el comando salió con status ${result.status}`;
  return `${reason} — corre manualmente: ${manualCommands.join(" && ")}`;
}

function spawnFailureDetail(error: NodeJS.ErrnoException, binary: string, manualCommands: string[]): string {
  const reason =
    error.code === "ENOENT"
      ? `el binario '${binary}' no está en PATH`
      : error.code === "ETIMEDOUT"
        ? `${binary} excedió el tiempo límite`
        : error.message;
  return `${reason} — corre manualmente: ${manualCommands.join(" && ")}`;
}

export type GraphifyUserScopeStatus = "created" | "updated" | "unchanged" | "error";

export interface GraphifyUserScopeResult {
  status: GraphifyUserScopeStatus;
  detail?: string;
}

export interface InstallGraphifyUserScopeOptions {
  /** Injectable for tests; defaults to `runGraphifyCli`. */
  runner?: GraphifyRunner;
  /** Injectable for tests; defaults to the real `hasBinary` from `which.ts`. */
  hasBinary?: (name: string) => boolean;
}

/**
 * Installs Graphify user-scope (spec 0006 R1, R1b, R2, R3, R4, R5):
 * - `graphify` already in PATH and the skill already registered → `unchanged`,
 *   nothing spawned (R3).
 * - `graphify` missing, `uv` (preferred) or `pipx` present → installs the
 *   binary (`uv tool install graphifyy` / `pipx install graphifyy`), then
 *   re-checks PATH (R1). If the install command exited 0 but `graphify`
 *   still doesn't resolve in PATH, reports `error` with PATH-refresh guidance
 *   only — no retry, no `graphify install`, no re-run suggestion (R1b).
 * - `graphify` missing and neither `uv` nor `pipx` present → `error` with
 *   both manual install commands (R4).
 * - Once `graphify` resolves in PATH (already there, or just installed and
 *   past the R1b check): if it was *just* installed and the skill is already
 *   registered → `updated` (binary installed, skill untouched), without
 *   running `graphify install` or the smoke test (R3's post-R1 case).
 *   Otherwise, if the skill isn't registered yet, runs `graphify install`
 *   then the `graphify --version` smoke test; both succeeding → `created`
 *   (R2). Any spawn failure or non-zero exit at any step, or a failing smoke
 *   test, → `error` with the causa and manual commands, never `created` (R5).
 * Never writes `~/.claude/CLAUDE.md`, `settings.json`, or the skill file
 * itself — that's always `graphify install`'s own job.
 */
export function installGraphifyUserScope(
  claudeDir: string,
  options: InstallGraphifyUserScopeOptions = {},
): GraphifyUserScopeResult {
  const runner = options.runner ?? runGraphifyCli;
  const hasBinary = options.hasBinary ?? hasBinaryReal;

  let binaryJustInstalled = false;

  if (!hasBinary("graphify")) {
    if (hasBinary("uv")) {
      const result = runner("uv", UV_TOOL_INSTALL_ARGS, BINARY_INSTALL_TIMEOUT_MS);
      if (result.error) {
        return { status: "error", detail: spawnFailureDetail(result.error, "uv", manualGraphifyCommands()) };
      }
      if (result.status !== 0) {
        return { status: "error", detail: commandFailureDetail(result, manualGraphifyCommands()) };
      }
      binaryJustInstalled = true;
    } else if (hasBinary("pipx")) {
      const result = runner("pipx", PIPX_INSTALL_ARGS, BINARY_INSTALL_TIMEOUT_MS);
      if (result.error) {
        return { status: "error", detail: spawnFailureDetail(result.error, "pipx", manualGraphifyCommands()) };
      }
      if (result.status !== 0) {
        return { status: "error", detail: commandFailureDetail(result, manualGraphifyCommands()) };
      }
      binaryJustInstalled = true;
    } else {
      return {
        status: "error",
        detail: `graphify, uv y pipx no están en PATH — corre manualmente: ${manualGraphifyCommands().join(" && ")}`,
      };
    }

    if (!hasBinary("graphify")) {
      return {
        status: "error",
        detail:
          "el binario 'graphify' se instaló correctamente pero todavía no se resuelve en el PATH de este proceso — actualiza el PATH de tu shell ('uv tool update-shell' o reabre la shell) y vuelve a correr argos init",
      };
    }
  }

  const skillRegistered = isGraphifySkillRegistered(claudeDir);

  if (binaryJustInstalled && skillRegistered) {
    return { status: "updated", detail: "binario instalado; skill ya registrado" };
  }

  if (!binaryJustInstalled && skillRegistered) {
    return { status: "unchanged" };
  }

  const installResult = runner("graphify", GRAPHIFY_INSTALL_ARGS, GRAPHIFY_COMMAND_TIMEOUT_MS);
  if (installResult.error) {
    return { status: "error", detail: spawnFailureDetail(installResult.error, "graphify", manualGraphifyCommands()) };
  }
  if (installResult.status !== 0) {
    return { status: "error", detail: commandFailureDetail(installResult, manualGraphifyCommands()) };
  }

  const versionResult = runner("graphify", GRAPHIFY_VERSION_ARGS, GRAPHIFY_VERSION_TIMEOUT_MS);
  if (versionResult.error) {
    return { status: "error", detail: spawnFailureDetail(versionResult.error, "graphify", manualGraphifyCommands()) };
  }
  if (versionResult.status !== 0) {
    return { status: "error", detail: commandFailureDetail(versionResult, manualGraphifyCommands()) };
  }

  return { status: "created" };
}

export type GraphifyProjectScopeStatus = "created" | "unchanged" | "error";

export interface GraphifyProjectScopeResult {
  status: GraphifyProjectScopeStatus;
  detail?: string;
}

export interface InstallGraphifyProjectScopeOptions {
  /** Injectable for tests; defaults to `runGraphifyCli`. */
  runner?: GraphifyRunner;
}

/** Manual command for completing only the graph bootstrap, when hook/skill are already in place. */
const GRAPHIFY_UPDATE_ONLY_MANUAL_COMMANDS = ["graphify update ."];

/** Prefix used whenever `graphify update` fails but the hook (and skill) were already written — either before this call, or by this same call. */
const GRAPH_NOT_BUILT_PREFIX =
  "el hook PreToolUse (y el skill) ya quedaron escritos; solo falló el build del grafo inicial: ";

/**
 * Runs `graphify update <cwd>` and re-peeks `hasGraphifyGraph(cwd)`.
 * Returns `undefined` on success (caller decides the final status/detail),
 * or an error detail string on spawn failure, non-zero exit, or a negative
 * re-peek despite a clean exit.
 */
function runGraphUpdate(cwd: string, runner: GraphifyRunner): string | undefined {
  const updateResult = runner("graphify", [...GRAPHIFY_UPDATE_ARGS, cwd], GRAPHIFY_UPDATE_TIMEOUT_MS, cwd);
  if (updateResult.error) {
    return GRAPH_NOT_BUILT_PREFIX + spawnFailureDetail(updateResult.error, "graphify", GRAPHIFY_UPDATE_ONLY_MANUAL_COMMANDS);
  }
  if (updateResult.status !== 0) {
    return GRAPH_NOT_BUILT_PREFIX + commandFailureDetail(updateResult, GRAPHIFY_UPDATE_ONLY_MANUAL_COMMANDS);
  }
  if (!hasGraphifyGraph(cwd)) {
    return `${GRAPH_NOT_BUILT_PREFIX}graphify update terminó sin error pero ${cwd}/graphify-out/graph.json no aparece — corre manualmente: ${GRAPHIFY_UPDATE_ONLY_MANUAL_COMMANDS.join(" && ")}`;
  }
  return undefined;
}

/**
 * Installs Graphify project-scope in `cwd` and bootstraps its initial graph
 * (spec 0006 R9, R10, R12, extended with the `graphify update` bootstrap):
 * - Hook already installed (`hasGraphifyProjectHook`) AND the graph already
 *   exists (`hasGraphifyGraph`) → `unchanged` with detail "ya instalado",
 *   nothing spawned (R10). A corrupt or missing settings.json/graph.json
 *   reads as "not installed"/"no graph" (peeks never throw).
 * - Hook already installed but the graph is absent → runs only `graphify
 *   update <cwd>` (an AST build with no LLM involved), then re-peeks
 *   `hasGraphifyGraph`; a positive re-peek reports `created` with a detail
 *   noting the hook was already there and only the graph got (re)built. A
 *   spawn error, non-zero exit, or negative re-peek → `error`, with a detail
 *   that makes clear the hook/skill are fine and only the graph build failed.
 * - Neither is present → runs `graphify install --project` then `graphify
 *   hook install` in `cwd` (unchanged from before), re-peeks
 *   `hasGraphifyProjectHook`; once that's positive, also runs `graphify
 *   update <cwd>` and re-peeks `hasGraphifyGraph`. All four checks positive →
 *   `created`. Any of the four failing → `error` with the causa and manual
 *   commands (R12) — a hook/install failure keeps its original detail; an
 *   update failure after a successfully-written hook gets the "hook/skill
 *   already written, only the graph build failed" detail instead.
 * Never writes `.claude/settings.json`, the repo's CLAUDE.md, or
 * `graphify-out/*` itself — those writes are always `graphify install
 * --project`/`graphify hook install`/`graphify update`'s own job.
 */
export function installGraphifyProjectScope(
  cwd: string,
  options: InstallGraphifyProjectScopeOptions = {},
): GraphifyProjectScopeResult {
  const runner = options.runner ?? runGraphifyCli;
  const manualCommands = manualGraphifyProjectCommands();

  if (hasGraphifyProjectHook(cwd)) {
    if (hasGraphifyGraph(cwd)) {
      return { status: "unchanged", detail: "ya instalado" };
    }

    const updateFailureDetail = runGraphUpdate(cwd, runner);
    if (updateFailureDetail) {
      return { status: "error", detail: updateFailureDetail };
    }
    return { status: "created", detail: "hook PreToolUse ya estaba instalado; se generó el grafo inicial" };
  }

  const installResult = runner("graphify", GRAPHIFY_INSTALL_PROJECT_ARGS, GRAPHIFY_COMMAND_TIMEOUT_MS, cwd);
  if (installResult.error) {
    return { status: "error", detail: spawnFailureDetail(installResult.error, "graphify", manualCommands) };
  }
  if (installResult.status !== 0) {
    return { status: "error", detail: commandFailureDetail(installResult, manualCommands) };
  }

  const hookResult = runner("graphify", GRAPHIFY_HOOK_INSTALL_ARGS, GRAPHIFY_COMMAND_TIMEOUT_MS, cwd);
  const hookAlreadyWrittenPrefix = "el hook PreToolUse ya quedó escrito en .claude/settings.json; falló el git hook post-commit: ";
  if (hookResult.error) {
    return {
      status: "error",
      detail: hookAlreadyWrittenPrefix + spawnFailureDetail(hookResult.error, "graphify", manualCommands),
    };
  }
  if (hookResult.status !== 0) {
    return {
      status: "error",
      detail: hookAlreadyWrittenPrefix + commandFailureDetail(hookResult, manualCommands),
    };
  }

  if (!hasGraphifyProjectHook(cwd)) {
    return {
      status: "error",
      detail: `graphify install --project y graphify hook install terminaron sin error pero el hook PreToolUse no aparece en ${cwd}/.claude/settings.json — corre manualmente: ${manualCommands.join(" && ")}`,
    };
  }

  const updateFailureDetail = runGraphUpdate(cwd, runner);
  if (updateFailureDetail) {
    return { status: "error", detail: updateFailureDetail };
  }

  return { status: "created", detail: "hook PreToolUse instalado; se generó el grafo inicial" };
}
