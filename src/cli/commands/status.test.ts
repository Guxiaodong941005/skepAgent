import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  T1,
  taskCreated,
  VPS,
} from "../../../test/helpers/log-builder.js";
import { canonicalJson } from "../../core/canonical.js";
import { replay } from "../../core/reducer/replay.js";
import type { State } from "../../core/reducer/state.js";
import { statusView } from "../../core/reducer/views.js";
import { type IpcClient, IpcClientError, type IpcResult } from "../../ipc/client.js";
import type { CliContext } from "../context.js";
import { runCli } from "../program.js";

vi.mock("../../git/log-reader.js", () => ({
  readLog: vi.fn(),
}));

const { readLog } = await import("../../git/log-reader.js");
const readLogMock = vi.mocked(readLog);

interface Captured {
  stdout: string;
  stderr: string;
  ctx: CliContext;
}

function capture(home = join(mkdtempSync(join(tmpdir(), "skep-status-")), "home")): Captured {
  const out = { stdout: "", stderr: "" };
  const ctx: CliContext = {
    stdout: {
      write: (s) => {
        out.stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        out.stderr += s;
      },
    },
    env: { SKEP_HOME: home },
    output: () => {
      throw new Error("output() used before runCli");
    },
  };
  return {
    get stdout() {
      return out.stdout;
    },
    get stderr() {
      return out.stderr;
    },
    ctx,
  };
}

function daemon(handler: (method: string, params: unknown) => IpcResult): IpcClient {
  return {
    call: (method, params) => Promise.resolve(handler(method, params)),
    close: () => undefined,
  };
}

/** A one-task log: genesis, the owner registered, the task created. */
function fixtureState(): { state: State; entries: LogBuilder["entries"] } {
  const builder = new LogBuilder();
  builder.append({
    type: "agent.registered",
    actor: VPS,
    task_id: null,
    payload: agentRegistered(),
  });
  builder.append({
    type: "task.created",
    actor: "human",
    payload: taskCreated({ owner: VPS }),
  });
  return { state: replay(builder.entries), entries: builder.entries };
}

afterEach(() => {
  readLogMock.mockReset();
});

