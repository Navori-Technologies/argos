import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

const MARKER_PREFIX = '<!-- argos:file v="';
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

// Shell assets (hooks) can't carry the HTML-comment marker above (`.sh` has
// no such syntax) or YAML frontmatter, so they get their own shell-comment
// marker form: `# argos:file v="<version>"`, hardcoded as the literal first
// line after the shebang in the asset source (see assets/hooks/*.sh) with a
// `SHELL_VERSION_PLACEHOLDER` token in place of the version — stamped with
// the real version at install time by `writeManagedShellFile`.
const SHELL_MARKER_PREFIX = '# argos:file v="';
export const SHELL_VERSION_PLACEHOLDER = "__ARGOS_VERSION__";

function fileMarker(version: string): string {
  return `${MARKER_PREFIX}${version}" -->`;
}

/** True when `content` carries an `argos:file` ownership marker (any version). */
export function hasArgosFileMarker(content: string): boolean {
  return content.includes(MARKER_PREFIX);
}

/**
 * Insert the `argos:file` marker immediately after the leading YAML
 * frontmatter block, so the frontmatter stays the very first thing in the
 * file (required by tools that parse it, e.g. Claude Code agents/skills).
 * Falls back to prefixing the marker when there is no frontmatter.
 */
export function withFileMarker(content: string, version: string): string {
  const marker = fileMarker(version);
  const fmMatch = FRONTMATTER_RE.exec(content);
  if (!fmMatch) return `${marker}\n\n${content}`;
  const frontmatter = fmMatch[0];
  const rest = content.slice(frontmatter.length);
  return `${frontmatter}${marker}\n${rest}`;
}

export type FileStatus = "created" | "updated" | "unchanged" | "skipped-foreign";

/**
 * Write a full-file Argos-owned asset (agent, skill, output-style) to
 * `destPath`, honoring the ownership marker policy:
 * - absent → write it (created)
 * - present with the argos:file marker → overwrite (updated/unchanged)
 * - present without the marker (foreign) → never touch it (skipped-foreign)
 */
export function writeManagedFile(destPath: string, sourceContent: string, version: string): FileStatus {
  const finalContent = withFileMarker(sourceContent, version);

  if (!existsSync(destPath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileAtomic(destPath, finalContent);
    return "created";
  }

  const current = readFileSync(destPath, "utf-8");
  if (!hasArgosFileMarker(current)) return "skipped-foreign";
  if (current === finalContent) return "unchanged";

  writeFileAtomic(destPath, finalContent);
  return "updated";
}

/** True when `content` carries a shell-comment `# argos:file` ownership marker (any version). */
export function hasArgosShellFileMarker(content: string): boolean {
  return content.includes(SHELL_MARKER_PREFIX);
}

/**
 * Write a full-file Argos-owned shell script (a hook) to `destPath`.
 * `sourceContent` must already contain the literal
 * `# argos:file v="__ARGOS_VERSION__"` marker line as the first line after
 * the shebang (see assets/hooks/*.sh) — this stamps it with the real
 * `version` (simple placeholder replace, no structural splicing needed since
 * the marker line is already in the right place in the source) and chmods
 * the result executable (0o755). Same ownership policy as `writeManagedFile`:
 * - absent → write it (created)
 * - present with the shell marker → overwrite (updated/unchanged)
 * - present without the marker (foreign) → never touch it (skipped-foreign)
 */
export function writeManagedShellFile(destPath: string, sourceContent: string, version: string): FileStatus {
  const finalContent = sourceContent.replaceAll(SHELL_VERSION_PLACEHOLDER, version);

  if (!existsSync(destPath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileAtomic(destPath, finalContent, 0o755);
    return "created";
  }

  const current = readFileSync(destPath, "utf-8");
  if (!hasArgosShellFileMarker(current)) return "skipped-foreign";

  if (current === finalContent) {
    // Re-assert the executable bit even when content is unchanged, in case
    // it drifted (e.g. a user ran `chmod -x` on it by hand). Best-effort:
    // hooks are invoked as `bash "<path>"` (see lib/settings-merge.ts), so
    // the executable bit is inert for Claude Code's own purposes — a chmod
    // failure here (e.g. EPERM on an unusual filesystem) shouldn't fail the
    // whole `argos init` run over a cosmetic permission bit.
    try {
      chmodSync(destPath, 0o755);
    } catch {
      // Swallowed on purpose — see comment above.
    }
    return "unchanged";
  }

  writeFileAtomic(destPath, finalContent, 0o755);
  return "updated";
}
