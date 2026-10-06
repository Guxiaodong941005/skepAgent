import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";

/** `skep agent start|stop [--role-dir <dir>]` (PRD §15.2, §7.1). */
export function register(program: Command, _ctx: CliContext): void {
  const agent = program.command("agent").description("Start or stop a role slot");

  agent
    .command("start")
    .description("Register and start the slot for a role directory")
    .option("--role-dir <dir>", "role directory (defaults to the current directory)")
    .action(() => {
      notImplemented("agent start");
    });

  agent
    .command("stop")
    .description("Stop the slot (interrupt ladder, then checkpoint)")
    .option("--role-dir <dir>", "role directory (defaults to the current directory)")
    .action(() => {
      notImplemented("agent stop");
    });
}
