import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MARKER_PREFIX = '<!-- argos:file v="';
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

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
    writeFileSync(destPath, finalContent, "utf-8");
    return "created";
  }

  const current = readFileSync(destPath, "utf-8");
  if (!hasArgosFileMarker(current)) return "skipped-foreign";
  if (current === finalContent) return "unchanged";

  writeFileSync(destPath, finalContent, "utf-8");
  return "updated";
}
