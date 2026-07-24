import { describe, expect, it } from "vitest";
import { injectBlock, injectBlockDetailed, listBlocks, listDanglingBlockIds, removeBlock } from "./markers.js";

describe("injectBlock", () => {
  it("appends a new block to an empty file", () => {
    const result = injectBlock("", "identity", "1.0.0", "You are Argos.");
    expect(result).toBe(
      '<!-- argos:managed id="identity" v="1.0.0" -->\nYou are Argos.\n<!-- argos:managed end id="identity" -->\n',
    );
  });

  it("appends a new block after existing foreign content, separated by a blank line", () => {
    const foreign = "# My project\n\nSome notes I wrote by hand.\n";
    const result = injectBlock(foreign, "identity", "1.0.0", "You are Argos.");
    expect(result).toBe(
      `${foreign}\n<!-- argos:managed id="identity" v="1.0.0" -->\nYou are Argos.\n<!-- argos:managed end id="identity" -->\n`,
    );
  });

  it("replaces an existing block's content and version in place", () => {
    const original = injectBlock("", "identity", "1.0.0", "You are Argos.");
    const updated = injectBlock(original, "identity", "1.1.0", "You are Argos, updated.");
    expect(updated).toBe(
      '<!-- argos:managed id="identity" v="1.1.0" -->\nYou are Argos, updated.\n<!-- argos:managed end id="identity" -->\n',
    );
  });

  it("preserves foreign content byte-exact outside the managed block", () => {
    const foreign = "# My project\n\nSome notes I wrote by hand.\n";
    const withBlock = injectBlock(foreign, "identity", "1.0.0", "You are Argos.");
    const updated = injectBlock(withBlock, "identity", "2.0.0", "You are Argos v2.");

    expect(updated.startsWith(foreign)).toBe(true);
    expect(updated).toContain("v2");
  });

  it("preserves foreign content that sits AFTER the managed block", () => {
    const withBlock = injectBlock("", "identity", "1.0.0", "You are Argos.");
    const withTrailer = `${withBlock}\n## Project notes\n\nDo not touch this.\n`;
    const updated = injectBlock(withTrailer, "identity", "2.0.0", "You are Argos v2.");

    expect(updated).toContain("## Project notes\n\nDo not touch this.\n");
    expect(updated).toContain("You are Argos v2.");
  });

  it("is idempotent — injecting the same id/version/content twice yields the same bytes", () => {
    const once = injectBlock("", "identity", "1.0.0", "You are Argos.");
    const twice = injectBlock(once, "identity", "1.0.0", "You are Argos.");
    expect(twice).toBe(once);
  });

  it("keeps two different block ids independent", () => {
    let content = injectBlock("", "identity", "1.0.0", "You are Argos.");
    content = injectBlock(content, "voice", "1.0.0", "Speak plainly.");
    expect(content).toContain('id="identity"');
    expect(content).toContain('id="voice"');

    const updated = injectBlock(content, "identity", "1.1.0", "You are Argos, revised.");
    expect(updated).toContain("Speak plainly.");
    expect(updated).toContain("You are Argos, revised.");
  });
});

describe("removeBlock", () => {
  it("removes an existing block and its trailing newline", () => {
    const withBlock = injectBlock("# Header\n", "identity", "1.0.0", "You are Argos.");
    const removed = removeBlock(withBlock, "identity");
    expect(removed).toBe("# Header\n");
  });

  it("is a no-op when the block does not exist", () => {
    const content = "# Header\n\nSome text.\n";
    expect(removeBlock(content, "identity")).toBe(content);
  });

  it("does not touch a different block id", () => {
    let content = injectBlock("", "identity", "1.0.0", "You are Argos.");
    content = injectBlock(content, "voice", "1.0.0", "Speak plainly.");
    const removed = removeBlock(content, "identity");
    expect(removed).not.toContain('id="identity"');
    expect(removed).toContain('id="voice"');
  });
});

describe("listBlocks", () => {
  it("returns an empty array for a file with no managed blocks", () => {
    expect(listBlocks("# Just prose\n")).toEqual([]);
  });

  it("lists every managed block with its id and version", () => {
    let content = injectBlock("", "identity", "1.0.0", "You are Argos.");
    content = injectBlock(content, "voice", "2.3.0", "Speak plainly.");
    expect(listBlocks(content)).toEqual([
      { id: "identity", version: "1.0.0" },
      { id: "voice", version: "2.3.0" },
    ]);
  });
});

describe("injectBlockDetailed — duplicate healing", () => {
  function duplicated(id: string): string {
    // Simulate crash residue: two full blocks sharing the same id.
    const one = injectBlock("", id, "1.0.0", "First copy.");
    const two = injectBlock("", id, "1.0.0", "Second copy.");
    return `${one}\n${two}`;
  }

  it("collapses 2+ duplicate blocks into exactly one on inject", () => {
    const content = duplicated("identity");
    expect(listBlocks(content).filter((b) => b.id === "identity")).toHaveLength(2);

    const result = injectBlockDetailed(content, "identity", "1.1.0", "Healed.");

    expect(listBlocks(result.content).filter((b) => b.id === "identity")).toHaveLength(1);
    expect(result.healedDuplicates).toBe(1);
    expect(result.content).toContain("Healed.");
    expect(result.content).not.toContain("First copy.");
    expect(result.content).not.toContain("Second copy.");
  });

  it("is idempotent — injecting again on the healed content heals nothing further", () => {
    const content = duplicated("identity");
    const first = injectBlockDetailed(content, "identity", "1.1.0", "Healed.");
    const second = injectBlockDetailed(first.content, "identity", "1.1.0", "Healed.");

    expect(second.healedDuplicates).toBe(0);
    expect(second.content).toBe(first.content);
  });

  it("reports zero healedDuplicates and is unaffected by an unrelated block id", () => {
    let content = injectBlock("", "identity", "1.0.0", "You are Argos.");
    content = injectBlock(content, "voice", "1.0.0", "Speak plainly.");

    const result = injectBlockDetailed(content, "identity", "1.1.0", "Updated.");

    expect(result.healedDuplicates).toBe(0);
    expect(result.content).toContain('id="voice"');
  });
});

describe("listDanglingBlockIds", () => {
  it("returns an empty array when every block is properly closed", () => {
    let content = injectBlock("", "identity", "1.0.0", "You are Argos.");
    content = injectBlock(content, "voice", "1.0.0", "Speak plainly.");
    expect(listDanglingBlockIds(content)).toEqual([]);
  });

  it("returns an empty array for a file with no managed blocks at all", () => {
    expect(listDanglingBlockIds("# Just prose\n")).toEqual([]);
  });

  it("flags an id whose open marker has no matching close marker", () => {
    const dangling = `<!-- argos:managed id="identidad" v="1.0.0" -->\nSome content, never closed.\n`;
    expect(listDanglingBlockIds(dangling)).toEqual(["identidad"]);
  });

  it("only flags the dangling id, leaving a properly-closed sibling block out", () => {
    const content = `${injectBlock("", "voice", "1.0.0", "Speak plainly.")}\n<!-- argos:managed id="identidad" v="1.0.0" -->\nNever closed.\n`;
    expect(listDanglingBlockIds(content)).toEqual(["identidad"]);
  });
});
