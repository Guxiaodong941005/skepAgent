import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";
import { parsePositiveInt, parseTaskId } from "../validate.js";

/** `skep plan show|approve|reject` (PRD §15.2). */
export function register(program: Command, _ctx: CliContext): void {
  const plan = program.command("plan").description("Inspect or approve a plan");

  plan
    .command("show")
    .description("Show a task's plan, reviews, and overrides")
    .argument("<task>", "task id", parseTaskId)
    .option("--version <n>", "plan version (default: current)", parsePositiveInt)
    .option("--diff", "include the diff against the previous version")
    .action(() => {
      notImplemented("plan show");
    });

  plan
    .command("approve")
    .description("Approve the current plan hash")
    .argument("<task>", "task id", parseTaskId)
    .option("--note <text>", "note recorded with the decision")
    .action(() => {
      notImplemented("plan approve");
    });

  plan
    .command("reject")
    .description("Reject the current plan")
    .argument("<task>", "task id", parseTaskId)
    .option("--note <text>", "note recorded with the decision")
    .action(() => {
      notImplemented("plan reject");
    });
}
