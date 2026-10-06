import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { publishHuman } from "../publish.js";
import { reportPublished } from "../publish-output.js";
import { parseTaskId } from "../validate.js";

/**
 * `skep replan <task> --reason <text> [--evidence <file>...]` (PRD §15.2).
 *
 * A human replan needs no machine evidence (PRD §9.9); the files name where the human looked and
 * travel inside the summary, since evidence items must be daemon-verifiable commits or journal
 * entries and a path the human typed is neither.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("replan")
    .description("Request a coarse replan of a task")
    .argument("<task>", "task id", parseTaskId)
    .requiredOption("--reason <text>", "why a replan is needed")
    .option(
      "--evidence <file...>",
      "files supporting the request (paths only, recorded in the summary; not verified evidence)",
    )
    .action(async (taskId: string, opts: { reason: string; evidence?: string[] }) => {
      reportPublished(
        ctx,
        await publishHuman(ctx, {
          kind: "replan.request",
          task: taskId,
          reason: summary(opts.reason, opts.evidence),
        }),
      );
    });
}

/** The reason, plus the files the human pointed at, kept inside the schema's length limit. */
function summary(reason: string, files: string[] | undefined): string {
  if (files === undefined || files.length === 0) return reason;
  const text = `${reason}\nfiles: ${files.join(", ")}`;
  return text.length > 4000 ? text.slice(0, 4000) : text;
}
