/**
 * `skep ui` — the full-screen view (D30) over this device's session, and the factory behind
 * `skep session join --ui`.
 *
 * On a master it polls the control `status` op and shows the peers, the items and the per-item
 * results the master already received (agents run on the subs, so there is nothing to attach
 * to or submit here). A sub's view is its join: `skep session join --ui` draws the same screen.
 */

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { type Clock, systemClock } from "../../util/clock.js";
import { execFileChecked } from "../../util/exec.js";
import type { CliContext } from "../context.js";
import { CliError } from "../output.js";
import {
  type ProcessHooks,
  type ScreenIo,
  Tui,
  type TuiEntry,
  TuiJoinView,
  type TuiSnapshot,
} from "../tui.js";
import {
  ControlConnectionError,
  controlRequest,
  type JoinViewFactory,
  loadSubmitPolicy,
  parseHostPort,
  type SessionStatus,
  SessionStatusSchema,
  setJoinViewFactory,
} from "./session.js";

/** The master's state changes at human pace; once a second is plenty for a watcher. */
const POLL_MS = 1_000;
const FOCUS_TIMEOUT_MS = 30_000;

export type UiCliContext = CliContext & {
  /** Terminal streams (default: the process's). Tests pass a fake stdin and an 80×24 buffer. */
  uiIo?: ScreenIo;
  uiHooks?: ProcessHooks;
  /** One master status (default: the control `status` op named by `session.json`). */
  uiStatus?: () => Promise<SessionStatus>;
  clock?: Clock;
  hostname?: () => string;
};

/** The control file written by `skep session start`; same shape as session.ts reads. */
const SessionFileSchema = z.strictObject({
  listen: z.string().min(1),
  token: z.string().regex(/^[0-9a-f]{32}$/),
});

export function register(program: Command, ctx: CliContext): void {
  const uctx = ctx as UiCliContext;

  // The join hands the factory the process's own terminal. A context with substituted streams
  // (an embedding caller, tests) did not give us that terminal, so it keeps whatever view it set.
  if (ctx.stdout === process.stdout) setJoinViewFactory(joinViewFactory(ctx));

  program
    .command("ui")
    .description("Full-screen view of this device's session (a sub uses `session join --ui`)")
    .action(async () => {
      await uiCommand(uctx);
    });
}

/** The `session join --ui` screen. Exported for tests, which pass fake streams. */
export function joinViewFactory(ctx: CliContext): JoinViewFactory {
  return (io) => {
    const deviceToml = ctx.paths?.deviceToml;
    return new TuiJoinView({
      io: { stdin: io.stdin, stdout: io.stdout },
      glyphs: ctx.env.SKEP_TUI_ASCII === "1" ? "ascii" : "unicode",
      host:
        deviceToml === undefined
          ? "github"
          : loadSubmitPolicy(deviceToml).then((policy) => policy.host),
      runFocus: (argv) => runFocus(ctx, argv),
      onQuit: (reason) => {
        // The join stops on SIGINT (abort the agent, close the channel). In raw mode Ctrl-C is
        // only a byte, so a key quit raises the same event; a real signal already reached it.
        // Before the join installs its handler, nothing listens: then quit the default way.
        if (reason !== "key") return;
        if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT", "SIGINT");
        else process.kill(process.pid, "SIGINT");
      },
    });
  };
}

async function runFocus(ctx: CliContext, argv: readonly string[]): Promise<void> {
  const [file, ...args] = argv;
  if (file === undefined) throw new Error("the agent has no focus command");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(ctx.env)) {
    if (value !== undefined) env[name] = value;
  }
  await execFileChecked(file, args, { env, timeoutMs: FOCUS_TIMEOUT_MS });
}

