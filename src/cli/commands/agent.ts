import { resolve } from "node:path";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";
import { callDaemon } from "../publish.js";

/**
 * `skep agent start|stop [--role-dir <dir>]` (PRD §15.2, §7.1).
 *
 * Starting and stopping a slot is the daemon's job: it owns the process group and the journal.
 * Unlike the write commands there is no in-process fallback — a stopped daemon has no slot to
 * start, and saying so is more honest than pretending (ARCHITECTURE §3).
 */
export function register(program: Command, ctx: CliContext): void {
  const agent = program.command("agent").description("Start or stop a role slot");

  agent
    .command("start")
    .description("Register and start the slot for a role directory")
    .option("--role-dir <dir>", "role directory (defaults to the current directory)")
    .action(async (opts: { roleDir?: string }) => {
      await slot(ctx, "agent.start", opts.roleDir);
    });

  agent
    .command("stop")
    .description("Stop the slot (interrupt ladder, then checkpoint)")
    .option("--role-dir <dir>", "role directory (defaults to the current directory)")
    .action(async (opts: { roleDir?: string }) => {
      await slot(ctx, "agent.stop", opts.roleDir);
    });
}

async function slot(
  ctx: CliContext,
  method: "agent.start" | "agent.stop",
  roleDir: string | undefined,
): Promise<void> {
  const dir = resolve(roleDir ?? ctx.env.PWD ?? ".");
  const result = await callDaemon(ctx, method, { role_dir: dir });
  // A slot lives inside the daemon; there is no in-process fallback for it (ARCHITECTURE §3).
  if (result === undefined) {
    throw new CliError("no_daemon", "skepd is not running; a slot needs the daemon", EXIT.error);
  }
  const verb = method === "agent.start" ? "started" : "stopped";
  ctx.output().result(result, () => `slot ${verb} for ${dir}\n`);
}
