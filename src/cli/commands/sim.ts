import type { Command } from "commander";
import { runScenario, type ScenarioResult } from "../../sim/runner.js";
import { UnknownScenarioError } from "../../sim/scenarios/index.js";
import type { CliContext } from "../context.js";
import { EXIT } from "../output.js";
import { parseNonNegativeInt, parsePositiveInt } from "../validate.js";

interface RunOptions {
  scenario: string;
  seed?: number;
  steps?: number;
}

/**
 * `skep sim run --scenario <name> [--seed <n>] [--steps <n>]` (PRD §16.3, ARCHITECTURE §13.1).
 *
 * The scenario registry owns the names; this command only reports what `runScenario` returns.
 * `--machine` is exactly one JSON line (ARCHITECTURE §12); human mode is a short summary.
 */
export function register(program: Command, ctx: CliContext): void {
  const sim = program.command("sim").description("Run simulation scenarios");

  sim
    .command("run")
    .description("Run one seeded scenario")
    .requiredOption("--scenario <name>", "scenario name")
    .option("--seed <n>", "rng seed (default: 1)", parseNonNegativeInt)
    .option("--steps <n>", "maximum scheduler steps", parsePositiveInt)
    .action(async (opts: RunOptions, cmd: Command) => {
      let result: ScenarioResult;
      try {
        result = await runScenario(opts.scenario, opts.seed ?? 1, { steps: opts.steps });
      } catch (err) {
        if (err instanceof UnknownScenarioError) {
          // A name the registry does not have is a usage error (exit 2), like a bad flag.
          cmd.error(err.message, { exitCode: EXIT.usage, code: "usage" });
        }
        throw err;
      }
      report(ctx, opts, result);
    });
}

/**
 * Print the run and, when invariants failed, arrange exit 1 without a second machine line.
 *
 * `runCli` turns a thrown `CliError` into the `{ ok:false, error }` envelope, which would be a
 * second JSON line after the result. Instead the result line (already carrying `ok: false` and
 * `violations`) stays the only stdout, and `ctx.exitCode` makes `runCli` return 1.
 */
function report(ctx: CliContext, opts: RunOptions, result: ScenarioResult): void {
  const output = ctx.output();
  const failed = result.violations.length > 0;
  output.result(machineResult(!failed, result), () => summary(opts, result));
  if (!failed) return;
  // Human mode adds the `skep:` line on stderr. Written directly: `output.error` would also
  // fire from runCli if this threw, and in machine mode it would add a second JSON line.
  if (!output.machine) ctx.stderr.write(`skep: ${violationMessage(result)}\n`);
  ctx.exitCode = EXIT.error;
}

/**
 * One stable object for both outcomes. `ok` mirrors the exit code; `violations` is always an
 * array (empty when the run was clean) so a wrapper does not special-case a missing field. The
 * log dump stays out: it is for the invariant error text, not for a wrapper to parse.
 */
function machineResult(ok: boolean, result: ScenarioResult): unknown {
  return {
    ok,
    finalTip: result.finalTip,
    steps: result.steps,
    violations: result.violations.map((violation) => ({
      invariant: violation.invariant,
      seq: violation.seq,
      task_id: violation.task_id,
      code: violation.code,
      detail: violation.detail,
      node: violation.node,
      seed: violation.seed,
      step: violation.step,
    })),
  };
}

function summary(opts: RunOptions, result: ScenarioResult): string {
  const head = `scenario ${opts.scenario} seed ${opts.seed ?? 1}: ${result.steps} steps, tip ${result.finalTip}`;
  if (result.violations.length === 0) return `${head}\nno violations\n`;
  const lines = result.violations.map(
    (violation) =>
      `invariant ${violation.invariant} (${violation.code}) at step ${violation.step}: ${violation.detail}`,
  );
  return `${head}\n${String(result.violations.length)} violation(s):\n${lines.join("\n")}\n`;
}

function violationMessage(result: ScenarioResult): string {
  const first = result.violations[0];
  const extra = result.violations.length - 1;
  const more = extra > 0 ? ` (+${String(extra)} more)` : "";
  return first
    ? `simulation invariant ${first.invariant} failed at step ${first.step}: ${first.detail}${more}`
    : "simulation invariants failed";
}
