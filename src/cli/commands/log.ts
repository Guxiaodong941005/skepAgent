/**
 * `skep log <task>` (PRD §15.2, ARCHITECTURE §12).
 *
 * Shows one task's outcomes — accepted, rejected, invalid, duplicate — each with the reason the
 * reducer recorded. The daemon answers `log`; without it, the CLI replays its own clone and
 * filters `state.outcomes`. `--machine` prints the same rows through `canonicalJson`.
 */

import type { Command } from "commander";
import { replay } from "../../core/reducer/replay.js";
import type { LogOutcome } from "../../core/reducer/state.js";
import { readLog } from "../../git/log-reader.js";
import { NodeGitRunner } from "../../git/runner.js";
import { IpcClientError, type IpcResult } from "../../ipc/client.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";
import { renderLog } from "../render-status.js";
import { parseTaskId } from "../validate.js";
import { printMachine } from "./machine.js";

interface LogResult {
  task: string;
  outcomes: LogOutcome[];
}

/** `skep log <task>` — the blackboard event stream (PRD §15.2). */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("log")
    .description("Show the event stream of a task")
    .argument("<task>", "task id", parseTaskId)
    .option("--from <seq>", "first seq to show", parseFromSeq)
    .action(async (task: string, opts: { from?: number }) => {
      const result = await loadLog(ctx, task, opts.from);
      printMachine(ctx, machineLog(result), renderLog(result.task, result.outcomes));
    });
}

/** Rows only: no reducer internals, so the machine form stays stable as state grows. */
function machineLog(result: LogResult): unknown {
  return {
    task: result.task,
    outcomes: result.outcomes.map((outcome) => ({
      seq: outcome.seq,
      sha: outcome.sha,
      outcome: outcome.outcome,
      reason: outcome.reason,
      event_id: outcome.event_id,
      type: outcome.type,
      actor: outcome.actor,
    })),
  };
}

function parseFromSeq(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliError("usage", `invalid --from ${value}: expected a positive seq`, EXIT.usage);
  }
  return Number(value);
}

async function loadLog(ctx: CliContext, task: string, fromSeq?: number): Promise<LogResult> {
  try {
    const client = await ctx.connectDaemon?.();
    if (!client) return await replayLocal(ctx, task, fromSeq);
    try {
      const response = await client.call("log", {
        task,
        ...(fromSeq ? { from_seq: fromSeq } : {}),
      });
      return decodeLog(task, response, fromSeq);
    } finally {
      client.close();
    }
  } catch (err) {
    if (err instanceof IpcClientError && err.code === "connect") {
      return await replayLocal(ctx, task, fromSeq);
    }
    throw asCliError(err);
  }
}

function decodeLog(task: string, response: IpcResult, fromSeq?: number): LogResult {
  if (!response.ok) throw new CliError(response.error.code, response.error.message, EXIT.error);
  const body = response.result;
  const rows = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.outcomes)
      ? body.outcomes
      : null;
  if (rows === null) {
    throw new CliError(
      "bad_log",
      "daemon returned a log that is not a list of outcomes",
      EXIT.error,
    );
  }
  const outcomes = (rows as LogOutcome[])
    .filter((row) => row.task_id === undefined || row.task_id === null || row.task_id === task)
    .filter((row) => fromSeq === undefined || row.seq >= fromSeq);
  return { task, outcomes };
}

/** Same fallback as `skep status`: replay the CLI clone and keep this task's rows. */
async function replayLocal(ctx: CliContext, task: string, fromSeq?: number): Promise<LogResult> {
  const paths = ctx.paths;
  if (!paths) throw new CliError("no_home", "skep home is not resolved", EXIT.error);
  try {
    const entries = await readLog(
      new NodeGitRunner(),
      paths.cliBlackboardClone,
      paths.allowedSigners,
    );
    const state = replay(entries);
    const outcomes = state.outcomes.filter(
      (outcome) => outcome.task_id === task && (fromSeq === undefined || outcome.seq >= fromSeq),
    );
    return { task, outcomes };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      "no_daemon",
      `skepd is not running and the local blackboard could not be read: ${detail}`,
      EXIT.error,
    );
  }
}

function asCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  if (err instanceof IpcClientError) return new CliError(err.code, err.message, EXIT.error);
  const message = err instanceof Error ? err.message : String(err);
  return new CliError("error", message, EXIT.error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
