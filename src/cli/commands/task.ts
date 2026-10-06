import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { isPredominantlyNonLatin } from "../language.js";
import { CliError, EXIT, notImplemented } from "../output.js";
import { parseAgentId, parseTaskId } from "../validate.js";

/**
 * `skep task new|cancel` (PRD §15.2).
 *
 * `task new` enforces the English-body guardrail (PRD §14) before the not-implemented stub, so
 * the language check is real even while publishing is not.
 */
export function register(program: Command, _ctx: CliContext): void {
  const task = program.command("task").description("Create or cancel a task");

  task
    .command("new")
    .description("Create a task from an English description")
    .argument("<text>", "task description (English)")
    .requiredOption("--repo <name>", "allowlisted code repo name")
    .option("--owner <agentId>", "owning agent", parseAgentId)
    .option("--team", "team mode (default is the solo fast path)")
    .option("--allow-non-english", "allow a predominantly non-Latin task body")
    .action((text: string, opts: { allowNonEnglish?: boolean }) => {
      if (!opts.allowNonEnglish && isPredominantlyNonLatin(text)) {
        throw new CliError(
          "non_english_task",
          "task text is predominantly non-Latin; pass --allow-non-english to override",
          EXIT.usage,
        );
      }
      notImplemented("task new");
    });

  task
    .command("cancel")
    .description("Cancel a task")
    .argument("<task>", "task id", parseTaskId)
    .requiredOption("--reason <text>", "why the task is being cancelled")
    .action(() => {
      notImplemented("task cancel");
    });
}
