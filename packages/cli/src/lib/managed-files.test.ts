import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasArgosFileMarker, withFileMarker, writeManagedFile } from "./managed-files.js";

describe("hasArgosFileMarker", () => {
  it("is true when the marker is present, regardless of version", () => {
    expect(hasArgosFileMarker('<!-- argos:file v="1.0.0" -->\ncontent')).toBe(true);
    expect(hasArgosFileMarker('<!-- argos:file v="2.3.1" -->\ncontent')).toBe(true);
  });

  it("is false for foreign content with no marker", () => {
    expect(hasArgosFileMarker("# My own file\n")).toBe(false);
  });
});

describe("withFileMarker", () => {
  it("splices the marker right after a leading YAML frontmatter block", () => {
    const content = "---\nname: my-skill\ndescription: does things\n---\n\nBody text.\n";
    const result = withFileMarker(content, "1.0.0");

    expect(result).toBe(
      '---\nname: my-skill\ndescription: does things\n---\n<!-- argos:file v="1.0.0" -->\n\nBody text.\n',
    );
    // Frontmatter must stay the very first thing in the file.
    expect(result.startsWith("---\n")).toBe(true);
  });

  it("prefixes the marker when there is no frontmatter", () => {
    const content = "# Plain markdown\n\nNo frontmatter here.\n";
    const result = withFileMarker(content, "1.0.0");

    expect(result).toBe('<!-- argos:file v="1.0.0" -->\n\n# Plain markdown\n\nNo frontmatter here.\n');
  });

  it("does not match a non-leading '---' block as frontmatter", () => {
    const content = "Body first.\n\n---\nnot frontmatter\n---\n";
    const result = withFileMarker(content, "1.0.0");

    // No leading frontmatter → marker is prefixed, original content untouched after it.
    expect(result).toBe(`<!-- argos:file v="1.0.0" -->\n\n${content}`);
  });
});

describe("writeManagedFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-managed-files-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new file with the marker spliced in", () => {
    const dest = join(dir, "nested", "SKILL.md");
    const status = writeManagedFile(dest, "---\nname: x\n---\nBody.\n", "1.0.0");

    expect(status).toBe("created");
    expect(readFileSync(dest, "utf-8")).toContain('<!-- argos:file v="1.0.0" -->');
  });

  it("reports unchanged when the destination already has identical marked content", () => {
    const dest = join(dir, "SKILL.md");
    writeManagedFile(dest, "Body.\n", "1.0.0");
    const status = writeManagedFile(dest, "Body.\n", "1.0.0");

    expect(status).toBe("unchanged");
  });

  it("reports updated and overwrites when marked content differs (e.g. a version bump)", () => {
    const dest = join(dir, "SKILL.md");
    writeManagedFile(dest, "Body v1.\n", "1.0.0");
    const status = writeManagedFile(dest, "Body v2.\n", "1.1.0");

    expect(status).toBe("updated");
    expect(readFileSync(dest, "utf-8")).toContain("Body v2.");
  });

  it("reports skipped-foreign and never touches a file without the marker", () => {
    const dest = join(dir, "SKILL.md");
    const foreignContent = "Hand-written, no marker.\n";
    writeFileSync(dest, foreignContent, "utf-8");

    const status = writeManagedFile(dest, "Argos content.\n", "1.0.0");

    expect(status).toBe("skipped-foreign");
    expect(readFileSync(dest, "utf-8")).toBe(foreignContent);
  });
});
