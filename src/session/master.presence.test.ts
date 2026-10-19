// Presence, named disconnect events and descriptive no_match over a real master on 127.0.0.1:0
// (docs/plans/tui-session-reliability.md §2, §4).
import { afterEach, describe, expect, it } from "vitest";
import { controlRequest } from "../cli/commands/session.js";
import type { Clock } from "../util/clock.js";
import { type MasterHandle, type SubHandle, startMaster } from "./index.js";
import { itemVerdict } from "./master.js";
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
  fire(): void {
    const due = this.sleepers.filter((s) => s.at <= this.now);
    this.sleepers = this.sleepers.filter((s) => s.at > this.now);
    for (const s of due) s.resolve();
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

async function setup(subRepo = "app", masterRepo = "app") {
  const clock = new ManualClock();
  const events: { kind: string; message: string }[] = [];
  const datalistRepos: string[] = [];
  const master = await startMaster({
    listen: { host: "127.0.0.1", port: 0 },
    device: "mac",
    repo: masterRepo,
    controlToken: TOKEN,
    acceptJoin: async () => true,
    onJoinCode: () => {},
    onEvent: (event) => events.push(event),
    clock,
    progressIntervalMs: 0,
  });
  masters.push(master);
  const join = async (repo = subRepo, role = "coding"): Promise<SubHandle> => {
    const count = master.status().peers.length;
    const code = master.status().joinCode;
    if (code === null || master.address === null) throw new Error("master has no join code");
    const sub = await connectSub({
      target: { host: "127.0.0.1", port: master.address.port },
      code,
      device: "vps",
      repo,
      role,
      clock,
      describe: async () => ({ repo, head: "c".repeat(40), role }),
      collectDatalist: async (repo) => {
        datalistRepos.push(repo);
        return [];
      },
      onItem: () => new Promise<never>(() => {}),
      progressIntervalMs: 0,
    });
    subs.push(sub);
    await until(
      () =>
        master.status().peers.length === count + 1 &&
        master.status().peers.some((p) => p.peerId === sub.peerId && p.repo === repo),
    );
    return sub;
  };
  return { clock, events, master, join, datalistRepos };
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

  it("names the explicit repo when no connected peer works on it", async () => {
    const { master, join } = await setup("api");
    await join();
    await expect(master.submitIntent("add a health check", ["app"])).rejects.toThrow(
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

describe("lone peer routing (INTENT-PEER)", () => {
  it("routes a bare intent to the only peer even when its repo differs", async () => {
    const { master, join, datalistRepos } = await setup("skepAgent", "futrobomower");
    await join();
    await expect(master.submitIntent("view branch")).resolves.toEqual({ intentId: "intent-1" });
    await until(() => master.status().intents[0]?.state === "planned");
    expect(master.status().intents[0]?.items).toEqual([
      expect.objectContaining({ repo: "skepAgent", assignee: "peer-1" }),
    ]);
    expect(datalistRepos).toEqual(["skepAgent"]);
  });

  it("routes an explicit --repo naming the lone peer's repo", async () => {
    const { master, join } = await setup("skepAgent", "futrobomower");
    await join();
    await master.submitIntent("view branch", ["skepAgent"]);
    await until(() => master.status().intents[0]?.state === "planned");
    expect(master.status().intents[0]?.items).toEqual([
      expect.objectContaining({ repo: "skepAgent", assignee: "peer-1" }),
    ]);
  });

  it("keeps no_match for an explicit repo the lone peer does not work on", async () => {
    const { master, join } = await setup("skepAgent", "futrobomower");
    await join();
    await expect(master.submitIntent("view branch", ["futrobomower"])).rejects.toThrow(
      "works on repo futrobomower",
    );
  });

  it("does not fall back when multiple connected candidates answer", async () => {
    const { master, join } = await setup("api");
    await join();
    await join("web");
    await expect(master.submitIntent("view branch")).rejects.toThrow(
      "None of the 2 connected peer(s) works on repo app",
    );
    expect(master.status().intents[0]?.items).toEqual([]);
  });

  it("keeps the matching repo when several candidates answer", async () => {
    const { master, join } = await setup("api");
    await join();
    await join("app");
    await master.submitIntent("view branch");
    await until(() => master.status().intents[0]?.state === "planned");
    expect(master.status().intents[0]?.items).toEqual([
      expect.objectContaining({ repo: "app", assignee: "peer-2" }),
    ]);
  });

  it("plans matched explicit repos in order and keeps earliest-join assignment", async () => {
    const { master, join } = await setup("api");
    await join();
    await join();
    await join("web");
    await master.submitIntent("view branch", ["web", "api", "api", "missing"]);
    await until(() => master.status().intents[0]?.state === "planned");
    expect(master.status().intents[0]?.items).toEqual([
      expect.objectContaining({ repo: "web", assignee: "peer-3" }),
      expect.objectContaining({ repo: "api", assignee: "peer-1" }),
    ]);
  });
});

describe("lost work recovery", () => {
  it("derives lost without changing wire state and retries the original brief on a new peer", async () => {
    const { master, join } = await setup();
    const old = await join();
    await master.submitIntent("Original brief: implement the health check", ["app"]);
    await until(() => master.status().intents[0]?.items[0]?.state === "claimed");
    await old.close();
    await until(() => master.status().peers.length === 0);
    const lost = master.status().intents[0]?.items[0];
    expect(lost?.state).toBe("failed");
    if (!lost) throw new Error("missing lost item");
    expect(itemVerdict(lost)).toBe("lost");
    await expect(master.retryItem?.("I-1")).rejects.toThrow("No connected peer");
    const replacement = await join();
    expect(await master.retryItem?.("I-1")).toEqual({
      itemId: "I-1",
      intentId: "intent-2",
      peerId: replacement.peerId,
    });
    await until(() => master.status().intents[1]?.items[0]?.state === "claimed");
    expect(master.status().intents[1]?.text).toBe(master.status().intents[0]?.text);
    expect(master.status().intents[1]?.items[0]?.assignee).toBe(replacement.peerId);
    await expect(master.retryItem?.("I-1")).rejects.toThrow("already has a retry");
    await expect(master.retryItem?.("I-2")).rejects.toThrow("not a lost or failed");
  });

  it.each([false, true])("warns once at 20 s only with running items: %s", async (running) => {
    const { clock, master, join, events } = await setup();
    await join();
    if (running) {
      await master.submitIntent("Work", ["app"]);
      await until(() => master.status().intents[0]?.items[0]?.state === "claimed");
    }
    clock.skip(20_000);
    clock.fire();
    await until(() => (running ? events.some((e) => e.kind === "quiet") : true));
    await new Promise<void>((r) => setImmediate(r));
    expect(events.filter((e) => e.kind === "quiet")).toHaveLength(running ? 1 : 0);
    expect(master.status().peers).toHaveLength(1);
    clock.skip(20_000);
    clock.fire();
    await new Promise<void>((r) => setImmediate(r));
    expect(events.filter((e) => e.kind === "quiet")).toHaveLength(running ? 1 : 0);
  });
});

it("retry enforces the original role and an explicit replacement peer", async () => {
  const { master, join } = await setup();
  const original = await join("app", "device");
  await master.submitIntent("Original role brief", ["app"]);
  await until(() => master.status().intents[0]?.items[0]?.state === "claimed");
  await original.close();
  await until(() => master.status().peers.length === 0);
  const wrong = await join("app", "server");
  const right = await join("app", "device");
  await expect(master.retryItem?.("I-1", wrong.peerId)).rejects.toThrow("role device");
  await master.retryItem?.("I-1", right.peerId);
  await until(() => master.status().intents[1]?.items[0]?.state === "claimed");
  expect(master.status().intents[1]?.items[0]?.assignee).toBe(right.peerId);
  expect(master.itemIdentity?.("I-1")).toEqual({ device: "vps", role: "device" });
});