async function uiCommand(ctx: UiCliContext): Promise<void> {
  const fetchStatus = ctx.uiStatus ?? (() => masterStatus(ctx));
  const clock = ctx.clock ?? systemClock;
  const device = (ctx.hostname ?? os.hostname)();
  // The first status is read before the screen opens, so "no master" is a plain error line.
  let status = await fetchStatus();

  const io = ctx.uiIo ?? { stdin: process.stdin, stdout: process.stdout };
  if (ctx.uiIo === undefined && (process.stdin.isTTY !== true || process.stdout.isTTY !== true)) {
    throw new CliError("not_a_tty", "skep ui needs an interactive terminal");
  }
  const stop = new AbortController();
  const tui = new Tui({
    io,
    clock,
    glyphs: ctx.env.SKEP_TUI_ASCII === "1" ? "ascii" : "unicode",
    ...(ctx.uiHooks === undefined ? {} : { hooks: ctx.uiHooks }),
    onQuit: () => stop.abort(),
  });
  let ended = "";
  try {
    tui.start();
    for (;;) {
      tui.model.set(masterSnapshot(status, device));
      tui.guard(() => tui.render());
      try {
        await clock.sleep(POLL_MS, stop.signal);
      } catch (error) {
        if (stop.signal.aborted) break;
        throw error;
      }
      try {
        status = await fetchStatus();
      } catch (error) {
        // The master exiting closes its control port: the session is over, not broken.
        if (!(error instanceof CliError && error.code === "session_unreachable")) throw error;
        ended = `session ended: ${error.message}\n`;
        break;
      }
    }
  } finally {
    tui.close();
  }
  if (ended !== "") ctx.stderr.write(ended);
}

/** Status as the screen shows it: items are rows under the peer they are assigned to. */
export function masterSnapshot(status: SessionStatus, device: string): TuiSnapshot {
  const entries: TuiEntry[] = [];
  for (const intent of status.intents) {
    for (const item of intent.items) {
      entries.push({
        key: `${item.itemId}-e${item.epoch}`,
        peerId: item.assignee,
        item: { itemId: item.itemId, title: item.title, repo: item.repo, epoch: item.epoch },
        itemState: item.state,
        agent: null,
        // Summaries were redacted by the sub before they left it.
        tail: item.result?.summary ?? "",
        ...(item.result?.submit === undefined
          ? {}
          : { submit: { policy: item.result.submit.method, outcome: item.result.submit } }),
      });
    }
  }
  return {
    header: { session: status.sessionId, device, role: "master" },
    peers: status.peers.map((peer) => ({
      peerId: peer.peerId,
      device: peer.device,
      role: peer.role ?? "-",
      state: peer.progress?.phase ?? (peer.repo === null ? "joined" : `repo ${peer.repo}`),
      ...(peer.progress === undefined ? {} : { progress: peer.progress }),
    })),
    entries,
  };
}

/** `status` from the master named by this device's `session.json`. */
async function masterStatus(ctx: UiCliContext): Promise<SessionStatus> {
  if (ctx.paths === undefined) throw new Error("skep home is not resolved");
  const file = path.join(ctx.paths.home, "session.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new CliError(
      "no_session",
      `no session master runs on this device (${file} not found); on a sub run ` +
        "`skep session join --ui`",
    );
  }
  let local: z.infer<typeof SessionFileSchema>;
  try {
    local = SessionFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new CliError("bad_session_file", `${file} is malformed: ${errorMessage(error)}`);
  }
  const target = parseHostPort(local.listen);
  if (target === null) {
    throw new CliError("bad_session_file", `${file} has an invalid listen address`);
  }
  let reply: Awaited<ReturnType<typeof controlRequest>>;
  try {
    reply = await controlRequest(
      target,
      { type: "control", v: 1, token: local.token, op: "status" },
      ctx.clock ?? systemClock,
    );
  } catch (error) {
    if (error instanceof ControlConnectionError) {
      throw new CliError("session_unreachable", error.message);
    }
    throw error;
  }
  if (!reply.ok) throw new CliError(reply.error.code, reply.error.message);
  const parsed = SessionStatusSchema.safeParse(reply.result);
  if (!parsed.success) {
    throw new CliError(
      "bad_reply",
      `session master sent a malformed status: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
