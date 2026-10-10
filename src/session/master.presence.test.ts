// Presence, named disconnect events and descriptive no_match over a real master on 127.0.0.1:0
// (docs/plans/tui-session-reliability.md §2, §4).
import { afterEach, describe, expect, it } from "vitest";
import { controlRequest } from "../cli/commands/session.js";
import type { Clock } from "../util/clock.js";
import { type MasterHandle, type SubHandle, startMaster } from "./index.js";
import { connectSub } from "./sub.js";

const TOKEN = "b".repeat(32);

/** Monotonic time only moves on `advance`; sleeps resolve when their deadline passes. */
class ManualClock implements Clock {
  private now = 0;
  private sleepers: { at: number; resolve: () => void }[] = [];
  monotonicMs = () => this.now;
  nowMs = () => 1_800_000_000_000 + this.now;
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const sleeper = { at: this.now + ms, resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.sleepers = this.sleepers.filter((entry) => entry !== sleeper);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }
  /** Moves time without firing sleepers, so no heartbeat is sent or missed. */
  skip(ms: number): void {
    this.now += ms;
  }
}

const masters: MasterHandle[] = [];
const subs: SubHandle[] = [];

afterEach(async () => {
  await Promise.all(subs.splice(0).map((sub) => sub.close()));
  await Promise.all(masters.splice(0).map((master) => master.close()));
});

async function setup(subRepo = "app") {
  const clock = new ManualClock();
  const events: { kind: string; message: string }[] = [];
  const master = await startMaster({
    listen: { host: "127.0.0.1", port: 0 },
    device: "mac",
    repo: "app",
    controlToken: TOKEN,
    acceptJoin: async () => true,
    onJoinCode: () => {},
    onEvent: (event) => events.push(event),
    clock,
    progressIntervalMs: 0,
  });
  masters.push(master);
  const join = async (): Promise<SubHandle> => {
    const code = master.status().joinCode;
    if (code === null || master.address === null) throw new Error("master has no join code");
    const sub = await connectSub({
      target: { host: "127.0.0.1", port: master.address.port },
      code,
      device: "vps",
      clock,
      describe: async () => ({ repo: subRepo, head: "c".repeat(40), role: "coding" }),
      collectDatalist: async () => [],
      onItem: () => new Promise<never>(() => {}),
      progressIntervalMs: 0,
    });
    subs.push(sub);
    await until(() => master.status().peers.length === 1);
    return sub;
  };
  return { clock, events, master, join };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

describe("session presence", () => {
  it("reports how long each side has been silent", async () => {
    const { clock, master, join } = await setup();
    const sub = await join();
    clock.skip(7_000);
    expect(master.presence?.()).toEqual([{ peerId: "peer-1", silentMs: expect.any(Number) }]);
    expect(master.presence?.()[0]?.silentMs).toBeGreaterThanOrEqual(7_000);
    expect(sub.silenceMs?.()).toBeGreaterThanOrEqual(7_000);
  });

  it("names the peer and the reason when it leaves", async () => {
    const { events, master, join } = await setup();
    const sub = await join();
    await sub.close();
    await until(() => master.status().peers.length === 0);
    await until(() => events.some((event) => event.kind === "left"));
    expect(events).toContainEqual({ kind: "left", message: "Peer peer-1 (vps) left: sub_closed" });
  });

  it("emits no event for a finished control request", async () => {
    const { clock, events, master } = await setup();
    const address = master.address;
    if (address === null) throw new Error("unbound");
    const reply = await controlRequest(
      address,
      { type: "control", v: 1, token: TOKEN, op: "status" },
      clock,
    );
    expect(reply.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((event) => event.kind !== "progress")).toEqual([]);
  });
});

describe("no_match", () => {
  it("says no peer joined when the session is empty", async () => {
    const { master } = await setup();
    await expect(master.submitIntent("add a health check")).rejects.toThrow(
      /No peers have joined the session/,
    );
  });

  it("names the repo when no connected peer works on it", async () => {
    const { master, join } = await setup("api");
    await join();
    await expect(master.submitIntent("add a health check")).rejects.toThrow(
      "None of the 1 connected peer(s) works on repo app",
    );
  });

  it("carries the reason through the control port", async () => {
    const { clock, master } = await setup();
    const address = master.address;
    if (address === null) throw new Error("unbound");
    const reply = await controlRequest(
      address,
      { type: "control", v: 1, token: TOKEN, op: "intent", text: "add a health check" },
      clock,
    );
    expect(reply).toEqual({
      type: "control-result",
      ok: false,
      error: { code: "no_match", message: expect.stringMatching(/No peers have joined/) },
    });
  });
});
