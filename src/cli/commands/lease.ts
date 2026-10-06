import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { publishHuman } from "../publish.js";
import { reportPublished } from "../publish-output.js";
import { parseItemId, parsePositiveInt, parseTaskId } from "../validate.js";

/** `skep lease revoke <task> <item> --epoch <n> [--reason <text>]` (PRD §15.2, ARCHITECTURE §6.4). */
export function register(program: Command, ctx: CliContext): void {
  const lease = program.command("lease").description("Manage work-item leases");

  lease
    .command("revoke")
    .description("Fence a stale lease holder at an epoch")
    .argument("<task>", "task id", parseTaskId)
    .argument("<item>", "work item id", parseItemId)
    .requiredOption("--epoch <n>", "epoch to revoke", parsePositiveInt)
    .option("--reason <text>", "why the lease is being revoked")
    .action(async (taskId: string, item: string, opts: { epoch: number; reason?: string }) => {
      reportPublished(
        ctx,
        await publishHuman(ctx, {
          kind: "lease.revoke",
          task: taskId,
          item,
          epoch: opts.epoch,
          ...(opts.reason === undefined ? {} : { reason: opts.reason }),
        }),
      );
    });
}
