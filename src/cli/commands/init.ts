import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";
import { parseDeviceName } from "../validate.js";

/** `skep init --device <name> --blackboard <url>` (PRD §15.2). */
export function register(program: Command, _ctx: CliContext): void {
  program
    .command("init")
    .description("Set up this device: write device.toml, generate the daemon key")
    .requiredOption("--device <name>", "device name", parseDeviceName)
    .requiredOption("--blackboard <url>", "blackboard remote url")
    .action(() => {
      notImplemented("init");
    });
}
