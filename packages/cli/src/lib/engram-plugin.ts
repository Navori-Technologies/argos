import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Installs the Engram persistent-memory plugin (`engram@engram`, marketplace
 * `Gentleman-Programming/engram`) as part of `argos init` (spec 0005 "Engram
 * como parte del motor"). Delegates entirely to the `claude` CLI — the only
 * documented way to register a marketplace and install a plugin (writing
 * `enabledPlugins`/`extraKnownMarketplaces` into settings.json by hand is NOT
 * a documented install path, see the spec's "Hechos verificados") — via an
 * injectable runner, same idiom as `OpenclawRunner` in lib/openclaw-agents.ts
 * and `Prompter` in lib/prompter.ts: a typed function, a real default
 * implementation backed by `spawnSync`, and the only caller (`installEngramPlugin`)
 * takes an optional runner that defaults to it, so tests never shell out.
 */

export const CLAUDE_BINARY = "claude";
export const ENGRAM_MARKETPLACE = "Gentleman-Programming/engram";
export const ENGRAM_PLUGIN_SPEC = "engram@engram";

// A marketplace registration or plugin install should never legitimately
// hang, but each gets its own bound so a stuck interactive prompt inside the
// `claude` CLI (e.g. an unexpected confirmation) can't freeze `argos init`
// forever. Values per spec 0005's Design section.
const MARKETPLACE_ADD_TIMEOUT_MS = 60_000;
const PLUGIN_INSTALL_TIMEOUT_MS = 120_000;

export interface ClaudeCliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set instead of status/stdout/stderr when the process itself couldn't be spawned (e.g. ENOENT — `claude` not in PATH) or timed out. */
  error?: NodeJS.ErrnoException;
}

/** Runs one `claude <args>` invocation. Injectable so tests never shell out. */
export type ClaudeCliRunner = (args: string[], timeoutMs: number) => ClaudeCliResult;

/** Real default implementation, backed by `node:child_process.spawnSync`. */
export const runClaudeCli: ClaudeCliRunner = (args, timeoutMs) => {
  const result = spawnSync(CLAUDE_BINARY, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  if (result.error) {
    return { status: null, stdout: "", stderr: "", error: result.error as NodeJS.ErrnoException };
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** The 2 manual commands an operator can run themselves, surfaced in every error `detail` (R3). */
export function manualEngramCommands(): string[] {
  return [
    `${CLAUDE_BINARY} plugin marketplace add ${ENGRAM_MARKETPLACE}`,
    `${CLAUDE_BINARY} plugin install ${ENGRAM_PLUGIN_SPEC}`,
  ];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read-only peek at `settings.json.enabledPlugins["engram@engram"]`. Never
 * throws — a missing file, unreadable file, or invalid/unexpected JSON shape
 * all just read as "not enabled" (`false`), which is always a safe answer
 * here: it only ever gates whether `installEngramPlugin` attempts an
 * install, never a destructive action.
 */
export function isEngramPluginEnabled(settingsPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isPlainObject(parsed)) return false;
    const enabledPlugins = parsed.enabledPlugins;
    if (!isPlainObject(enabledPlugins)) return false;
    return enabledPlugins[ENGRAM_PLUGIN_SPEC] === true;
  } catch {
    return false;
  }
}

export type EngramInstallStatus = "created" | "unchanged" | "error";

export interface EngramInstallResult {
  status: EngramInstallStatus;
  detail?: string;
}

export interface InstallEngramPluginOptions {
  /** Injectable for tests; defaults to `runClaudeCli`. */
  runner?: ClaudeCliRunner;
}

// The `claude` CLI's own wording for "this marketplace is already registered"
// isn't part of any published contract, so this is a best-effort classifier
// — widen it here if a real `claude` error message doesn't match. This is the
// ONLY outcome tolerated as non-fatal on the marketplace-add step (R3): every
// other non-zero exit is a real error.
const MARKETPLACE_ALREADY_REGISTERED_RE = /already (?:registered|exists|added)/i;

function commandFailureDetail(result: ClaudeCliResult): string {
  const reason = result.stderr.trim() || result.stdout.trim() || `claude salió con status ${result.status}`;
  return `${reason} — corre manualmente: ${manualEngramCommands().join(" && ")}`;
}

function spawnFailureDetail(error: NodeJS.ErrnoException): string {
  const reason =
    error.code === "ENOENT"
      ? "el binario 'claude' no está en PATH"
      : error.code === "ETIMEDOUT"
        ? "claude excedió el tiempo límite"
        : error.message;
  return `${reason} — corre manualmente: ${manualEngramCommands().join(" && ")}`;
}

/**
 * Installs `engram@engram` (spec 0005 R1/R2/R3):
 * - Already enabled (`isEngramPluginEnabled`) → `unchanged`, no process spawned at all.
 * - Not enabled → runs `claude plugin marketplace add <marketplace>` (tolerating
 *   an "already registered" failure) then `claude plugin install engram@engram`.
 *   Both succeeding → `created`.
 * - `claude` missing from PATH, or either command fails for any other reason →
 *   `error`, with `detail` naming both manual commands the operator can run
 *   themselves. Never writes `enabledPlugins`/settings.json itself either way
 *   — that's the `claude` CLI's own job when it succeeds.
 */
export function installEngramPlugin(
  settingsPath: string,
  options: InstallEngramPluginOptions = {},
): EngramInstallResult {
  if (isEngramPluginEnabled(settingsPath)) {
    return { status: "unchanged" };
  }

  const runner = options.runner ?? runClaudeCli;

  const marketplaceResult = runner(["plugin", "marketplace", "add", ENGRAM_MARKETPLACE], MARKETPLACE_ADD_TIMEOUT_MS);
  if (marketplaceResult.error) {
    return { status: "error", detail: spawnFailureDetail(marketplaceResult.error) };
  }
  const combined = `${marketplaceResult.stdout}\n${marketplaceResult.stderr}`;
  const marketplaceOk = marketplaceResult.status === 0 || MARKETPLACE_ALREADY_REGISTERED_RE.test(combined);
  if (!marketplaceOk) {
    return { status: "error", detail: commandFailureDetail(marketplaceResult) };
  }

  const installResult = runner(["plugin", "install", ENGRAM_PLUGIN_SPEC], PLUGIN_INSTALL_TIMEOUT_MS);
  if (installResult.error) {
    return { status: "error", detail: spawnFailureDetail(installResult.error) };
  }
  if (installResult.status !== 0) {
    return { status: "error", detail: commandFailureDetail(installResult) };
  }

  return { status: "created" };
}
