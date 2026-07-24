import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePackageRoot } from "./package-root.js";

/** Read the `@argos/cli` package version (used to stamp every marker Argos writes). */
export function readCliVersion(fromUrl: string = import.meta.url): string {
  try {
    const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(fromUrl), "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
