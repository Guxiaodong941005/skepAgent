// Peer progress over a real master and two real subs on 127.0.0.1:0 (plan §7.1).
import { duplexPair } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKEP_VERSION } from "../cli/version.js";
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
import {
  intentRollup,
  itemBlock,
  itemVerdict,
  SCROLLBACK_SUMMARY_CHARS,
  SCROLLBACK_SUMMARY_LINES,
  scrollbackSummary,
} from "./master.js";
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

function memoryTransport(master: MasterHandle) {
  const [masterStream, subStream] = duplexPair();
  // A destroyed end of this test transport closes its partner, as a disconnected socket does.
  masterStream.on("close", () => subStream.destroy());
  subStream.on("close", () => masterStream.destroy());
  master.attach(masterStream, { address: "127.0.0.1", family: "IPv4" });
  return subStream;
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
  const address = m.address;
  if (code === null || (address === null && extra.stream === undefined))
    throw new Error("master has no join code or transport");
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
    ...(options.stream === undefined && address !== null
      ? { target: { host: "127.0.0.1", port: address.port } }
      : {}),
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
  it("relays repos on v2 before intents while preserving strict v1 frames", async () => {
    const m = await master({ listen: undefined, version: SKEP_VERSION });
    const memoryJoin = (device: string, repo: string, options: Partial<SubOptions> = {}) => {
      return join(m, device, repo, { ...options, stream: memoryTransport(m) });
    };
    const a = await memoryJoin("mac", "app", {
      version: SKEP_VERSION,
      repo: "app",
      role: "backend",
    });
    const legacy = await memoryJoin("old", "api", { protocol: 1 });
    const b = await memoryJoin("vps", "web", { repo: "web", role: "web" });
    expect(a.handle.protocol).toBe(2);
    expect(a.handle.masterVersion?.()).toBe(SKEP_VERSION);
    expect(m.status().peers[0]?.version).toBe(SKEP_VERSION);
    await vi.waitFor(() => {
      expect(a.relays(b.handle.peerId).at(-1)).toMatchObject({ repo: "web", role: "web" });
      expect(b.relays(a.handle.peerId).at(-1)).toMatchObject({ repo: "app", role: "backend" });
      expect(legacy.relays(b.handle.peerId).at(-1)).toMatchObject({ role: "web" });
    });
    expect(m.status().intents).toEqual([]);
    expect(legacy.handle.protocol).toBe(1);
    expect(legacy.relays().every((relay) => relay.repo === undefined)).toBe(true);
    expect(legacy.closed).toBe(false);
    await m.submitIntent("describe the legacy repo", ["api"]);
    await vi.waitFor(() =>
      expect(a.relays(legacy.handle.peerId).at(-1)).toMatchObject({ repo: "api", role: "web" }),
    );
  });

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

  it.each([{ peerId: "peer-9" }, { repo: "forged-repo" }])(
    "disconnects a sub whose progress forges identity: %j",
    async (identity) => {
      const m = await master({ listen: undefined });
      const stream = memoryTransport(m);
      const seal = SecureChannel.prototype.seal;
      vi.spyOn(SecureChannel.prototype, "seal").mockImplementation(function (
        this: SecureChannel,
        obj: unknown,
      ) {
        const frame = obj as { type?: string; peerId?: string };
        // Only sub→master progress lacks a peerId; forge identity on that direction.
        return seal.call(
          this,
          frame.type === "progress" && frame.peerId === undefined ? { ...frame, ...identity } : obj,
        );
      });
      const code = m.status().joinCode;
      if (code === null) throw new Error("master has no join code");
      const sub = await connectSub({
        stream,
        code,
        device: "mac",
        describe: async () => ({ repo: "app", head: "c".repeat(40), role: "backend" }),
        collectDatalist: async () => [],
        onItem: async () => null,
      });
      subs.push(sub);
      await expect(sub.closed).resolves.toEqual({ reason: "connection_closed" });
      await vi.waitFor(() => expect(m.status().peers).toEqual([]));
    },
  );

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

  it("emits an accepted result's redacted, capped summary as an item-result event", async () => {
    const events: { kind: string; message: string }[] = [];
    const m = await master({ onEvent: (e) => events.push(e) });
    const token = `ghp_${"a".repeat(36)}`;
    const summary = ["", "added GET /healthz", `token ${token}`, "tests pass"].join("\n");
    await join(m, "mac", "app", { work: async (item) => ({ ...resultFor(item), summary }) });
    await m.submitIntent("add a health check");
    await vi.waitFor(() => expect(events.some((e) => e.kind === "item-result")).toBe(true));
    const result = events.find((e) => e.kind === "item-result");
    expect(result?.message).toMatch(
      /^I-1 done · mac \(app\)\n {2}added GET \/healthz\n {2}token .+\n {2}tests pass$/,
    );
    expect(result?.message).not.toContain(token);
    // Progress stays a bare peer id; the summary only arrives once, with the accepted result.
    for (const e of events.filter((entry) => entry.kind === "progress"))
      expect(e.message).not.toContain("healthz");
    expect(events.some((e) => e.kind === "result-ack")).toBe(false);
  });

  it("formats an item block: status folded into the headline, submit line last", () => {
    const summary = [
      "submit none local",
      "done · claude · 2m 14s",
      "changed 3 files (+41 −7): a.ts, b.ts, c.ts",
      "summary: Added validation.",
    ].join("\n");
    expect(itemBlock("I-1", { device: "mac", repo: "app" }, summary, "done")).toBe(
      [
        "I-1 done · mac (app) · claude · 2m 14s",
        "  changed 3 files (+41 −7): a.ts, b.ts, c.ts",
        "  summary: Added validation.",
        "  submit none local",
      ].join("\n"),
    );
    // An older peer's summary has no status line; it still renders.
    expect(itemBlock("I-2", { device: "vps", repo: "api" }, "submit none local\nok", "done")).toBe(
      "I-2 done · vps (api)\n  ok\n  submit none local",
    );
  });

  it("never caps a FAILED block: the cause and the whole text stay", () => {
    const trace = Array.from({ length: 30 }, (_, n) => `trace ${n} ${"y".repeat(30)}`);
    const summary = [
      "submit push failed",
      "FAILED · claude · 3s",
      "no changes",
      "cause: agent claude exited 3",
      "fix: read the agent's output below",
      ...trace,
    ].join("\n");
    const block = itemBlock("I-2", { device: "mac", repo: "app" }, summary, "failed");
    expect(block.startsWith("I-2 FAILED · mac (app) · claude · 3s\n  no changes\n")).toBe(true);
    expect(block).toContain("  cause: agent claude exited 3\n  fix: read the agent's output below");
    expect(block.length).toBeGreaterThan(SCROLLBACK_SUMMARY_CHARS);
    expect(block).toContain("trace 29");
    expect(scrollbackSummary(summary, { failed: true }).split("\n")).toHaveLength(35);
  });

  it("rolls an intent up across peers", () => {
    const result = (summary: string, status: "pass" | "fail" = "pass") => ({
      checks: [{ status }],
      summary,
    });
    expect(
      intentRollup([
        {
          state: "done",
          result: result("submit none local\ndone · a\nchanged 3 files (+1 −0): x"),
        },
        { state: "done", result: result("submit none local\ndone · a\nchanged 1 file (+1 −0): y") },
        { state: "done", result: result("FAILED", "fail") },
        { state: "failed" },
        { state: "claimed" },
      ]),
    ).toBe("2 done · 2 failed · 1 running · 4 files changed");
  });

  it("hands the sub's onItem the intent's full text, not just the 200-character title (S8)", async () => {
    const m = await master();
    const contexts: { title: string; intentText?: string }[] = [];
    const text = `rename the config loader. ${"More context for the agent. ".repeat(20)}END`;
    expect(text.length).toBeGreaterThan(200);
    await join(m, "mac", "app", {
      onItem: async (item, context) => {
        contexts.push({ title: item.title, ...context });
        return null;
      },
    });
    await m.submitIntent(text);
    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]?.title).toBe(text.slice(0, 200));
    expect(contexts[0]?.intentText).toBe(text);
  });

  it("a successful result event carries the whole summary for scrolling screens (S2)", async () => {
    const events: { kind: string; message: string; full?: string }[] = [];
    const m = await master({ onEvent: (e) => events.push(e) });
    const body = Array.from({ length: 40 }, (_, n) => `summary line ${n} ${"x".repeat(80)}`);
    const summary = `done · claude · 1s\n${body.join("\n")}`.slice(0, 4000);
    await join(m, "mac", "app", { work: async (item) => ({ ...resultFor(item), summary }) });
    await m.submitIntent("write a long report");
    await vi.waitFor(() => expect(events.some((e) => e.kind === "item-result")).toBe(true));
    const event = events.find((e) => e.kind === "item-result");
    // The plain CLI line stays capped; `full` has every line the peer sent.
    expect(event?.message).toContain("…");
    const kept = summary.split("\n").slice(1);
    for (const line of kept) expect(event?.full).toContain(line.trimEnd());
    expect(event?.full).not.toContain("…");
  });

  it("emits one intent-done roll-up when every item finished", async () => {
    const events: { kind: string; message: string }[] = [];
    const m = await master({ onEvent: (e) => events.push(e) });
    const summary = "submit none local\ndone · claude · 1s\nchanged 2 files (+2 −0): a, b";
    await join(m, "mac", "app", { work: async (item) => ({ ...resultFor(item), summary }) });
    await m.submitIntent("add a health check");
    await vi.waitFor(() => expect(events.some((e) => e.kind === "intent-done")).toBe(true));
    expect(events.filter((e) => e.kind === "intent-done").map((e) => e.message)).toEqual([
      "intent-1 done: add a health check\n  1 done · 0 failed · 2 files changed",
    ]);
  });

  it("counts failed submits, waiting agents and declined items apart from done", () => {
    const result = (summary: string, submit: string) => ({
      checks: [{ status: "pass" }],
      summary,
      submit: { state: submit },
    });
    const pushFailed = {
      state: "done",
      result: result("submit push failed\nFAILED · a", "failed"),
    };
    const waiting = {
      state: "done",
      result: result("submit push pending\nblocked · a", "pending"),
    };
    const declined = {
      state: "done",
      result: result("submit none skipped\ndeclined · a", "skipped"),
    };
    const done = { state: "done", result: result("submit push pushed\ndone · a", "pushed") };
    expect([pushFailed, waiting, declined, done].map(itemVerdict)).toEqual([
      "submit-failed",
      "pending",
      "declined",
      "done",
    ]);
    expect(intentRollup([pushFailed, waiting, declined, done])).toBe(
      "1 done · 0 failed · 1 submit failed · 1 waiting for you · 1 declined · 0 files changed",
    );
  });

  it("a failed submit is an uncapped SUBMIT FAILED block", () => {
    const cause = `cause: submit push failed: ${"remote said no ".repeat(60)}end-of-cause`;
    const summary = `submit push failed\nFAILED · claude · 1s\nchanged 1 file (+1 −0): a\n${cause}`;
    const block = itemBlock("I-1", { device: "mac", repo: "app" }, summary, "submit-failed");
    expect(block.startsWith("I-1 SUBMIT FAILED · mac (app) · claude · 1s\n")).toBe(true);
    expect(block).toContain("end-of-cause");
    expect(block.length).toBeGreaterThan(SCROLLBACK_SUMMARY_CHARS);
  });

  it.each([
    [
      "failed",
      "item-failed",
      "intent-failed",
      "intent-1 failed: ship it\n  1 done · 0 failed · 1 submit failed",
    ],
    [
      "pending",
      "item-pending",
      "intent-waiting",
      "intent-1 waiting for you: ship it\n  1 done · 0 failed · 1 waiting for you",
    ],
  ] as const)(
    "a %s submit on one of two peers is never announced as intent-done",
    async (state, itemKind, intentKind, rollup) => {
      const events: { kind: string; message: string }[] = [];
      const m = await master({ onEvent: (e) => events.push(e) });
      const ok = "submit none local\ndone · claude · 1s\nchanged 1 file (+1 −0): a";
      const bad =
        state === "failed"
          ? "submit push failed\nFAILED · claude · 1s\ncause: submit push failed: rejected"
          : "submit push pending\nblocked · claude · 1s\nagent x is waiting for you: herdr agent focus x";
      await join(m, "mac", "app", {
        work: async (item) => ({
          ...resultFor(item),
          summary: ok,
          submit: { method: "none", state: "local", branch: "main" },
        }),
      });
      await join(m, "vps", "api", {
        work: async (item) => ({
          ...resultFor(item),
          checks: [{ name: "agent", status: state === "failed" ? "pass" : "skip" }],
          summary: bad,
          submit: { method: "push", state, branch: "main" },
        }),
      });
      await m.submitIntent("ship it", ["app", "api"]);
      await vi.waitFor(() => expect(events.some((e) => e.kind.startsWith("intent-"))).toBe(true));
      expect(m.status().intents[0]?.items).toHaveLength(2);
      expect(events.some((e) => e.kind === "intent-done")).toBe(false);
      expect(events.filter((e) => e.kind.startsWith("intent-"))).toEqual([
        { kind: intentKind, message: expect.stringContaining(rollup) },
      ]);
      expect(events.filter((e) => e.kind === itemKind)).toHaveLength(1);
      expect(events.filter((e) => e.kind === "item-result")).toHaveLength(1);
    },
  );

  it("caps the scrollback summary by lines and characters", () => {
    expect(scrollbackSummary("")).toBe("(no summary)");
    expect(scrollbackSummary("  \n\n")).toBe("(no summary)");
    const many = Array.from({ length: 20 }, (_, n) => `line ${n}`).join("\n");
    const capped = scrollbackSummary(many);
    expect(capped.split("\n")).toHaveLength(SCROLLBACK_SUMMARY_LINES);
    expect(capped.endsWith(" …")).toBe(true);
    const long = scrollbackSummary("x".repeat(4_000));
    expect(long).toBe(`${"x".repeat(SCROLLBACK_SUMMARY_CHARS)} …`);
    expect(scrollbackSummary("done\r\n")).toBe("done");
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
