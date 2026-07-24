import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the Argos state directory (`~/.argos` by default).
 * Overridable via `ARGOS_HOME` so tests never touch the real home directory.
 */
export function resolveArgosHome(): string {
  return process.env.ARGOS_HOME || join(homedir(), ".argos");
}

/**
 * Resolve the Claude Code config directory (`~/.claude` by default).
 * Overridable via `CLAUDE_CONFIG_DIR` so tests never touch the real home directory.
 */
export function resolveClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
