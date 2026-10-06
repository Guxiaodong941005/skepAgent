import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { notImplemented } from "../output.js";
import { parseNonNegativeInt, parsePositiveInt } from "../validate.js";

/** `skep sim run --scenario <name> [--seed <n>] [--steps <n>]` (PRD §16.3, ARCHITECTURE §13). */
export function register(program: Command, _ctx: CliContext): void {
  const sim = program.command("sim").description("Run simulation scenarios");

  sim
    .command("run")
    .description("Run one seeded scenario")
    .requiredOption("--scenario <name>", "scenario name")
    .option("--seed <n>", "rng seed (default: 1)", parseNonNegativeInt)
    .option("--steps <n>", "maximum scheduler steps", parsePositiveInt)
    .action(() => {
      notImplemented("sim run");
    });
}
