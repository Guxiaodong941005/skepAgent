import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";
import { parseTaskId } from "../validate.js";

/** `skep replan <task> --reason <text> [--evidence <file>...]` (PRD §15.2). */
export function register(program: Command, _ctx: CliContext): void {
  program
    .command("replan")
    .description("Request a coarse replan of a task")
    .argument("<task>", "task id", parseTaskId)
    .requiredOption("--reason <text>", "why a replan is needed")
    .option("--evidence <file...>", "evidence files supporting the request")
    .action(() => {
      notImplemented("replan");
    });
}
