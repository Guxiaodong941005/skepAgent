/**
 * Commander program for the session-mode CLI surface.
 */

import { Command, CommanderError } from "commander";
import { skepHome, skepPaths } from "../config/paths.js";
import { launchAgent, register as registerAgentTui } from "./commands/agent-tui.js";
import { expandStartWithMaster, register as registerSession } from "./commands/session.js";
import { register as registerUi } from "./commands/ui.js";
import type { CliContext } from "./context.js";
import { CliError, createOutput, EXIT, type Output } from "./output.js";

export type { SkepPaths } from "../config/paths.js";
export type { CliContext } from "./context.js";

const VERSION = "0.1.2";

/**
 * Build a fresh program bound to `ctx`. A new tree per invocation: Commander holds parse state
 * on the command objects, so reusing one across calls would leak options between runs.
 */
export function buildProgram(ctx: CliContext): Command {
  const program = new Command();

  program
    .name("skep")
    .description("Cross-device collaboration for AI coding agents via live join-code sessions.")
    .version(VERSION, "-V", "output the version number")
    .option("--machine", "print stable JSON instead of human text")
    .option("--home <dir>", "override SKEP_HOME for this invocation")
    .showHelpAfterError(false)
    .showSuggestionAfterError(true)
    .exitOverride()
    .configureOutput({
      writeOut: (s: string) => ctx.stdout.write(s),
      writeErr: (s: string) => ctx.stderr.write(s),
      outputError: () => {},
    });

  program.hook("preAction", (thisCommand) => {
    applyGlobals(ctx, thisCommand);
  });

  registerUi(program, ctx);
  registerSession(program, ctx);
  registerAgentTui(program, ctx);

  program
    .argument("[prompt...]", "ask the agent; no subcommand opens it")
    .action(async (words: string[]) => {
      await launchAgent(ctx, words.join(" "), undefined);
    });

  return program;
}

export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  ctx.exitCode = undefined;
  argv = expandStartWithMaster(argv);
  const program = buildProgram(ctx);
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

function applyGlobals(ctx: CliContext, command: Command): void {
  const globals = command.optsWithGlobals<Globals>();
  if (globals.home !== undefined && globals.home !== "") {
    ctx.env = { ...ctx.env, SKEP_HOME: globals.home };
  }
  ctx.paths = skepPaths(skepHome(ctx.env));
}

function outputFor(program: Command, ctx: CliContext): Output {
  const machine = program.optsWithGlobals<Globals>().machine === true;
  return createOutput({ machine, stdout: ctx.stdout, stderr: ctx.stderr });
}

function renderError(err: unknown, output: Output): number {
  if (err instanceof CliError) {
    output.error(err);
    return err.exitCode;
  }
  if (err instanceof CommanderError) {
    if (
      err.exitCode === 0 ||
      err.code === "commander.helpDisplayed" ||
      err.code === "commander.version"
    ) {
      return EXIT.ok;
    }
    const message = cleanCommanderMessage(err.message);
    output.error(new CliError(usageCode(err), message, EXIT.usage));
    return EXIT.usage;
  }
  const message = err instanceof Error ? err.message : String(err);
  output.error(new CliError("error", message, EXIT.error));
  return EXIT.error;
}

function cleanCommanderMessage(message: string): string {
  return message.replace(/^error:\s*/, "");
}

function usageCode(err: CommanderError): string {
  if (err.code.startsWith("commander.")) return "usage";
  return err.code || "usage";
}
