// Peer progress over a real master and two real subs on 127.0.0.1:0 (plan §7.1).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Clock } from "../util/clock.js";
import { SecureChannel } from "./channel.js";
import {
  type MasterHandle,
  type MasterOptions,
  type PeerProgress,
  type PlanItem,
  type SubHandle,
  type SubOptions,
  type SubResult,
  startMaster,
} from "./index.js";
import { deriveProgress } from "./progress.js";
import { connectSub } from "./sub.js";

const TOKEN = "a".repeat(32);
type Seen = PeerProgress & { self: boolean };

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
  advance(ms: number): void {
    this.now += ms;
    const due = this.sleepers.filter((entry) => entry.at <= this.now);
    this.sleepers = this.sleepers.filter((entry) => entry.at > this.now);
    for (const entry of due) entry.resolve();
  }
}

interface Joined {
  handle: SubHandle;
  seen: Seen[];
  items: PlanItem[];
  closed: boolean;
  /** Relays about other peers. */
  relays(peerId?: string): Seen[];
}

const masters: MasterHandle[] = [];
const subs: SubHandle[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(subs.splice(0).map((sub) => sub.close()));
  await Promise.all(masters.splice(0).map((master) => master.close()));
});

async function master(extra: Partial<MasterOptions> = {}): Promise<MasterHandle> {
  const handle = await startMaster({
    listen: { host: "127.0.0.1", port: 0 },
    device: "mac",
    repo: "app",
    controlToken: TOKEN,
    acceptJoin: async () => true,
    onJoinCode: () => {},
    progressIntervalMs: 0,
    datalistTimeoutMs: 5_000,
    ...extra,
  });
  masters.push(handle);
  return handle;
}

async function join(
  m: MasterHandle,
  device: string,
  repo: string,
  extra: Partial<SubOptions> & {
    work?: (item: PlanItem, joined: Joined) => Promise<SubResult | null>;
  } = {},
): Promise<Joined> {
  const code = m.status().joinCode;
  if (code === null || m.address === null) throw new Error("master has no join code");
  const { work, ...options } = extra;
  const joined: Joined = {
    handle: undefined as unknown as SubHandle,
    seen: [],
    items: [],
    closed: false,
    relays: (peerId) =>
      joined.seen.filter((p) => !p.self && (peerId === undefined || p.peerId === peerId)),
  };
  const handle = await connectSub({
    target: { host: "127.0.0.1", port: m.address.port },
    code,
    device,
    describe: async () => ({
      repo,
      head: "c".repeat(40),
      role: repo === "app" ? "backend" : "web",
    }),
    collectDatalist: async () => [],
    onItem: (item) => {
      joined.items.push(item);
      return work ? work(item, joined) : new Promise<never>(() => {});
    },
    onProgress: (p) => joined.seen.push(p),
    progressIntervalMs: 0,
    ...options,
  });
  joined.handle = handle;
  void handle.closed.then(() => {
    joined.closed = true;
  });
  subs.push(handle);
  await vi.waitFor(() =>
    expect(m.status().peers.some((p) => p.peerId === handle.peerId)).toBe(true),
  );
  return joined;
}

function resultFor(item: PlanItem): SubResult {
  return {
    repo: item.repo,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    checks: [{ name: "test", status: "pass" }],
    summary: "ok",
  };
}

