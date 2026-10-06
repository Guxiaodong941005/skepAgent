import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";
import { parseAgentId } from "../validate.js";

/** `skep logs <agent> [--follow]` — local run logs (PRD §15.2). */
export function register(program: Command, _ctx: CliContext): void {
  program
    .command("logs")
    .description("Show local run logs of an agent")
    .argument("<agent>", "agent id", parseAgentId)
    .option("--follow", "keep streaming new log lines")
    .action(() => {
      notImplemented("logs");
    });
}
