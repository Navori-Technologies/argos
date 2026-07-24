import { defineCommand, runMain } from "citty";
import { initCommand } from "./commands/init.js";
import { adoptCommand } from "./commands/adopt.js";
import { doctorCommand } from "./commands/doctor.js";
import { workspaceCommand } from "./commands/workspace.js";
import { readCliVersion } from "./lib/version.js";

const main = defineCommand({
  meta: {
    name: "argos",
    version: readCliVersion(),
    description: "Argos — global-first harness for Claude Code",
  },
  subCommands: {
    init: initCommand,
    adopt: adoptCommand,
    doctor: doctorCommand,
    workspace: workspaceCommand,
  },
});

runMain(main);
