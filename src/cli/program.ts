/**
 * Commander program for every MVP command (PRD §15.2).
 *
 * Actions are stubs (SK-104): they validate arguments, then throw `not_implemented`. Later tasks
 * replace the action bodies without changing the command shape. `exitOverride()` keeps Commander
 * from calling `process.exit`, so `runCli` returns the exit code to the caller.
 */

import { Command, CommanderError } from "commander";
import { skepHome, skepPaths } from "../config/paths.js";
import { register as registerAgent } from "./commands/agent.js";
import { register as registerDecide } from "./commands/decide.js";
import { register as registerDoctor } from "./commands/doctor.js";
import { register as registerInit } from "./commands/init.js";
import { register as registerLease } from "./commands/lease.js";
import { register as registerLog } from "./commands/log.js";
import { register as registerLogs } from "./commands/logs.js";
import { register as registerPlan } from "./commands/plan.js";
import { register as registerReplan } from "./commands/replan.js";
import { register as registerSim } from "./commands/sim.js";
import { register as registerStatus } from "./commands/status.js";
import { register as registerTask } from "./commands/task.js";
import { type CliContext, connectDaemon } from "./context.js";
import { CliError, createOutput, EXIT, type Output } from "./output.js";

export type { SkepPaths } from "../config/paths.js";
export type { CliContext } from "./context.js";

const VERSION = "0.0.1";

/**
 * Build a fresh program bound to `ctx`. A new tree per invocation: Commander holds parse state
 * on the command objects, so reusing one across calls would leak options between runs.
 */
export function buildProgram(ctx: CliContext): Command {
  const program = new Command();

  program
    .name("skep")
    .description("Cross-device collaboration for AI coding agents over a signed git blackboard.")
    // `-V` only. `--version` is the plan-version option of `plan show` (PRD §15.2); a long
    // global of the same name would swallow it before the subcommand ever saw it.
    .version(VERSION, "-V", "output the version number")
    .option("--machine", "print stable JSON instead of human text")
    .option("--home <dir>", "override SKEP_HOME for this invocation")
    .showHelpAfterError(false)
    .showSuggestionAfterError(true)
    .exitOverride()
    .configureOutput({
      writeOut: (s: string) => ctx.stdout.write(s),
      writeErr: (s: string) => ctx.stderr.write(s),
      // Errors go through runCli, which renders them (and the JSON form) itself.
      outputError: () => {},
    });

  // `--home` wins over `SKEP_HOME` (acceptance criterion 5). Resolved before any action runs.
  program.hook("preAction", (thisCommand) => {
    applyGlobals(ctx, thisCommand);
  });

  registerInit(program, ctx);
  registerAgent(program, ctx);
  registerTask(program, ctx);
  registerPlan(program, ctx);
  registerReplan(program, ctx);
  registerLease(program, ctx);
  registerDecide(program, ctx);
  registerStatus(program, ctx);
  registerLog(program, ctx);
  registerLogs(program, ctx);
  registerDoctor(program, ctx);
  registerSim(program, ctx);

  return program;
}

/**
 * Parse `argv` (already without `node` and the script name) and return the process exit code.
 * Never calls `process.exit`.
 */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  // A reused context must not keep a previous action's failure (sim violations set this).
  ctx.exitCode = undefined;
  // The daemon socket is the CLI's way to publish and query (ARCHITECTURE §12). An action or a
  // test may supply its own factory; otherwise talk to the socket under the resolved home.
  ctx.connectDaemon ??= () => connectDaemon(ctx);
  const program = buildProgram(ctx);
  // `output()` reads the flag off the program, which Commander has already stored by the time
  // an action or a usage error runs. Help/version never call it.
  ctx.output = () => outputFor(program, ctx);

  try {
    await program.parseAsync(argv, { from: "user" });
    return ctx.exitCode ?? EXIT.ok;
  } catch (err) {
    return renderError(err, outputFor(program, ctx));
  }
}

interface Globals {
  machine?: boolean;
  home?: string;
}

/** `--home` replaces `SKEP_HOME` for this invocation; paths are always absolute. */
function applyGlobals(ctx: CliContext, command: Command): void {
  const globals = command.optsWithGlobals<Globals>();
  if (globals.home !== undefined && globals.home !== "") {
    ctx.env = { ...ctx.env, SKEP_HOME: globals.home };
  }
  ctx.paths = skepPaths(skepHome(ctx.env));
}

function outputFor(program: Command, ctx: CliContext): Output {
  // `--machine` is global, so it is stored on the root command whichever position it was in.
  // (Invalid-argument errors fire before preAction, where a subcommand would not yet show it.)
  const machine = program.optsWithGlobals<Globals>().machine === true;
  return createOutput({ machine, stdout: ctx.stdout, stderr: ctx.stderr });
}

function renderError(err: unknown, output: Output): number {
  if (err instanceof CliError) {
    output.error(err);
    return err.exitCode;
  }
  if (err instanceof CommanderError) {
    // Help and version already wrote their text and asked to exit 0.
    if (
      err.exitCode === 0 ||
      err.code === "commander.helpDisplayed" ||
      err.code === "commander.version"
    ) {
      return EXIT.ok;
    }
    // Commander defaults invalid arguments to exit 1. Every usage failure of this CLI is exit 2
    // (PRD acceptance: bad ids/epochs are usage, not a generic error).
    const message = cleanCommanderMessage(err.message);
    output.error(new CliError(usageCode(err), message, EXIT.usage));
    return EXIT.usage;
  }
  const message = err instanceof Error ? err.message : String(err);
  output.error(new CliError("error", message, EXIT.error));
  return EXIT.error;
}

/** Commander prefixes messages with `error: `; drop it so our own prefix is the only one. */
function cleanCommanderMessage(message: string): string {
  return message.replace(/^error:\s*/, "");
}

/**
 * Usage failures share the `usage` code in machine mode, except where a command set a more
 * specific code through `command.error(..., { code })`.
 */
function usageCode(err: CommanderError): string {
  if (err.code.startsWith("commander.")) return "usage";
  return err.code || "usage";
}