describe("peer progress relay", () => {
  it("opts both subs in and snapshots the earlier peer to the later one", async () => {
    const m = await master();
    const a = await join(m, "mac", "app");
    const b = await join(m, "vps", "api");
    await vi.waitFor(() =>
      expect(b.relays(a.handle.peerId)[0]).toEqual({
        peerId: a.handle.peerId,
        device: "mac",
        role: null,
        phase: "idle",
        done: 0,
        total: 0,
        failed: 0,
        percent: 0,
        summary: "",
        self: false,
      }),
    );
    // A was opted in before B joined, so A hears about B through the join relay.
    await vi.waitFor(() =>
      expect(a.relays(b.handle.peerId)[0]).toMatchObject({ device: "vps", phase: "idle" }),
    );
    expect(a.seen[0]).toMatchObject({ self: true, peerId: a.handle.peerId, phase: "idle" });
  });

  it("relays claim, result and status both ways without echoing the subject", async () => {
    const m = await master();
    const a = await join(m, "mac", "app", { work: async (item) => resultFor(item) });
    const b = await join(m, "vps", "api");
    await m.submitIntent("add a health check");
    await vi.waitFor(() =>
      expect(b.relays(a.handle.peerId).at(-1)).toMatchObject({
        phase: "done",
        done: 1,
        total: 1,
        percent: 100,
      }),
    );
    const aboutA = b.relays(a.handle.peerId);
    expect(aboutA).toContainEqual(
      expect.objectContaining({
        peerId: a.handle.peerId,
        device: "mac",
        role: "backend",
        phase: "working",
        summary: "add a health check",
        itemId: "I-1",
      }),
    );
    expect(a.relays().every((p) => p.peerId !== a.handle.peerId)).toBe(true);
    expect(a.seen.filter((p) => p.self).at(-1)).toMatchObject({ phase: "done", percent: 100 });
    // B's role reaches A once B described itself for the intent.
    await vi.waitFor(() =>
      expect(a.relays(b.handle.peerId).at(-1)).toMatchObject({ role: "web", phase: "idle" }),
    );

    const status = m.status();
    const items = status.intents.flatMap((intent) => intent.items);
    const statusA = status.peers.find((p) => p.peerId === a.handle.peerId);
    expect(statusA?.progress).toEqual(deriveProgress(items, a.handle.peerId, null));
    expect(statusA?.progress).toEqual({
      phase: "done",
      done: 1,
      total: 1,
      failed: 0,
      percent: 100,
      summary: "",
    });
    expect(status.peers.find((p) => p.peerId === b.handle.peerId)?.progress.phase).toBe("idle");
  });

  it("relays a blocked agent reported through reportAgent", async () => {
    const m = await master();
    const a = await join(m, "mac", "app", {
      work: async (item, joined) => {
        joined.handle.reportAgent?.(item.itemId, "starting");
        joined.handle.reportAgent?.(item.itemId, "blocked");
        return new Promise<never>(() => {});
      },
    });
    const b = await join(m, "vps", "api");
    await m.submitIntent("ask the human");
    await vi.waitFor(() =>
      expect(b.relays(a.handle.peerId).at(-1)).toMatchObject({ phase: "blocked", total: 1 }),
    );
    await vi.waitFor(() =>
      expect(m.status().peers.find((p) => p.peerId === a.handle.peerId)?.progress.phase).toBe(
        "blocked",
      ),
    );
  });

  it("keeps a sub without progress connected and still relays its derived strip", async () => {
    const m = await master();
    const a = await join(m, "mac", "app", { work: async (item) => resultFor(item) });
    const old = await join(m, "vps", "api", { progress: false });
    await vi.waitFor(() =>
      expect(a.relays(old.handle.peerId)[0]).toMatchObject({ device: "vps", phase: "idle" }),
    );
    await m.submitIntent("add a health check");
    await vi.waitFor(() => expect(m.status().intents[0]?.items[0]?.state).toBe("done"));
    await vi.waitFor(() =>
      expect(a.relays(old.handle.peerId).at(-1)).toMatchObject({ role: "web" }),
    );
    expect(old.relays()).toEqual([]);
    expect(old.closed).toBe(false);
    expect(m.status().peers).toHaveLength(2);
  });

  it("disconnects a sub whose progress names a peer", async () => {
    const m = await master();
    const seal = SecureChannel.prototype.seal;
    vi.spyOn(SecureChannel.prototype, "seal").mockImplementation(function (
      this: SecureChannel,
      obj: unknown,
    ) {
      const frame = obj as { type?: string; peerId?: string };
      // Only sub→master progress lacks a peerId; forge one there.
      return seal.call(
        this,
        frame.type === "progress" && frame.peerId === undefined
          ? { ...frame, peerId: "peer-9" }
          : obj,
      );
    });
    const code = m.status().joinCode;
    if (code === null || m.address === null) throw new Error("master has no join code");
    const sub = await connectSub({
      target: { host: "127.0.0.1", port: m.address.port },
      code,
      device: "mac",
      describe: async () => ({ repo: "app", head: "c".repeat(40), role: "backend" }),
      collectDatalist: async () => [],
      onItem: async () => null,
    });
    subs.push(sub);
    await expect(sub.closed).resolves.toEqual({ reason: "connection_closed" });
    await vi.waitFor(() => expect(m.status().peers).toEqual([]));
  });

  it("disconnects a sub that receives a relay naming itself", async () => {
    const m = await master();
    const a = await join(m, "mac", "app");
    const seal = SecureChannel.prototype.seal;
    vi.spyOn(SecureChannel.prototype, "seal").mockImplementation(function (
      this: SecureChannel,
      obj: unknown,
    ) {
      const frame = obj as { type?: string; peerId?: string };
      return seal.call(
        this,
        frame.type === "progress" && frame.peerId !== undefined
          ? { ...frame, peerId: a.handle.peerId }
          : obj,
      );
    });
    // B's join relay to A is forged to name A itself; A must drop the connection.
    await join(m, "vps", "api");
    await vi.waitFor(() => expect(a.closed).toBe(true));
    expect(a.relays().some((p) => p.peerId === a.handle.peerId)).toBe(false);
  });

  it("relays left when a peer disconnects", async () => {
    const m = await master();
    const a = await join(m, "mac", "app");
    const b = await join(m, "vps", "api");
    await vi.waitFor(() => expect(b.relays(a.handle.peerId)).toHaveLength(1));
    await a.handle.close();
    await vi.waitFor(() =>
      expect(b.relays(a.handle.peerId).at(-1)).toMatchObject({
        phase: "left",
        device: "mac",
        done: 0,
        total: 0,
        percent: 0,
        summary: "",
      }),
    );
    expect(m.status().peers.map((p) => p.peerId)).toEqual([b.handle.peerId]);
  });

  it("emits a progress event only on phase changes", async () => {
    const events: string[] = [];
    const m = await master({
      onEvent: (e) => {
        if (e.kind === "progress") events.push(e.message);
      },
    });
    const a = await join(m, "mac", "app", { work: async (item) => resultFor(item) });
    await m.submitIntent("add a health check");
    await vi.waitFor(() => expect(m.status().intents[0]?.items[0]?.state).toBe("done"));
    await vi.waitFor(() => expect(a.seen.at(-1)).toMatchObject({ self: true, phase: "done" }));
    // idle (join) → working (claim) → done (result).
    expect(events).toEqual([a.handle.peerId, a.handle.peerId, a.handle.peerId]);
  });

  it("rejects reportAgent for an unknown item and ignores it after close", async () => {
    const m = await master();
    const a = await join(m, "mac", "app");
    expect(() => a.handle.reportAgent?.("I-404", "running")).toThrow(/Unknown session item/);
    await a.handle.close();
    expect(() => a.handle.reportAgent?.("I-404", "running")).not.toThrow();
  });

  it("coalesces a burst from one peer to at most two frames, ending with the latest", async () => {
    const clock = new ManualClock();
    const m = await master({ clock, progressIntervalMs: 500 });
    const a = await join(m, "mac", "app");
    const b = await join(m, "vps", "api");
    await vi.waitFor(() => expect(b.relays(a.handle.peerId)).toHaveLength(1));
    const before = b.relays(a.handle.peerId).length;
    // Ten distinct changes to A (each intent adds and claims an item) while no master time
    // passes, i.e. well inside one 500 ms window.
    for (let n = 1; n <= 10; n++) {
      await m.submitIntent(`task ${n}`);
      await vi.waitFor(() => expect(a.items).toHaveLength(n));
    }
    await vi.waitFor(() =>
      expect(m.status().peers.find((p) => p.peerId === a.handle.peerId)?.progress).toMatchObject({
        total: 10,
        itemId: "I-10",
      }),
    );
    clock.advance(500);
    await vi.waitFor(() =>
      expect(b.relays(a.handle.peerId).at(-1)).toMatchObject({
        phase: "working",
        total: 10,
        summary: "task 10",
        itemId: "I-10",
      }),
    );
    const burst = b.relays(a.handle.peerId).slice(before);
    expect(burst.length).toBeLessThanOrEqual(2);
  });
});
