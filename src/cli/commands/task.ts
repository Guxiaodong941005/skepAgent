import type { Command } from "commander";
import type { IntentSpec } from "../../core/intent-spec.js";
import { titleFromBody } from "../../core/intents-human.js";
import type { CliContext } from "../context.js";
import { isPredominantlyNonLatin } from "../language.js";
import { CliError, EXIT } from "../output.js";
import { publishHuman } from "../publish.js";
import { reportPublished } from "../publish-output.js";
import { parseAgentId, parseTaskId } from "../validate.js";

/**
 * `skep task new|cancel` (PRD §15.2).
 *
 * `task new` enforces the English-body guardrail (PRD §14) before anything is published. The
 * original non-English text is kept on the event for audit and the English body is what agents
 * receive; `--allow-non-english` is the explicit override.
 */
export function register(program: Command, ctx: CliContext): void {
  const task = program.command("task").description("Create or cancel a task");

  task
    .command("new")
    .description("Create a task from an English description")
    .argument("<text>", "task description (English)")
    .requiredOption("--repo <name>", "allowlisted code repo name")
    .option("--owner <agentId>", "owning agent", parseAgentId)
    .option("--team", "team mode (default is the solo fast path)")
    .option("--allow-non-english", "allow a predominantly non-Latin task body")
    .action(async (text: string, opts: NewOptions) => {
      if (!opts.allowNonEnglish && isPredominantlyNonLatin(text)) {
        throw new CliError(
          "non_english_task",
          "task text is predominantly non-Latin; pass --allow-non-english to override",
          EXIT.usage,
        );
      }
      reportPublished(ctx, await publishHuman(ctx, taskCreateSpec(text, opts)));
    });

  task
    .command("cancel")
    .description("Cancel a task")
    .argument("<task>", "task id", parseTaskId)
    .requiredOption("--reason <text>", "why the task is being cancelled")
    .action(async (taskId: string, opts: { reason: string }) => {
      reportPublished(
        ctx,
        await publishHuman(ctx, { kind: "task.cancel", task: taskId, reason: opts.reason }),
      );
    });
}

interface NewOptions {
  repo: string;
  owner?: string;
  team?: boolean;
  allowNonEnglish?: boolean;
}

/**
 * The spec states the ask; the intent re-derives the task id, budgets and owner (PRD §9.1).
 * Non-English text is recorded as `original_text` and replaced by a pointer, so the body agents
 * read stays English (PRD §14).
 */
function taskCreateSpec(text: string, opts: NewOptions): IntentSpec {
  const nonEnglish = isPredominantlyNonLatin(text);
  return {
    kind: "task.create",
    title: titleFromBody(nonEnglish ? "Task" : text),
    body: nonEnglish ? "See original_text; an English body was not provided." : text,
    repo: opts.repo,
    mode: opts.team ? "team" : "solo",
    ...(opts.owner === undefined ? {} : { owner: opts.owner }),
    ...(nonEnglish ? { original_text: text, original_lang: "und" } : {}),
  };
}
