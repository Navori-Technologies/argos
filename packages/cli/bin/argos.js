#!/usr/bin/env node
// Thin, committed entrypoint for the `argos` binary.
// dist/index.js is ESM and runs the CLI as a side effect of being imported
// (it calls citty's runMain() at module-eval time), so importing it here
// is enough to actually execute the CLI — no exported function to call.
await import("../dist/index.js");
