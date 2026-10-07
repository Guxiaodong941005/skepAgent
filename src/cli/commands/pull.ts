/**
 * `skep pull` — fetch the blackboard now (D26).
 *
 * A worker runs this when the controller says `main` moved. The caller is not trusted: this
 * only fetches git. The reducer still verifies every signature. With no daemon, it fetches
 * the CLI's own clone.
 */

import type { Command } from "commander";
import { BlackboardClone } from "../../blackboard/clone.js";
import { loadDeviceConfig } from "../../config/device.js";
import { NodeGitRunner } from "../../git/runner.js";
import { IpcClientError } from "../../ipc/client.js";
import { type CliContext, connectDaemon } from "../context.js";
import { CliError } from "../output.js";

export function register(program: Command, ctx: CliContext): void {
  program
    .command("pull")
    .description("Fetch the blackboard now; does not trust the caller for state")
    .action(async () => {
      try {
        await pullNow(ctx);
      } catch (error) {
        throw error instanceof CliError
          ? error
          : new CliError("pull_failed", error instanceof Error ? error.message : String(error));
      }
    });
}

async function pullNow(ctx: CliContext): Promise<void> {
  const paths = ctx.paths;
  if (!paths) throw new CliError("pull_failed", "skep home is not resolved");
  const open = ctx.connectDaemon ?? (() => connectDaemon(ctx));
  try {
    const client = await open();
    try {
      const response = await client.call("pull", {});
      if (!response.ok) throw new CliError(response.error.code, response.error.message);
      ctx.output().result({ fetched: true, via: "daemon" }, () => "pulled via daemon");
      return;
    } finally {
      client.close();
    }
  } catch (error) {
    if (!(error instanceof IpcClientError) || error.code !== "connect") throw error;
  }
  const config = await loadDeviceConfig(paths.deviceToml);
  const git = new NodeGitRunner();
  const clone = new BlackboardClone({
    git,
    dir: config.blackboard.clone_path ?? paths.cliBlackboardClone,
    remoteUrl: config.blackboard.url,
  });
  await clone.init();
  await clone.fetch();
  ctx.output().result({ fetched: true, via: "cli" }, () => "pulled via local clone");
}
