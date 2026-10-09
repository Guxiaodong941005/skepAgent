import { type Command, Option } from "commander";
import { WorkSubmittedPayload } from "../../core/schemas/events.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";
import { publishHuman } from "../publish.js";
import { reportPublished } from "../publish-output.js";
import { parseItemId, parsePositiveInt, parseTaskId } from "../validate.js";

interface SubmitOptions {
  method?: "pr" | "mr" | "push" | "none";
  epoch?: number;
  prUrl?: string;
  prNumber?: number;
  skip?: boolean;
}

/** Record the human's later submission decision through the fresh-state publisher (§12). */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("submit")
    .description("Record submission of an item delivered with ask")
    .argument("<task>", "task id", parseTaskId)
    .argument("<item>", "work item id", parseItemId)
    .addOption(
      new Option("--method <method>", "submission method").choices(["pr", "mr", "push", "none"]),
    )
    .option("--epoch <n>", "delivered epoch", parsePositiveInt)
    .option("--pr-url <url>", "already opened PR or MR URL")
    .option("--pr-number <n>", "already opened PR or MR number", parsePositiveInt)
    .option("--skip", "skip submission")
    .action(async (task: string, item: string, opts: SubmitOptions) => {
      if (opts.skip && opts.method !== undefined && opts.method !== "none")
        throw new CliError("usage", "--skip may only use method none", EXIT.usage);
      const method = opts.skip ? "none" : opts.method;
      if (!method) throw new CliError("usage", "--method or --skip is required", EXIT.usage);
      if ((method === "pr" || method === "mr") && (!opts.prUrl || opts.prNumber === undefined))
        throw new CliError(
          "pr_required",
          "PR or MR submission requires --pr-url and --pr-number",
          EXIT.usage,
        );
      if (
        method !== "pr" &&
        method !== "mr" &&
        (opts.prUrl !== undefined || opts.prNumber !== undefined)
      )
        throw new CliError("usage", "PR details require method pr or mr", EXIT.usage);
      if (!WorkSubmittedPayload.shape.pr_url.safeParse(opts.prUrl).success)
        throw new CliError(
          "usage",
          "PR URL must be a valid URL of at most 512 characters",
          EXIT.usage,
        );
      reportPublished(
        ctx,
        await publishHuman(ctx, {
          kind: "work.submit",
          task,
          item,
          method,
          skip: opts.skip ?? false,
          ...(opts.epoch === undefined ? {} : { epoch: opts.epoch }),
          ...(opts.prUrl === undefined ? {} : { pr_url: opts.prUrl }),
          ...(opts.prNumber === undefined ? {} : { pr_number: opts.prNumber }),
        }),
      );
    });
}
