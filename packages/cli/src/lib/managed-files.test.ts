import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hasArgosFileMarker,
  hasArgosShellFileMarker,
  SHELL_VERSION_PLACEHOLDER,
  withFileMarker,
  writeManagedFile,
  writeManagedShellFile,
} from "./managed-files.js";

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

  it("leaves no .tmp file behind after a write (atomic write, see lib/atomic-write.ts)", () => {
    const dest = join(dir, "SKILL.md");
    writeManagedFile(dest, "Body.\n", "1.0.0");
    writeManagedFile(dest, "Body v2.\n", "1.1.0"); // updated path too

    const residue = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(residue).toEqual([]);
  });

  describe("force", () => {
    it("overwrites a foreign file and stamps the marker, reporting overwritten-foreign", () => {
      const dest = join(dir, "SKILL.md");
      const foreignContent = "Hand-written, no marker.\n";
      writeFileSync(dest, foreignContent, "utf-8");

      const status = writeManagedFile(dest, "Argos content.\n", "1.0.0", { force: true });

      expect(status).toBe("overwritten-foreign");
      const written = readFileSync(dest, "utf-8");
      expect(written).toContain("Argos content.");
      expect(written).toContain('<!-- argos:file v="1.0.0" -->');
    });

    it("a subsequent non-forced run treats the now-marked file as owned (updated/unchanged, never skipped-foreign again)", () => {
      const dest = join(dir, "SKILL.md");
      writeFileSync(dest, "Hand-written, no marker.\n", "utf-8");
      writeManagedFile(dest, "Argos content.\n", "1.0.0", { force: true });

      const status = writeManagedFile(dest, "Argos content.\n", "1.0.0");

      expect(status).toBe("unchanged");
    });

    it("without force, an existing foreign file is still just skipped-foreign (default behavior unchanged)", () => {
      const dest = join(dir, "SKILL.md");
      const foreignContent = "Hand-written, no marker.\n";
      writeFileSync(dest, foreignContent, "utf-8");

      const status = writeManagedFile(dest, "Argos content.\n", "1.0.0", { force: false });

      expect(status).toBe("skipped-foreign");
      expect(readFileSync(dest, "utf-8")).toBe(foreignContent);
    });

    it("force has no effect on an already-owned file — still updated/unchanged, never overwritten-foreign", () => {
      const dest = join(dir, "SKILL.md");
      writeManagedFile(dest, "Body v1.\n", "1.0.0");

      const status = writeManagedFile(dest, "Body v2.\n", "1.1.0", { force: true });

      expect(status).toBe("updated");
    });
  });
});

describe("hasArgosShellFileMarker", () => {
  it("is true when the shell-comment marker is present, regardless of version", () => {
    expect(hasArgosShellFileMarker('#!/usr/bin/env bash\n# argos:file v="1.0.0"\necho hi\n')).toBe(true);
  });

  it("is false for a foreign shell script with no marker", () => {
    expect(hasArgosShellFileMarker("#!/usr/bin/env bash\necho hi\n")).toBe(false);
  });

  it("is false for the HTML-comment marker form (a different asset kind)", () => {
    expect(hasArgosShellFileMarker('<!-- argos:file v="1.0.0" -->\ncontent')).toBe(false);
  });
});

describe("writeManagedShellFile", () => {
  let dir: string;
  const source = `#!/usr/bin/env bash\n# argos:file v="${SHELL_VERSION_PLACEHOLDER}"\necho hi\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-managed-shell-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a new file, stamps the real version, and chmods it executable", () => {
    const dest = join(dir, "hooks", "argos-guard-destructive.sh");
    const status = writeManagedShellFile(dest, source, "1.2.3");

    expect(status).toBe("created");
    const content = readFileSync(dest, "utf-8");
    expect(content).toContain('# argos:file v="1.2.3"');
    expect(content).not.toContain(SHELL_VERSION_PLACEHOLDER);
    expect(statSync(dest).mode & 0o777).toBe(0o755);
  });

  it("reports unchanged when the destination already has identical stamped content", () => {
    const dest = join(dir, "hook.sh");
    writeManagedShellFile(dest, source, "1.0.0");
    const status = writeManagedShellFile(dest, source, "1.0.0");

    expect(status).toBe("unchanged");
  });

  it("reports updated and overwrites when the stamped version differs", () => {
    const dest = join(dir, "hook.sh");
    writeManagedShellFile(dest, source, "1.0.0");
    const status = writeManagedShellFile(dest, source, "1.1.0");

    expect(status).toBe("updated");
    expect(readFileSync(dest, "utf-8")).toContain('# argos:file v="1.1.0"');
  });

  it("reports skipped-foreign and never touches a shell script without the marker", () => {
    const dest = join(dir, "hook.sh");
    const foreignContent = "#!/usr/bin/env bash\necho hand-written\n";
    writeFileSync(dest, foreignContent, "utf-8");

    const status = writeManagedShellFile(dest, source, "1.0.0");

    expect(status).toBe("skipped-foreign");
    expect(readFileSync(dest, "utf-8")).toBe(foreignContent);
  });

  it("re-asserts the executable bit even when content is unchanged", () => {
    const dest = join(dir, "hook.sh");
    writeManagedShellFile(dest, source, "1.0.0");
    chmodSync(dest, 0o644); // simulate drift (e.g. a user ran chmod -x)

    const status = writeManagedShellFile(dest, source, "1.0.0");

    expect(status).toBe("unchanged");
    expect(statSync(dest).mode & 0o777).toBe(0o755);
  });

  describe("force", () => {
    it("overwrites a foreign hook script and stamps the marker, reporting overwritten-foreign", () => {
      const dest = join(dir, "hook.sh");
      const foreignContent = "#!/usr/bin/env bash\necho hand-written\n";
      writeFileSync(dest, foreignContent, "utf-8");

      const status = writeManagedShellFile(dest, source, "1.0.0", { force: true });

      expect(status).toBe("overwritten-foreign");
      const written = readFileSync(dest, "utf-8");
      expect(written).toContain('# argos:file v="1.0.0"');
      expect(statSync(dest).mode & 0o777).toBe(0o755);
    });

    it("without force, an existing foreign hook script is still just skipped-foreign", () => {
      const dest = join(dir, "hook.sh");
      const foreignContent = "#!/usr/bin/env bash\necho hand-written\n";
      writeFileSync(dest, foreignContent, "utf-8");

      const status = writeManagedShellFile(dest, source, "1.0.0", { force: false });

      expect(status).toBe("skipped-foreign");
      expect(readFileSync(dest, "utf-8")).toBe(foreignContent);
    });
  });
});
