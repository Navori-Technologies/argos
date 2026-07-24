/**
 * Argos managed-block primitives for Markdown files.
 *
 * Block format:
 *   <!-- argos:managed id="<id>" v="<version>" -->
 *   ...content...
 *   <!-- argos:managed end id="<id>" -->
 *
 * HARD RULE: never modify anything outside argos markers. Foreign file
 * content (anything the user wrote, or another tool's own markers) is
 * untouchable — every function here only reads/writes inside its own
 * `id`'s block boundaries.
 *
 * KNOWN LIMITATION: ownership here is purely text-pattern based — anything
 * that quotes the exact marker comment text (e.g. `<!-- argos:managed id="x"
 * v="1" -->`) inside otherwise-foreign content is indistinguishable from a
 * real Argos block and can be spoofed or accidentally matched. This is a
 * deliberate tradeoff for staying dependency-free; the mitigation is that
 * every mutation site backs up the file before touching it (see
 * `createBackup` usage in `init.ts`/`adopt.ts`), so a bad match is always
 * recoverable.
 */

const OPEN_PREFIX = '<!-- argos:managed id="';
const CLOSE_PREFIX = '<!-- argos:managed end id="';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function openMarker(id: string, version: string): string {
  return `<!-- argos:managed id="${id}" v="${version}" -->`;
}

function closeMarker(id: string): string {
  return `${CLOSE_PREFIX}${id}" -->`;
}

interface BlockMatch {
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  version: string | null;
  content: string;
}

/** Find the first block with `id` starting at or after `fromIndex`. */
function findBlockFrom(fileContent: string, id: string, fromIndex: number): BlockMatch | null {
  const openRegex = new RegExp(
    `${escapeRegex(OPEN_PREFIX)}${escapeRegex(id)}"(?:\\s+v="([^"]*)")?\\s*-->`,
    "g",
  );
  openRegex.lastIndex = fromIndex;
  const openMatch = openRegex.exec(fileContent);
  if (!openMatch) return null;

  const close = closeMarker(id);
  const openEnd = openMatch.index + openMatch[0].length;
  const closeStart = fileContent.indexOf(close, openEnd);
  if (closeStart < 0) return null;

  const rawContent = fileContent.slice(openEnd, closeStart);
  const content = rawContent.replace(/^\n/, "").replace(/\n$/, "");

  return {
    openStart: openMatch.index,
    openEnd,
    closeStart,
    closeEnd: closeStart + close.length,
    version: openMatch[1] ?? null,
    content,
  };
}

function findBlock(fileContent: string, id: string): BlockMatch | null {
  return findBlockFrom(fileContent, id, 0);
}

/** Find every block with `id`, in document order. Duplicates included. */
function findAllBlocks(fileContent: string, id: string): BlockMatch[] {
  const blocks: BlockMatch[] = [];
  let fromIndex = 0;
  for (;;) {
    const match = findBlockFrom(fileContent, id, fromIndex);
    if (!match) break;
    blocks.push(match);
    fromIndex = match.closeEnd;
  }
  return blocks;
}

export interface InjectBlockResult {
  content: string;
  /** Count of duplicate blocks (beyond the first) removed by this call. */
  healedDuplicates: number;
}

/**
 * Insert or update a managed block by id, self-healing duplicate blocks left
 * behind by crash residue (e.g. a process killed mid-write that appended a
 * second block instead of replacing the first).
 * - No existing block with this id → append at the end, separated by a
 *   blank line from whatever precedes it.
 * - One or more existing blocks with this id → replace the FIRST one's open
 *   marker (version) and body in place, and remove every other block sharing
 *   the id; everything else before/after is untouched.
 */
export function injectBlockDetailed(
  fileContent: string,
  id: string,
  version: string,
  content: string,
): InjectBlockResult {
  const block = `${openMarker(id, version)}\n${content}\n${closeMarker(id)}`;
  const matches = findAllBlocks(fileContent, id);

  if (matches.length === 0) {
    if (fileContent.length === 0) return { content: `${block}\n`, healedDuplicates: 0 };
    const sep = fileContent.endsWith("\n\n") ? "" : fileContent.endsWith("\n") ? "\n" : "\n\n";
    return { content: `${fileContent}${sep}${block}\n`, healedDuplicates: 0 };
  }

  const first = matches[0]!;

  // Drop every duplicate after the first, from the end backwards so offsets
  // computed against the original `fileContent` (including `first`'s, which
  // always sit before every duplicate) stay valid throughout.
  let healed = fileContent;
  for (let i = matches.length - 1; i >= 1; i--) {
    const dup = matches[i]!;
    let endCut = dup.closeEnd;
    if (healed[endCut] === "\n") endCut++;
    let startCut = dup.openStart;
    if (healed.slice(0, startCut).endsWith("\n\n")) startCut -= 1;
    healed = healed.slice(0, startCut) + healed.slice(endCut);
  }

  const result = healed.slice(0, first.openStart) + block + healed.slice(first.closeEnd);
  return { content: result, healedDuplicates: matches.length - 1 };
}

/** String-only convenience wrapper over `injectBlockDetailed` for existing call sites. */
export function injectBlock(fileContent: string, id: string, version: string, content: string): string {
  return injectBlockDetailed(fileContent, id, version, content).content;
}

/**
 * Remove a managed block by id. No-op if the block does not exist.
 * Also removes a single trailing newline so removal doesn't leave a
 * double-blank line behind.
 */
export function removeBlock(fileContent: string, id: string): string {
  const match = findBlock(fileContent, id);
  if (!match) return fileContent;

  let endCut = match.closeEnd;
  if (fileContent[endCut] === "\n") endCut++;

  // Collapse the blank-line separator injectBlock adds before an appended
  // block, so removing a cleanly-appended block restores the original bytes
  // instead of leaving a stray blank line behind.
  let startCut = match.openStart;
  if (fileContent.slice(0, startCut).endsWith("\n\n")) startCut -= 1;

  return fileContent.slice(0, startCut) + fileContent.slice(endCut);
}

export interface ListedBlock {
  id: string;
  version: string | null;
}

/** Enumerate every managed block found in `fileContent`, in document order. */
export function listBlocks(fileContent: string): ListedBlock[] {
  const openRegex = new RegExp(
    `${escapeRegex(OPEN_PREFIX)}([^"]+)"(?:\\s+v="([^"]*)")?\\s*-->`,
    "g",
  );
  const blocks: ListedBlock[] = [];
  for (const m of fileContent.matchAll(openRegex)) {
    blocks.push({ id: m[1]!, version: m[2] ?? null });
  }
  return blocks;
}

/**
 * Ids of every block whose OPEN marker in `fileContent` has no matching
 * CLOSE marker anywhere in the file — a dangling/unclosed block, usually
 * crash residue or hand-edited corruption. `listBlocks` alone can't answer
 * this: it only scans for open markers and doesn't verify a close exists
 * (see its implementation above), which is exactly why a dangling block
 * still shows up as "present" there. Callers that need to remove blocks
 * (see `removeBlock`) must guard against this: a dangling id makes
 * `removeBlock` a no-op forever, since there is nothing valid to cut.
 */
export function listDanglingBlockIds(fileContent: string): string[] {
  const ids = new Set(listBlocks(fileContent).map((b) => b.id));
  const dangling: string[] = [];
  for (const id of ids) {
    if (findBlock(fileContent, id) === null) dangling.push(id);
  }
  return dangling;
}
