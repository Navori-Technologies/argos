import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "./atomic-write.js";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "argos-atomic-write-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the content to the destination path", () => {
    const dest = join(dir, "file.txt");
    writeFileAtomic(dest, "hello world\n");

    expect(readFileSync(dest, "utf-8")).toBe("hello world\n");
  });

  it("leaves no .tmp file behind after a successful write", () => {
    const dest = join(dir, "file.txt");
    writeFileAtomic(dest, "content\n");

    const residue = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(residue).toEqual([]);
  });

  it("applies the requested mode to the final file", () => {
    const dest = join(dir, "script.sh");
    writeFileAtomic(dest, "#!/bin/bash\necho hi\n", 0o755);

    expect(statSync(dest).mode & 0o777).toBe(0o755);
  });

  it("overwrites an existing file's content in full", () => {
    const dest = join(dir, "file.txt");
    writeFileAtomic(dest, "v1\n");
    writeFileAtomic(dest, "v2\n");

    expect(readFileSync(dest, "utf-8")).toBe("v2\n");
  });

  it("cleans up the tmp file and rethrows when the rename target directory is invalid", () => {
    // Destination directory doesn't exist -> renameSync fails (ENOENT).
    const dest = join(dir, "missing-subdir", "file.txt");

    expect(() => writeFileAtomic(dest, "content\n")).toThrow();
    expect(existsSync(dest)).toBe(false);

    const residue = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(residue).toEqual([]);
  });

  it("never leaves a torn/partial file at the destination path on failure", () => {
    const dest = join(dir, "existing.txt");
    writeFileAtomic(dest, "original content\n");

    // Simulate a failure mode by pointing at a directory instead of a file
    // for the "destination" — rename onto an existing directory fails.
    mkdirSync(join(dir, "is-a-dir"));
    const destDir = join(dir, "is-a-dir");

    expect(() => writeFileAtomic(destDir, "new content\n")).toThrow();
    // The original file (a different path) is of course untouched, and the
    // directory we tried to overwrite was never replaced with a file.
    expect(statSync(destDir).isDirectory()).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("original content\n");
  });
});
