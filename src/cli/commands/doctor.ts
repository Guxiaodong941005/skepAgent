import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";

/** `skep doctor` — pre-flight, full replay, invariant check (PRD §15.2). */
export function register(program: Command, _ctx: CliContext): void {
  program
    .command("doctor")
    .description("Run pre-flight checks, a full replay, and the invariant checks")
    .action(() => {
      notImplemented("doctor");
    });
}