describe("skep status", () => {
  it("renders the daemon view and says checked (F20)", async () => {
    const { state } = fixtureState();
    const view = statusView(state);
    const cap = capture();
    cap.ctx.connectDaemon = () =>
      Promise.resolve(
        daemon((method) => {
          expect(method).toBe("status");
          return {
            ok: true,
            result: {
              ...view,
              liveness: [
                {
                  agent: VPS,
                  cls: "stale",
                  sinceChangeMs: 400_000,
                  intervalMs: 60_000,
                  bootId: "b_5a1e",
                  state: "running",
                  runtime: "native",
                  lease: { task: T1, item: "W1", epoch: 1 },
                },
              ],
              freshness: { fetchedAtMonoMs: 1_000, invalidCount: 0, reducerVersion: 1 },
              hints: { name: "relay", connected: false, lastMessageMonoMs: null },
              alarms: [],
              nowMonoMs: 7_000,
            },
          };
        }),
      );
    const code = await runCli(["status"], cap.ctx);
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");
    expect(cap.stdout).toContain("checked 6s ago");
    expect(cap.stdout).not.toContain("fetched");
    expect(cap.stdout).toContain("hints relay down, no messages");
    expect(cap.stdout).toContain(T1);
    expect(cap.stdout).toContain(VPS);
    expect(cap.stdout).not.toMatch(/provider|credential|api_key/i);
  });

  it.each([0, 6_000, null])(
    "renders the daemon's checkedAgoMs=%s on the CLI clock",
    async (age) => {
      const { state } = fixtureState();
      const cap = capture();
      cap.ctx.connectDaemon = () =>
        Promise.resolve(
          daemon(() => ({
            ok: true,
            result: {
              view: statusView(state),
              extras: {
                liveness: [],
                freshness: {
                  checkedAgoMs: age,
                  checkedAtMonoMs: 900_000_000,
                  invalidCount: 2,
                  reducerVersion: 1,
                },
                hints: { name: "null", connected: false, lastMessageMonoMs: null },
                alarms: [],
                readOnly: false,
              },
            },
          })),
        );
      expect(await runCli(["status"], cap.ctx)).toBe(0);
      expect(cap.stdout).toContain(age === null ? "checked never" : `checked ${age / 1000}s ago`);
      expect(cap.stdout).toContain("2 invalid commits");
    },
  );

  it("prints canonical JSON with --machine, naming the timestamp checkedAtMonoMs", async () => {
    const { state } = fixtureState();
    const view = statusView(state);
    const cap = capture();
    const result = {
      ...view,
      liveness: [],
      freshness: { checkedAtMonoMs: 1_000, invalidCount: 1, reducerVersion: 1 },
      hints: { name: "null", connected: false, lastMessageMonoMs: null },
      alarms: [{ kind: "invalid_commit", detail: "1 invalid commit(s) in the log" }],
      nowMonoMs: 5_000,
    };
    cap.ctx.connectDaemon = () => Promise.resolve(daemon(() => ({ ok: true, result })));
    const code = await runCli(["--machine", "status"], cap.ctx);
    expect(code).toBe(0);
    const line = cap.stdout.replace(/\n$/, "");
    const parsed = JSON.parse(line) as {
      ok: boolean;
      result: { freshness: { checkedAtMonoMs: number } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.result.freshness.checkedAtMonoMs).toBe(1_000);
    // Key order is canonical, not the order the object was built in.
    expect(line).toBe(canonicalJson({ ok: true, result }));
    expect(line).not.toContain("fetchedAtMonoMs");
  });

  it("falls back to a local replay when the daemon is down", async () => {
    const { state, entries } = fixtureState();
    readLogMock.mockResolvedValue(entries);
    const cap = capture();
    cap.ctx.connectDaemon = () =>
      Promise.reject(new IpcClientError("connect", "cannot connect to skepd"));
    const code = await runCli(["status"], cap.ctx);
    expect(code).toBe(0);
    expect(cap.stdout).toContain(`#${state.seq}`);
    expect(cap.stdout).toContain("checked never");
    expect(cap.stdout).toContain("hints off");
    expect(cap.stdout).toContain(T1);
    expect(cap.stdout).not.toContain("revoke suggested");
    expect(readLogMock).toHaveBeenCalledOnce();
  });

  it("reports the daemon error instead of guessing", async () => {
    const cap = capture();
    cap.ctx.connectDaemon = () =>
      Promise.resolve(
        daemon(() => ({ ok: false, error: { code: "unavailable", message: "replaying" } })),
      );
    const code = await runCli(["status"], cap.ctx);
    expect(code).toBe(1);
    expect(cap.stderr).toContain("replaying");
  });

  it("fails with no_daemon when neither the socket nor the clone is readable", async () => {
    readLogMock.mockRejectedValue(new Error("not a git repository"));
    const cap = capture();
    cap.ctx.connectDaemon = () => Promise.reject(new IpcClientError("connect", "down"));
    const code = await runCli(["--machine", "status"], cap.ctx);
    expect(code).toBe(1);
    const body = JSON.parse(cap.stdout) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("no_daemon");
  });
});

describe("skep log", () => {
  it("shows the task's outcomes with their reasons", async () => {
    const cap = capture();
    cap.ctx.connectDaemon = () =>
      Promise.resolve(
        daemon((method, params) => {
          expect(method).toBe("log");
          expect(params).toEqual({ task: T1 });
          return {
            ok: true,
            result: {
              task: T1,
              outcomes: [
                {
                  seq: 2,
                  sha: "abc1234",
                  outcome: "accepted",
                  reason: null,
                  event_id: "evt_1",
                  type: "task.created",
                  task_id: T1,
                  actor: "human",
                  signer: "human",
                },
                {
                  seq: 3,
                  sha: "def5678",
                  outcome: "rejected",
                  reason: "unauthorized",
                  event_id: "evt_2",
                  type: "plan.proposed",
                  task_id: T1,
                  actor: MAC,
                  signer: "daemon:mac",
                },
              ],
            },
          };
        }),
      );
    const code = await runCli(["log", T1], cap.ctx);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("#2  accepted  human  task.created");
    expect(cap.stdout).toContain(`#3  rejected  ${MAC}  plan.proposed  unauthorized`);
  });

  it("prints canonical JSON with --machine", async () => {
    const outcomes = [
      {
        seq: 2,
        sha: "abc1234",
        outcome: "accepted",
        reason: null,
        event_id: "evt_1",
        type: "task.created",
        actor: "human",
      },
    ];
    const cap = capture();
    cap.ctx.connectDaemon = () =>
      Promise.resolve(daemon(() => ({ ok: true, result: { task: T1, outcomes } })));
    const code = await runCli(["log", T1, "--machine"], cap.ctx);
    expect(code).toBe(0);
    const line = cap.stdout.replace(/\n$/, "");
    expect(line).toBe(canonicalJson({ ok: true, result: { task: T1, outcomes } }));
  });

  it("honours --from and replays locally when the daemon is down", async () => {
    const { entries } = fixtureState();
    readLogMock.mockResolvedValue(entries);
    const cap = capture();
    cap.ctx.connectDaemon = () => Promise.reject(new IpcClientError("connect", "down"));
    const code = await runCli(["log", T1, "--from", "2"], cap.ctx);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("#2");
    expect(cap.stdout).not.toContain("#1");
  });

  it("rejects a bad task id and a bad --from as usage", async () => {
    const cap = capture();
    expect(await runCli(["log", "not-a-task"], cap.ctx)).toBe(2);
    const again = capture();
    expect(await runCli(["log", T1, "--from", "0"], again.ctx)).toBe(2);
    expect(again.stderr.toLowerCase()).toContain("invalid");
  });

  it("drops outcomes for a different task", async () => {
    const cap = capture();
    cap.ctx.connectDaemon = () =>
      Promise.resolve(
        daemon(() => ({
          ok: true,
          result: [
            {
              seq: 2,
              sha: "a",
              outcome: "accepted",
              reason: null,
              event_id: null,
              type: "task.created",
              task_id: T1,
              actor: "human",
              signer: "human",
            },
            {
              seq: 4,
              sha: "b",
              outcome: "accepted",
              reason: null,
              event_id: null,
              type: "task.created",
              task_id: "T-20261005-a90c",
              actor: "human",
              signer: "human",
            },
          ],
        })),
      );
    const code = await runCli(["log", T1], cap.ctx);
    expect(code).toBe(0);
    expect(cap.stdout).toContain("#2");
    expect(cap.stdout).not.toContain("#4");
  });
});
