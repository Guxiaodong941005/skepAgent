import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";
import { parseAgentId, parseTaskId } from "../validate.js";

/**
 * `skep decide <task>` resolves an escalation (PRD §15.2).
 *
 * Exactly one of `--resume`, `--replan`, `--cancel`, `--owner` must be given. Commander cannot
 * express "exactly one of these" itself, so the action checks and reports a usage error.
 */
export function register(program: Command, _ctx: CliContext): void {
  program
    .command("decide")
    .description("Resolve an escalated task")
    .argument("<task>", "task id", parseTaskId)
    .option("--resume", "resume execution with the current plan")
    .option("--replan", "send the task back to planning")
    .option("--cancel", "cancel the task")
    .option("--owner <agentId>", "transfer ownership to an agent", parseAgentId)
    .option("--note <text>", "note recorded with the decision")
    .action((_task: string, _opts: unknown, cmd: Command) => {
      const opts = cmd.opts<{
        resume?: boolean;
        replan?: boolean;
        cancel?: boolean;
        owner?: string;
      }>();
      const chosen = [opts.resume, opts.replan, opts.cancel, opts.owner !== undefined].filter(
        Boolean,
      ).length;
      if (chosen !== 1) {
        cmd.error(
          "decide requires exactly one of --resume, --replan, --cancel, or --owner <agentId>",
          { exitCode: 2, code: "usage" },
        );
      }
      notImplemented("decide");
    });
}
