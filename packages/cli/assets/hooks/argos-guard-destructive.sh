#!/usr/bin/env bash
# argos:file v="__ARGOS_VERSION__"
#
# Defensive PreToolUse(Bash) guard — lives ONCE in ~/.claude and is
# parametrized by the current repo's argos.config.json at runtime (walked up
# from $CLAUDE_PROJECT_DIR / cwd), instead of being rendered per repo. Reads
# the full command from Claude Code's tool input and HARD-BLOCKS (exit 2)
# destructive patterns that static permission rules in settings.json can't
# reliably catch. Exit 2 in a PreToolUse hook runs BEFORE permission rules,
# so this is the strongest line of defense — it overrides even an `allow`.
#
# Adapted from navori-harness's proven guard-destructive.sh (per-repo
# rendered hook). Differences, and why:
#   - branchBase used to be templated at render time ({{branchBase}}); here
#     it's read from argos.config.json at runtime (global-first: one script
#     installed once, many repos read from it) — default "main" when there
#     is no config, or no branchBase field in it.
#   - Scope trimmed to the 3 patterns spec 0003 names explicitly: force-push
#     to the base branch, rm -rf outside scratch, and --no-verify. The
#     original also carried a fork-bomb guard and a block-device-write
#     guard; dropped here to keep this contract narrow and auditable. A repo
#     that wants those back gets them via `argos export` (team mode, F3),
#     which renders repo-owned hooks.
#   - JSON parsing is node-only, no jq/sed fallback: argos itself ships as an
#     npm global install (`npm i -g argos-harness`), so node is guaranteed on
#     any machine that ever ran `argos init` in the first place — unlike
#     navori-harness's per-repo hook, which had to assume nothing about the
#     target repo's toolchain.
#
# KNOWN, ACCEPTED LIMITATION (inherited from the original): matching is
# regex-based over the command string. Multi-line continuations, git global
# options (`git -C … commit`), and simple wrappers (`command`/`\git`/parens/
# quotes) are normalized before matching. Still unhandled: `sh -c`, `eval`,
# base64/printf obfuscation, and escaped-quote edge cases inside quoted
# spans. This guard is a SEATBELT against accidental destructive commands,
# NOT a sandbox against a deliberate adversary.
set -euo pipefail

payload=$(cat)
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

# Walk up from $CLAUDE_PROJECT_DIR (or cwd) looking for argos.config.json and
# read branchBase from it. No config / no field / unreadable → "main".
dir="${CLAUDE_PROJECT_DIR:-$PWD}"
config_path=""
while [ -n "$dir" ] && [ "$dir" != "/" ]; do
  if [ -f "$dir/argos.config.json" ]; then
    config_path="$dir/argos.config.json"
    break
  fi
  dir=$(dirname "$dir")
done

base="main"
if [ -n "$config_path" ]; then
  base=$(CONFIG_PATH="$config_path" node <<'NODE_EOF'
try {
  const fs = require("node:fs");
  const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf-8"));
  process.stdout.write(String((cfg && cfg.branchBase) || "main"));
} catch {
  process.stdout.write("main");
}
NODE_EOF
)
  [ -z "$base" ] && base="main"
fi

block() {
  echo "[argos] BLOQUEADO por argos-guard-destructive: $1" >&2
  echo "[argos] comando: $cmd" >&2
  echo "[argos] si es intencional, corre el comando vos mismo fuera del agente." >&2
  exit 2
}

# Normalized copy used ONLY by the hook-skip (1) and force-push (2) rules
# below (ported verbatim from navori-harness — see its own header comment
# for the fix-by-fix rationale of each transform). `$cmd` stays intact for
# the block messages and for rule 3 (rm -rf).
scan="$cmd"
scan="${scan//\\$'\n'/ }"     # join line continuations
scan="${scan//$'\n'/;}"       # flatten remaining newlines to a boundary
scan=$(printf '%s' "$scan" | sed -E \
  -e "s/'[^']*'//g" \
  -e 's/"[^"]*"//g' \
  -e "s/(^|[;&|]|[[:space:]])command[[:space:]]+/\1/g" \
  -e 's/\\([A-Za-z])/ \1/g' \
  -e 's/\(/ /g')

# 1. Skipping hooks/gates via --no-verify (defeats the whole point of this
#    guard existing). The `-[a-zA-Z]*n[a-zA-Z]*` arm also catches `-n` folded
#    into a combined short-flag token (e.g. `git commit -qn -m x`).
if printf '%s' "$scan" | grep -qE '(^|[[:space:]]|[;&|])git([[:space:]]+-[a-zA-Z-]+(=[^[:space:]]+)?([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+(commit|push)([[:space:]]|.)*(--no-verify|[[:space:]]-[a-zA-Z]*n[a-zA-Z]*([[:space:]]|$))'; then
  block "git commit/push con --no-verify (saltarse los hooks/gates)"
fi

# 2. Force-push to the repo's base branch (argos.config.json branchBase,
#    default "main"). force-with-lease stays allowed — it's the safe rebase
#    flow on feature branches, exactly the workflow this guard must NOT
#    punish.
if printf '%s' "$scan" | grep -qE '(^|[[:space:]]|[;&|])git([[:space:]]+-[a-zA-Z-]+(=[^[:space:]]+)?([[:space:]]+[^-][^[:space:]]*)?)*[[:space:]]+push' \
  && printf '%s' "$scan" | grep -qE '(--force([[:space:]]|$)|[[:space:]]-f([[:space:]]|$)|[[:space:]]\+)' \
  && ! printf '%s' "$scan" | grep -qE 'force-with-lease' \
  && printf '%s' "$scan" | grep -qE "(^|[[:space:]+/])${base}([[:space:]]|\$)"; then
  block "force-push a la rama base '${base}'"
fi

# 3. rm -rf with variable indirection or a bare absolute/home root — the
#    cases a relative path like `rm -rf node_modules` (legitimate, run from
#    inside the repo) never matches, so it stays allowed. A real absolute
#    path outside this narrow set (e.g. `rm -rf /tmp/scratch/foo`) is
#    intentionally left alone too: this is a seatbelt against the
#    "PATH=/; rm -rf $PATH" class of accident, not a generic path allowlist.
if printf '%s' "$cmd" | grep -qE '(^|[[:space:]])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*[[:space:]]+|-[a-zA-Z]*f[a-zA-Z]*[[:space:]]+)*-?[a-zA-Z]*[rf][a-zA-Z]*[[:space:]]+("?\$|/[[:space:]]*$|~[[:space:]]*$)'; then
  block "rm recursivo sobre variable / raíz / home"
fi

exit 0
