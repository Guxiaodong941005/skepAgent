// Session protocol v2 over a real master and real subs on 127.0.0.1:0: negotiation, the mixed
// v1/v2 matrix, targeted intents, long briefs, changed files and opt-in live output (ORCH-6).
import { createServer, type Server } from "node:net";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFrame } from "./codec.js";
import { createEphemeral, deriveKeys } from "./handshake.js";
import {
  type MasterEvent,
  type MasterHandle,
  type MasterOptions,
  OLDER_MASTER_NOTE,
  OlderMasterError,
  type PlanItem,
  type SubHandle,
  type SubOptions,
  type SubResult,
  startMaster,
} from "./index.js";
import { connectSub } from "./sub.js";

const TOKEN = "a".repeat(32);
const masters: MasterHandle[] = [];
const subs: SubHandle[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(subs.splice(0).map((sub) => sub.close()));
  await Promise.all(masters.splice(0).map((master) => master.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function master(events: MasterEvent[] = [], extra: Partial<MasterOptions> = {}) {
  const handle = await startMaster({
    listen: { host: "127.0.0.1", port: 0 },
    device: "mac",
    repo: "app",
    controlToken: TOKEN,
    acceptJoin: async () => true,
    onJoinCode: () => {},
    onEvent: (event) => events.push(event),
    progressIntervalMs: 0,
    datalistTimeoutMs: 5_000,
    version: "0.2.0",
    ...extra,
  });
  masters.push(handle);
  return handle;
}

interface Joined {
  handle: SubHandle;
  items: PlanItem[];
  texts: (string | undefined)[];
  events: { kind: string; message: string }[];
}

async function join(
  m: MasterHandle,
  device: string,
  repo: string,
  extra: Partial<SubOptions> & {
    port?: number;
    work?: (item: PlanItem, joined: Joined) => Promise<SubResult | null>;
  } = {},
): Promise<Joined> {
  const code = m.status().joinCode;
  if (code === null || m.address === null) throw new Error("master has no join code");
  const { work, port, ...options } = extra;
  const joined: Joined = {
    handle: undefined as unknown as SubHandle,
    items: [],
    texts: [],
    events: [],
  };
  const handle = await connectSub({
    target: { host: "127.0.0.1", port: port ?? m.address.port },
    code,
    device,
    version: "0.2.0",
    describe: async () => ({ repo, head: "c".repeat(40), role: "coding" }),
    collectDatalist: async () => [],
    onItem: (item, context) => {
      joined.items.push(item);
      joined.texts.push(context?.intentText);
      return work ? work(item, joined) : new Promise<never>(() => {});
    },
    onEvent: (event) => joined.events.push(event),
    progressIntervalMs: 0,
    ...options,
  });
  joined.handle = handle;
  subs.push(handle);
  await vi.waitFor(() =>
    expect(m.status().peers.some((p) => p.peerId === handle.peerId)).toBe(true),
  );
  return joined;
}

function result(item: PlanItem, extra: Partial<SubResult> = {}): SubResult {
  return {
    repo: item.repo,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    checks: [{ name: "agent", status: "pass" }],
    summary: "done · claude · 1s\nchanged 2 files (+3 -1): src/a.ts, src/b.ts",
    ...extra,
  };
}

const changed = {
  files: [
    { path: "src/a.ts", change: "modified" as const, added: 3, removed: 1 },
    { path: "src/b.ts", change: "added" as const, added: null, removed: null },
  ],
  total: 2,
  partial: false,
};

/**
 * A listener that behaves like a ≤0.1.13 master for `join{v:2}` (control `bad_request`, hang
 * up, code untouched) and hands every other connection to the real master.
 */
async function v1Front(m: MasterHandle): Promise<{ port: number; joins: number[] }> {
  const joins: number[] = [];
  const server = createServer((socket) => {
    socket.once("data", (chunk: Buffer) => {
      const first = JSON.parse(chunk.subarray(4).toString("utf8")) as { v?: number };
      joins.push(first.v ?? 0);
      if (first.v !== 1) {
        const error = {
          type: "control-result",
          ok: false,
          error: { code: "bad_request", message: "Invalid first session request" },
        };
        socket.end(encodeFrame(Buffer.from(JSON.stringify(error))));
        return;
      }
      socket.pause();
      socket.unshift(chunk);
      m.attach(socket, { address: "127.0.0.1", family: "IPv4" });
      socket.resume();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return { port: address.port, joins };
}

describe("negotiation", () => {
  it("a v2 sub and a v2 master speak v2 and learn each other's release", async () => {
    const m = await master();
    const sub = await join(m, "box", "app");
    expect(sub.handle.protocol).toBe(2);
    expect(sub.handle.masterVersion?.()).toBe("0.2.0");
    await vi.waitFor(() =>
      expect(m.status().peers[0]).toMatchObject({
        protocol: 2,
        version: "0.2.0",
        shareOutput: false,
      }),
    );
  });

  it("a v1 sub (≤0.1.13 behavior) joins a v2 master on v1", async () => {
    const m = await master();
    const sub = await join(m, "box", "app", { protocol: 1 });
    expect(sub.handle.protocol).toBe(1);
    expect(sub.handle.masterVersion?.()).toBeNull();
    expect(m.status().peers[0]).toMatchObject({ protocol: 1, version: null });
    expect(() => sub.handle.shareOutput?.(true)).toThrow(OlderMasterError);
  });

  it("a v2 sub retries once with v1 when the master is older, and says so", async () => {
    const m = await master();
    const front = await v1Front(m);
    const sub = await join(m, "box", "app", { port: front.port });
    expect(front.joins).toEqual([2, 1]);
    expect(sub.handle.protocol).toBe(1);
    expect(sub.events).toContainEqual({ kind: "protocol", message: OLDER_MASTER_NOTE });
  });

  it("a v2 sub on a caller-supplied stream cannot retry and names the cause", async () => {
    // Writes from the sub are swallowed; the test pushes the master's side.
    const stream = new Duplex({ read() {}, write: (_chunk, _encoding, done) => done() });
    const pending = connectSub({
      stream,
      code: "1234-5678-9012",
      device: "box",
      describe: async () => ({ repo: "app", head: "c".repeat(40), role: "coding" }),
      collectDatalist: async () => [],
      onItem: async () => null,
    });
    // Answer the join like a v1 master.
    const error = {
      type: "control-result",
      ok: false,
      error: { code: "bad_request", message: "Invalid first session request" },
    };
    stream.push(encodeFrame(Buffer.from(JSON.stringify(error))));
    await expect(pending).rejects.toBeInstanceOf(OlderMasterError);
  });

  it("binds the protocol into the keys, so a rewritten version fails confirmation", () => {
    const random = { bytes: (n: number) => new Uint8Array(n).fill(7) };
    const sub = createEphemeral(random);
    const masterKey = createEphemeral({ bytes: (n: number) => new Uint8Array(n).fill(9) });
    const nonce = Buffer.alloc(16, 1);
    const keys = (protocol: 1 | 2 | undefined) =>
      deriveKeys({
        privateKey: sub.privateKey,
        remotePub: masterKey.pub,
        subPub: sub.pub,
        subNonce: nonce,
        masterPub: masterKey.pub,
        masterNonce: nonce,
        device: "box",
        code: "1234-5678-9012",
        ...(protocol === undefined ? {} : { protocol }),
      });
    expect(keys(1).th).toEqual(keys(undefined).th);
    expect(keys(2).th).not.toEqual(keys(1).th);
    expect(keys(2).confirmS).not.toEqual(keys(1).confirmS);
  });
});

describe("intents", () => {
  it("sends a named-repo intent only to peers that work on it (or have not said)", async () => {
    const m = await master();
    const app = await join(m, "box", "app", { work: async (item) => result(item) });
    const web = await join(m, "pad", "web", { work: async (item) => result(item) });
    // Teach the master both repos, then target one.
    await m.submitIntent("first", ["app", "web"]);
    await vi.waitFor(() => expect(web.items).toHaveLength(1));
    const second = await m.submitIntent("only app", ["app"]);
    await vi.waitFor(() => expect(app.items).toHaveLength(2));
    expect(web.items).toHaveLength(1);
    expect(m.status().intents.find((i) => i.intentId === second.intentId)?.items).toHaveLength(1);
  });

  it("gives a v2 peer the whole long brief and a v1 peer its first 4000 characters", async () => {
    const m = await master();
    const v2 = await join(m, "box", "app");
    const v1 = await join(m, "pad", "web", { protocol: 1 });
    const brief = `Fix the login bug\n\n${"step. ".repeat(1200)}`;
    expect(brief.length).toBeGreaterThan(4000);
    await m.submitIntent(brief, ["app", "web"]);
    await vi.waitFor(() => expect(v2.texts).toHaveLength(1));
    await vi.waitFor(() => expect(v1.texts).toHaveLength(1));
    expect(v2.texts[0]).toBe(brief);
    expect(v1.texts[0]).toHaveLength(4000);
    expect(v1.texts[0]?.endsWith("…")).toBe(true);
    // Both still get the same 200-character title.
    expect(v1.items[0]?.title).toBe(v2.items[0]?.title);
    // The control status keeps the v1 limit for older local clients.
    expect(m.status().intents[0]?.text.length).toBe(4000);
  });
});

describe("results", () => {
  it("carries the changed-files list from a v2 peer and drops it on v1", async () => {
    const m = await master();
    await join(m, "box", "app", { work: async (item) => result(item, { changed }) });
    await join(m, "pad", "web", { protocol: 1, work: async (item) => result(item, { changed }) });
    await m.submitIntent("change things", ["app", "web"]);
    await vi.waitFor(() =>
      expect(m.status().intents[0]?.items.map((item) => item.state)).toEqual(["done", "done"]),
    );
    const items = m.status().intents[0]?.items ?? [];
    expect(items.find((i) => i.repo === "app")?.result?.changed).toEqual(changed);
    expect(items.find((i) => i.repo === "web")?.result?.changed).toBeUndefined();
  });

  it("redacts changed paths before they leave the peer", async () => {
    const m = await master();
    const secret = `ghp_${"A".repeat(36)}`;
    await join(m, "box", "app", {
      work: async (item) =>
        result(item, {
          changed: {
            files: [{ path: `keys/${secret}.txt`, change: "added", added: 1, removed: 0 }],
            total: 1,
            partial: false,
          },
        }),
    });
    await m.submitIntent("x", ["app"]);
    await vi.waitFor(() => expect(m.status().intents[0]?.items[0]?.state).toBe("done"));
    const path = m.status().intents[0]?.items[0]?.result?.changed?.files[0]?.path ?? "";
    expect(path).not.toContain(secret);
  });
});

describe("live output", () => {
  /** Joins a peer whose item stays running until `release` is called. */
  async function running(m: MasterHandle, extra: Partial<SubOptions> = {}) {
    let release: () => void = () => {};
    const sub = await join(m, "box", "app", {
      ...extra,
      work: (item) =>
        new Promise((resolve) => {
          release = () => resolve(result(item));
        }),
    });
    await m.submitIntent("watch me", ["app"]);
    await vi.waitFor(() => expect(sub.items).toHaveLength(1));
    await vi.waitFor(() => expect(m.status().intents[0]?.items[0]?.state).toBe("claimed"));
    return { sub, itemId: sub.items[0]?.itemId ?? "", release: () => release() };
  }

  it("stays on the peer unless its human opted in", async () => {
    const events: MasterEvent[] = [];
    const m = await master(events);
    const { sub, itemId } = await running(m);
    sub.handle.reportOutput?.(itemId, "compiling\nsecret stuff\n");
    // A heartbeat-free round trip: the next opt-in frame arrives after anything sent before it.
    sub.handle.shareOutput?.(true);
    await vi.waitFor(() => expect(events.some((e) => e.kind === "share-output")).toBe(true));
    expect(events.filter((e) => e.kind === "peer-output")).toEqual([]);
  });

  it("sends complete, redacted, control-stripped lines once opted in", async () => {
    const events: MasterEvent[] = [];
    const m = await master(events);
    const { sub, itemId } = await running(m, { shareOutput: true });
    const peerId = sub.handle.peerId;
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ kind: "share-output", peerId })),
    );
    const secret = `ghp_${"B".repeat(36)}`;
    sub.handle.reportOutput?.(itemId, `\x1b[32mok\x1b[0m test 1\ntoken ${secret}\npart`);
    await vi.waitFor(() => expect(events.some((e) => e.kind === "peer-output")).toBe(true));
    const output = events.find((e) => e.kind === "peer-output");
    expect(output).toMatchObject({ peerId, itemId });
    expect(output?.message.split("\n")[0]).toBe("ok test 1");
    expect(output?.message).not.toContain(secret);
    // The unfinished line is never sent on its own.
    expect(output?.message).not.toContain("part");
    expect(m.status().peers[0]?.shareOutput).toBe(true);
  });

  it("stops at once when the peer turns sharing off", async () => {
    const events: MasterEvent[] = [];
    const m = await master(events);
    const { sub, itemId } = await running(m, { shareOutput: true });
    sub.handle.shareOutput?.(false);
    sub.handle.reportOutput?.(itemId, "after off\n");
    await vi.waitFor(() => expect(events.filter((e) => e.kind === "share-output")).toHaveLength(2));
    expect(events.some((e) => e.kind === "peer-output")).toBe(false);
    expect(sub.handle.sharingOutput?.()).toBe(false);
  });

  it("keeps at most 20 lines per frame and counts the rest", async () => {
    const events: MasterEvent[] = [];
    const m = await master(events);
    const { sub, itemId } = await running(m, { shareOutput: true });
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    sub.handle.reportOutput?.(itemId, `${lines}\n`);
    await vi.waitFor(() => expect(events.some((e) => e.kind === "peer-output")).toBe(true));
    const message = events.find((e) => e.kind === "peer-output")?.message.split("\n") ?? [];
    expect(message[0]).toBe("… 10 line(s) not shown");
    expect(message.slice(1)).toHaveLength(20);
    expect(message[20]).toBe("line 29");
  });

  it("drops a burst beyond the master's budget instead of flooding the panel", async () => {
    const events: MasterEvent[] = [];
    const m = await master(events);
    const { sub, itemId } = await running(m, { shareOutput: true });
    for (let i = 0; i < 20; i += 1) sub.handle.reportOutput?.(itemId, `burst ${i}\n`);
    await vi.waitFor(() =>
      expect(events.filter((e) => e.kind === "peer-output").length).toBeGreaterThanOrEqual(8),
    );
    // Give any further frames time to arrive; the budget holds them at 8 within 500 ms.
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.filter((e) => e.kind === "peer-output")).toHaveLength(8);
  });
});
