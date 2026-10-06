import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";
import { parseTaskId } from "../validate.js";

/** `skep log <task>` — the blackboard event stream (PRD §15.2). */
export function register(program: Command, _ctx: CliContext): void {
  program
    .command("log")
    .description("Show the event stream of a task")
    .argument("<task>", "task id", parseTaskId)
    .action(() => {
      notImplemented("log");
    });
}
