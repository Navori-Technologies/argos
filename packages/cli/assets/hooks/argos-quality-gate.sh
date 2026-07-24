#!/usr/bin/env bash
# argos:file v="__ARGOS_VERSION__"
#
# PreToolUse(Bash) hook: runs the repo's quality gate (argos.config.json
# `qualityGate.fast`) before letting a `git commit` through. Global engine
# hook — installed ONCE in ~/.claude, parametrized by the repo's config at
# runtime, not rendered per repo (spec 0003, "Hooks globales
# parametrizados").
#
# - No argos.config.json found walking up from $CLAUDE_PROJECT_DIR / cwd →
#   no-op (silent exit 0). The "aterrizaje" block in CLAUDE.md already warns
#   about unconfigured repos; this hook doesn't repeat that warning on every
#   commit attempt.
# - qualityGate.fast equal to the NO_GATE_PLACEHOLDER string exported by
#   packages/cli/src/commands/adopt.ts (no lint/typecheck/test scripts were
#   detected at `argos adopt` time) → no-op. The two literals must be kept in
#   sync by hand — there is no shared runtime module between the CLI package
#   and this standalone shell asset, and adding one just to DRY a single
#   string is not worth the indirection.
# - Otherwise: run it via `bash -c` (Node's execSync with `shell: "/bin/bash"`),
#   bounded by $ARGOS_GATE_TIMEOUT_MS (default 300000ms / 5 minutes). A
#   non-zero exit OR a timeout → exit 2 with the tail of the combined
#   stdout+stderr on stderr, blocking the commit.
#
# JSON parsing (the tool_input payload, and argos.config.json) is node-only:
# argos ships as an npm global install, so node is guaranteed on any machine
# that ever ran `argos init` — unlike navori-harness's guard-destructive.sh,
# which fell back to jq/sed because it had to assume nothing about the
# target repo's toolchain.
set -euo pipefail

payload=$(cat)

# Two-stage filter. Stage 1 (here): a cheap shell-builtin substring check on
# the RAW payload, before paying for a node spawn at all — spawning node just
# to parse JSON and discover "not a commit" was measured at 40-60ms per Bash
# call (combined with guard-destructive.sh's own spawn), on EVERY Bash tool
# call, commit or not. This is a safe OVER-approximation: it only guarantees
# that a payload with no "commit" substring anywhere can't possibly be a git
# commit, so it's safe to skip straight to exit 0. It does NOT decide "is
# this actually a git commit" — a payload that merely mentions the word
# "commit" elsewhere (e.g. `git log --grep=commit`) still proceeds to stage
# 2. Stage 2 (below, after the node JSON parse) is the precise, existing
# git-commit-specific regex against the extracted tool_input.command.
case "$payload" in
  *commit*) ;;
  *) exit 0 ;;
esac

cmd=$(PAYLOAD="$payload" node <<'NODE_EOF'
try {
  const data = JSON.parse(process.env.PAYLOAD || "{}");
  process.stdout.write(String((data && data.tool_input && data.tool_input.command) || ""));
} catch {
  process.stdout.write("");
}
NODE_EOF
)
[ -z "$cmd" ] && exit 0

# Only act on commands that invoke `git commit` somewhere (compound commands
# included, git global options like `git -C repo commit` tolerated). Keep it
# simple per spec: ANY `git commit` invocation counts, no attempt to special-
# case --amend/--no-edit/etc. — argos-guard-destructive.sh already owns the
# --no-verify / force-push judgment calls, this hook only needs to know "is
# a commit about to happen".
printf '%s' "$cmd" | grep -qE '(^|[;&|[:space:]])git([[:space:]]+-[A-Za-z-]+(=[^[:space:]]+)?([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+commit([[:space:]]|$)' || exit 0

# Walk up from $CLAUDE_PROJECT_DIR (or cwd) looking for argos.config.json.
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
config_path=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/argos.config.json" ]; then
    config_path="$dir/argos.config.json"
    break
  fi
  dir=$(dirname "$dir")
done
[ -z "$config_path" ] && exit 0

CONFIG_PATH="$config_path" ARGOS_GATE_TIMEOUT_MS="${ARGOS_GATE_TIMEOUT_MS:-300000}" node <<'NODE_EOF'
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const configPath = process.env.CONFIG_PATH;
const DEFAULT_TIMEOUT_MS = 300000;
// Sanitize: a garbage/negative/fractional $ARGOS_GATE_TIMEOUT_MS must never
// reach execSync's `timeout` option — Node throws ERR_OUT_OF_RANGE
// synchronously, BEFORE the gate command is even spawned, which used to
// block every commit with a misleading "gate falló" and no useful output.
const rawTimeout = Math.floor(Number(process.env.ARGOS_GATE_TIMEOUT_MS));
const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_TIMEOUT_MS;
// Keep this literal in sync by hand with NO_GATE_PLACEHOLDER in
// packages/cli/src/commands/adopt.ts.
const PLACEHOLDER = "echo 'argos: no lint/typecheck/test scripts detected — set qualityGate.fast manually'";

let fast;
try {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  fast = cfg && cfg.qualityGate && cfg.qualityGate.fast;
} catch {
  // Unreadable/invalid config: fail open, same spirit as "sin config -> no-op".
  process.exit(0);
}
if (!fast || fast === PLACEHOLDER) process.exit(0);

try {
  execSync(fast, {
    cwd: path.dirname(configPath),
    shell: "/bin/bash",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.exit(0);
} catch (err) {
  const out = Buffer.concat([err.stdout || Buffer.alloc(0), err.stderr || Buffer.alloc(0)]).toString("utf-8");
  let tail = out.split("\n").slice(-20).join("\n").trim();
  // A failure that happens BEFORE the gate command is even spawned (e.g. a
  // bad `timeout` option, or execSync itself throwing) never produces any
  // stdout/stderr — fall back to the thrown error's own message so the root
  // cause is visible instead of an empty, misleading failure report.
  if (!tail && err && err.message) tail = String(err.message);
  process.stderr.write("[argos] quality gate del repo falló — commit bloqueado\n");
  if (tail) process.stderr.write(`${tail}\n`);
  process.exit(2);
}
NODE_EOF
exit $?
