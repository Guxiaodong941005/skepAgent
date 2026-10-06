/**
 * `skep status` (PRD §15.1, ARCHITECTURE §5.6, §12).
 *
 * Asks the daemon over the socket. When the daemon is down, replays the local blackboard clone
 * itself: the view is pure, so a daemon-less read shows the same tasks, only without the
 * observer's liveness (there is no heartbeat fetch to judge it from). `--machine` prints the
 * status view through `canonicalJson` (F20); the human layout is `renderStatus`.
 */

import type { Command } from "commander";
import { replay } from "../../core/reducer/replay.js";
import { REDUCER_VERSION, type State } from "../../core/reducer/state.js";
import type { StatusView } from "../../core/reducer/views.js";
import { statusView } from "../../core/reducer/views.js";
import { readLog } from "../../git/log-reader.js";
import { NodeGitRunner } from "../../git/runner.js";
import { IpcClientError, type IpcResult } from "../../ipc/client.js";
import { systemClock } from "../../util/clock.js";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";
import {
  type HintHealth,
  renderStatus,
  type StatusAlarm,
  type StatusExtras,
  type StatusFreshness,
} from "../render-status.js";

interface StatusResult {
  view: StatusView;
  extras: StatusExtras;
}

/** `skep status` (PRD §15.1, §15.2). Global `--machine` selects the JSON view. */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("status")
    .description("Show the derived view of tasks, items, and agents")
    .action(async () => {
      const result = await loadStatus(ctx);
      // F20: `output.result` prints the machine line through `canonicalJson`.
      ctx.output().result(machineStatus(result), () => renderStatus(result.view, result.extras));
    });
}

/**
 * The `--machine` object: the `statusView` fields plus the observer's liveness, freshness, hints
 * and alarms (ARCHITECTURE §12). `canonicalJson` sorts the keys (F20).
 */
function machineStatus(result: StatusResult): unknown {
  return {
    ...result.view,
    liveness: result.extras.liveness,
    freshness: freshnessForMachine(result.extras),
    hints: result.extras.hints,
    alarms: result.extras.alarms,
    nowMonoMs: result.extras.nowMonoMs,
  };
}

/**
 * Rename the sync timestamp for the wire: "checked", because it moves on an unchanged
 * `ls-remote` as well as on a real fetch (F20, ARCHITECTURE §17.3).
 */
function freshnessForMachine(extras: StatusExtras): {
  checkedAtMonoMs: number | null;
  invalidCount: number;
  reducerVersion: number;
} {
  return {
    checkedAtMonoMs: extras.freshness.checkedAtMonoMs,
    invalidCount: extras.freshness.invalidCount,
    reducerVersion: extras.freshness.reducerVersion ?? REDUCER_VERSION,
  };
}

async function loadStatus(ctx: CliContext): Promise<StatusResult> {
  try {
    const client = await ctx.connectDaemon?.();
    if (!client) return await replayLocal(ctx);
    try {
      const response = await client.call("status", {});
      return decodeStatus(response);
    } finally {
      client.close();
    }
  } catch (err) {
    if (err instanceof IpcClientError && err.code === "connect") return await replayLocal(ctx);
    throw asCliError(err);
  }
}

export function decodeStatus(response: IpcResult): StatusResult {
  if (!response.ok) {
    throw new CliError(response.error.code, response.error.message, EXIT.error);
  }
  const body = response.result;
  if (!isRecord(body)) {
    throw new CliError("bad_status", "daemon returned a status that is not an object", EXIT.error);
  }
  // One shape only, `{ view, extras }` (ARCHITECTURE §12). The flat bridge from SK-604 is gone
  // (follow-up H11): every daemon on `main` answers nested.
  if (!isRecord(body.view) || !isRecord(body.extras)) {
    throw new CliError(
      "bad_status",
      "daemon status is not { view, extras }; skepd and skep must come from the same build",
      EXIT.error,
    );
  }
  const view = body.view as unknown as StatusView;
  if (typeof view.seq !== "number" || typeof view.tip !== "string" || !Array.isArray(view.tasks)) {
    throw new CliError("bad_status", "daemon status is missing seq, tip or tasks", EXIT.error);
  }
  return {
    view: { ...view, agents: view.agents ?? [], tasks: view.tasks },
    extras: extrasOf(body.extras),
  };
}

/**
 * Observer data from `extras`; absent fields render as unknown.
 *
 * Monotonic clocks of different processes have unrelated origins, so the daemon sends an age
 * (`checkedAgoMs`, D23) and the CLI anchors it on its own clock. A raw daemon timestamp
 * (`checkedAtMonoMs`, `fetchedAtMonoMs`) or a daemon `nowMonoMs` is never read: subtracting
 * it from anything on this process's clock is meaningless (SK-604 review note 1, H11).
 */
function extrasOf(nested: Record<string, unknown>): StatusExtras {
  const freshness = isRecord(nested.freshness) ? nested.freshness : {};
  const hints = isRecord(nested.hints) ? nested.hints : {};
  const nowMonoMs = systemClock.monotonicMs();
  const checked =
    typeof freshness.checkedAgoMs === "number" ? nowMonoMs - freshness.checkedAgoMs : null;
  return {
    liveness: Array.isArray(nested.liveness) ? (nested.liveness as StatusExtras["liveness"]) : [],
    freshness: {
      checkedAtMonoMs: typeof checked === "number" ? checked : null,
      invalidCount: typeof freshness.invalidCount === "number" ? freshness.invalidCount : 0,
      reducerVersion:
        typeof freshness.reducerVersion === "number" ? freshness.reducerVersion : REDUCER_VERSION,
    } satisfies StatusFreshness,
    hints: {
      name: typeof hints.name === "string" ? hints.name : "null",
      connected: hints.connected === true,
      lastMessageMonoMs:
        typeof hints.lastMessageMonoMs === "number" ? hints.lastMessageMonoMs : null,
    } satisfies HintHealth,
    alarms: Array.isArray(nested.alarms) ? (nested.alarms as StatusAlarm[]) : [],
    nowMonoMs,
  };
}

/**
 * Daemon-less read (ARCHITECTURE §3, §12). Replays the CLI's blackboard clone and reports that
 * liveness cannot be judged: no heartbeat fetch happened, so no holder is called stale.
 */
async function replayLocal(ctx: CliContext): Promise<StatusResult> {
  const paths = ctx.paths;
  if (!paths) throw new CliError("no_home", "skep home is not resolved", EXIT.error);
  let state: State;
  try {
    const entries = await readLog(
      new NodeGitRunner(),
      paths.cliBlackboardClone,
      paths.allowedSigners,
    );
    state = replay(entries);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliError(
      "no_daemon",
      `skepd is not running and the local blackboard could not be read: ${detail}`,
      EXIT.error,
    );
  }
  const invalidCount = state.outcomes.filter((outcome) => outcome.outcome === "invalid").length;
  return {
    view: statusView(state),
    extras: {
      liveness: [],
      freshness: { checkedAtMonoMs: null, invalidCount, reducerVersion: state.reducer_version },
      hints: { name: "null", connected: false, lastMessageMonoMs: null },
      alarms:
        invalidCount > 0
          ? [{ kind: "invalid_commit", detail: `${invalidCount} invalid commit(s) in the log` }]
          : [],
      nowMonoMs: systemClock.monotonicMs(),
    },
  };
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
