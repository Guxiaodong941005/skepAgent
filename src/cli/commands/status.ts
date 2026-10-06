import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";

/** `skep status` (PRD §15.1, §15.2). Global `--machine` selects the JSON view. */
export function register(program: Command, _ctx: CliContext): void {
  program
    .command("status")
    .description("Show the derived view of tasks, items, and agents")
    .action(() => {
      notImplemented("status");
    });
}
