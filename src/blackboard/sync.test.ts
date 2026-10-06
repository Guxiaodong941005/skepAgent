import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  commitFile,
  generateKey,
  initRepo,
  tempDir,
  writeAllowedSigners,
} from "../../test/helpers/git-fixture.js";
import {
  agentRegistered,
  fakeSha,
  genesisDoc,
  LogBuilder,
  MAC,
  T1,
  taskCreated,
} from "../../test/helpers/log-builder.js";
import { canonicalJson } from "../core/canonical.js";
import type { Sha } from "../core/ids.js";
import { draft } from "../core/intents.js";
import { GenesisError } from "../core/reducer/genesis.js";
import { replay } from "../core/reducer/replay.js";
import type { State } from "../core/reducer/state.js";
import * as logReader from "../git/log-reader.js";
import { LogReadError } from "../git/log-reader.js";
import { GitError, type GitRunner, NodeGitRunner } from "../git/runner.js";
import { SshKeySigner } from "../git/signer.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { Rng } from "../sim/rng.js";
import { FakeHintChannel } from "../transport/fake-hint.js";
import { NullHintChannel } from "../transport/null-hint.js";
import type { Hint } from "../transport/types.js";
import type { RandomSource } from "../util/random.js";
import { BlackboardClone } from "./clone.js";
import { createGenesis } from "./genesis.js";
import { fullReplaySource, Publisher, type StateSource } from "./publisher.js";
import { Sync, type SyncAlarm, SyncError, type SyncIntervals } from "./sync.js";

function hint(sha = fakeSha("hint"), ref: "main" | `hb/${string}` = "main"): Hint {
  return { v: 1, kind: "tip", topic: "test-topic", ref, sha };
}

const midpointRng: RandomSource = {
  bytes: (n) => Uint8Array.from({ length: n }, (_, i) => (i === 0 ? 128 : 0)),
};

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function unitFixture(options: { intervals?: Partial<SyncIntervals>; rng?: RandomSource } = {}) {
  const log = new LogBuilder();
  const refs = { remote: { "refs/heads/main": log.tip }, local: {} } as {
    remote: Record<string, Sha>;
    local: Record<string, Sha>;
  };
  const git: GitRunner = {
    run: vi.fn(async (args) => {
      if (args[0] === "ls-remote") {
        return {
          code: 0,
          stdout: Object.entries(refs.remote)
            .map(([ref, sha]) => `${sha}\t${ref}\n`)
            .join(""),
          stderr: "",
        };
      }
      if (args[0] === "for-each-ref") {
        return {
          code: 0,
          stdout: Object.entries(refs.local)
            .map(([ref, sha]) => `${sha}\t${ref.replace("refs/heads/", "refs/remotes/origin/")}\n`)
            .join(""),
          stderr: "",
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    }),
  };
  const clone = new BlackboardClone({
    git,
    dir: ".skep-sim/sync-unit",
    remoteUrl: "https://example.invalid/blackboard.git",
  });
  const fetch = vi.spyOn(clone, "fetch").mockImplementation(async () => {
    refs.local = { ...refs.remote };
  });
  const read = vi
    .spyOn(logReader, "readLog")
    .mockImplementation(async (_git, _dir, _trust, opts) => {
      const index = log.entries.findIndex((entry) => entry.sha === opts?.ref);
      if (index < 0) throw new LogReadError("Missing requested tip");
      const fromIndex = opts?.from
        ? log.entries.findIndex((entry) => entry.sha === opts.from?.sha)
        : -1;
      if (opts?.from && (fromIndex < 0 || fromIndex > index || opts.from.seq !== fromIndex)) {
        throw new LogReadError("Cached tip is no longer on the first-parent chain");
      }
      return log.entries.slice(fromIndex + 1, index + 1);
    });
  const vt = new VirtualTime();
  const clock = new FakeClock(vt, { wallStartMs: 1_791_158_400_000 });
  const sleep = vi.spyOn(clock, "sleep");
  const hints = new FakeHintChannel(clock);
  const deps = {
    git,
    clone,
    trustPath: ".skep-sim/allowed_signers",
    clock,
    rng: options.rng ?? midpointRng,
    hints,
    intervals: options.intervals,
  };
  const sync = new Sync(deps);
  const alarms: SyncAlarm[] = [];
  sync.onAlarm((alarm) => alarms.push(alarm));
  return { sync, deps, refs, log, fetch, read, vt, clock, sleep, hints, alarms };
}

describe("sync observations and cache", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts with explicit unknown freshness and implements StateSource without fetching", async () => {
    const { sync, log, fetch } = unitFixture();
    expect(sync.current()).toEqual({
      state: null,
      tip: null,
      seq: null,
      fetchedAtMonoMs: null,
      invalidCount: 0,
    });
    const source: StateSource = sync;
    expect(await source.replayTo(log.tip)).toEqual(replay(log.entries));
    expect(fetch).not.toHaveBeenCalled();
    expect(sync.current()).toMatchObject({ tip: log.tip, seq: 0, fetchedAtMonoMs: null });
  });

  it("replays incrementally from the cached sha and seq and reuses the same tip", async () => {
    const { sync, deps, log, read } = unitFixture();
    const first = await sync.replayTo(log.tip);
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    expect(await sync.replayTo(log.tip)).toEqual(replay(log.entries));
    expect(read).toHaveBeenLastCalledWith(deps.git, deps.clone.dir, deps.trustPath, {
      ref: log.tip,
      from: { sha: first.tip, seq: first.seq },
    });
    await sync.replayTo(log.tip);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([0, 1, 2])(
    "returns an earlier cached position at seq %s without alarms or cache changes",
    async (seq) => {
      const { sync, deps, log, read, alarms, vt } = unitFixture();
      await sync.observeNow();
      await vt.advance(123);
      log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
      log.append(
        { type: "agent.registered", actor: MAC, payload: agentRegistered() },
        {
          mutate: (entry) => {
            entry.signature = { status: "missing" };
          },
        },
      );
      log.append({
        type: "task.created",
        actor: "human",
        payload: taskCreated({ owner: MAC, repo: "https://example.com/code.git" }),
      });
      await sync.replayTo(log.tip);
      const current = sync.current();
      const previousAlarms = [...alarms];
      const updates = vi.fn();
      sync.onState(updates);
      read.mockClear();
      const entry = log.entries[seq];
      if (!entry) throw new Error("Missing historical entry");

      expect(await sync.replayTo(entry.sha)).toEqual(replay(log.entries.slice(0, seq + 1)));
      expect(read).toHaveBeenCalledExactlyOnceWith(deps.git, deps.clone.dir, deps.trustPath, {
        ref: entry.sha,
      });
      expect(alarms).toEqual(previousAlarms);
      expect(updates).not.toHaveBeenCalled();
      expect(sync.current()).toEqual(current);
      expect(sync.current().tip).toBe(log.tip);
    },
  );

  it("protects cached state from callers and independently notifies subscribers", async () => {
    const { sync, log } = unitFixture();
    const observed: State[] = [];
    const unsubscribe = sync.onState((state) => {
      state.seq = 999;
    });
    sync.onState((state) => observed.push(state));
    const first = await sync.replayTo(log.tip);
    first.seq = 888;
    const snapshot = sync.current();
    if (!snapshot.state) throw new Error("Missing state");
    snapshot.state.seq = 777;
    expect(sync.current().seq).toBe(0);
    expect(observed[0]?.seq).toBe(0);
    unsubscribe();
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    expect((await sync.replayTo(log.tip)).seq).toBe(1);
    await sync.replayTo(log.tip);
    expect(observed).toHaveLength(2);
  });

  it.each(["observeNow", "replayTo"] as const)(
    "reports a throwing state listener without failing %s",
    async (method) => {
      const { sync, log, refs, alarms, vt } = unitFixture();
      const problem = new Error("Subscriber unavailable");
      const unsubscribe = sync.onState((state) => {
        state.seq = 999;
        throw problem;
      });
      const listener = vi.fn();
      sync.onState(listener);
      const observe = () => (method === "observeNow" ? sync.observeNow() : sync.replayTo(log.tip));

      expect(await observe()).toEqual(replay(log.entries));
      expect(listener).toHaveBeenCalledExactlyOnceWith(replay(log.entries));
      expect(sync.current()).toMatchObject({ tip: log.tip, seq: 0 });
      expect(alarms).toHaveLength(1);
      expect(alarms[0]).toMatchObject({
        kind: "sync_failed",
        error: expect.any(SyncError),
      });
      if (alarms[0]?.kind !== "sync_failed") throw new Error("Missing listener alarm");
      expect(alarms[0].error.cause).toBe(problem);
      expect(alarms[0].error.message).toContain("state listener");
      if (method === "observeNow") expect(sync.current().fetchedAtMonoMs).toBe(0);

      unsubscribe();
      log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
      refs.remote["refs/heads/main"] = log.tip;
      await vt.advance(123);
      expect(await observe()).toEqual(replay(log.entries));
      expect(listener).toHaveBeenCalledTimes(2);
      expect(alarms).toHaveLength(1);
      if (method === "observeNow") expect(sync.current().fetchedAtMonoMs).toBe(123);
    },
  );

  it("alarms and retries a full replay after LogReadError without corrupting the cache", async () => {
    const { sync, deps, log, read, alarms } = unitFixture();
    await sync.replayTo(log.tip);
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    const problem = new LogReadError("Cannot extend cached history");
    read.mockRejectedValueOnce(problem);
    expect(await sync.replayTo(log.tip)).toEqual(replay(log.entries));
    expect(alarms).toEqual([{ kind: "log_read", error: problem }]);
    expect(read).toHaveBeenLastCalledWith(deps.git, deps.clone.dir, deps.trustPath, {
      ref: log.tip,
    });
  });

  it("keeps the last valid state and queue usable when both incremental and full reads fail", async () => {
    const { sync, log, read } = unitFixture();
    const previous = await sync.replayTo(log.tip);
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    read.mockRejectedValueOnce(new LogReadError("Incremental failure"));
    read.mockRejectedValueOnce(new LogReadError("Full read failure"));
    await expect(sync.replayTo(log.tip)).rejects.toThrow("Full read failure");
    expect(sync.current().state).toEqual(previous);
    expect(await sync.replayTo(log.tip)).toEqual(replay(log.entries));
  });

  it("counts and alarms on new invalid commits once while preserving rejected outcomes", async () => {
    const { sync, log, alarms } = unitFixture();
    await sync.replayTo(log.tip);
    log.append(
      { type: "agent.registered", actor: MAC, payload: agentRegistered() },
      {
        mutate: (entry) => {
          entry.signature = { status: "missing" };
        },
      },
    );
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    log.append({
      type: "task.created",
      actor: MAC,
      payload: taskCreated({ owner: MAC, repo: "https://example.com/code.git" }),
    });
    const state = await sync.replayTo(log.tip);
    expect(state.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "invalid",
      "accepted",
      "rejected",
    ]);
    expect(sync.current().invalidCount).toBe(1);
    expect(alarms).toEqual([{ kind: "invalid_commit", outcome: state.outcomes[0] }]);
    await sync.replayTo(log.tip);
    await sync.replayTo(log.entries[1]?.sha ?? "");
    expect(sync.current().invalidCount).toBe(1);
    expect(alarms.filter((alarm) => alarm.kind === "invalid_commit")).toHaveLength(1);
  });

  it("serializes concurrent replays in invocation order", async () => {
    const { sync, log, read } = unitFixture();
    const first = log.tip;
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    const second = log.tip;
    const states = await Promise.all([
      sync.replayTo(first),
      sync.replayTo(second),
      sync.replayTo(first),
    ]);
    expect(states.map((state) => state.seq)).toEqual([0, 1, 0]);
    expect(sync.current().tip).toBe(second);
    expect(read.mock.calls.map((call) => call[3]?.ref)).toEqual([first, second, first]);
  });

  it("observeNow always fetches both refs and refreshes metadata, without resetting HEAD", async () => {
    const { sync, deps, log, refs, fetch, vt } = unitFixture();
    refs.remote["refs/heads/hb/mac.coding"] = fakeSha("heartbeat");
    await sync.observeNow();
    await vt.advance(123);
    expect(await sync.observeNow()).toEqual(replay(log.entries));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(refs.local).toEqual(refs.remote);
    expect(sync.current()).toMatchObject({
      tip: log.tip,
      seq: 0,
      fetchedAtMonoMs: 123,
      invalidCount: 0,
    });
    expect(vi.mocked(deps.git.run).mock.calls.every(([args]) => args[0] === "for-each-ref")).toBe(
      true,
    );
  });

  it("does not claim fresh state after a failed fetch or invalid genesis", async () => {
    const { sync, log, fetch, vt } = unitFixture();
    await sync.observeNow();
    const previous = sync.current();
    await vt.advance(321);
    fetch.mockRejectedValueOnce(new GitError(["fetch"], -1, "Remote unavailable"));
    await expect(sync.observeNow()).rejects.toThrow(GitError);
    expect(sync.current()).toEqual(previous);
    const root = log.entries[0];
    if (!root) throw new Error("Missing genesis");
    root.sha = fakeSha("untrusted-genesis");
    root.signature = { status: "missing" };
    await expect(sync.replayTo(root.sha)).rejects.toThrow(GenesisError);
    expect(sync.current()).toEqual(previous);
  });
});

describe("clock-driven polling and untrusted hints", () => {
  const pollers: Sync[] = [];
  function setup(options?: Parameters<typeof unitFixture>[0]) {
    const fixture = unitFixture(options);
    pollers.push(fixture.sync);
    return fixture;
  }

  afterEach(async () => {
    for (const sync of pollers.splice(0)) await sync.stop();
    vi.restoreAllMocks();
  });

  it("polls immediately then uses default idle/active intervals and returns to idle on cancellation", async () => {
    const { sync, log, refs, vt, sleep } = setup();
    await sync.start();
    expect(sleep.mock.calls[0]?.[0]).toBe(90_000);
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    log.append({
      type: "task.created",
      actor: "human",
      payload: taskCreated({ owner: MAC, repo: "https://example.com/code.git" }),
    });
    refs.remote["refs/heads/main"] = log.tip;
    await vt.advance(90_000);
    expect(sync.current().state?.tasks[T1]?.status).toBe("planning");
    expect(sleep.mock.calls.at(-1)?.[0]).toBe(20_000);
    log.append({
      type: "task.cancelled",
      actor: "human",
      payload: { reason: "Stop work" },
      pre: { task_rev: 1 },
    });
    refs.remote["refs/heads/main"] = log.tip;
    await vt.advance(20_000);
    expect(sync.current().state?.tasks[T1]?.status).toBe("cancelled");
    expect(sleep.mock.calls.at(-1)?.[0]).toBe(90_000);
  });

  it.each([0, 255])(
    "jitters active and idle intervals using injected random byte %s",
    async (byte) => {
      const { sync, log, refs, vt, sleep } = setup({
        rng: { bytes: (n) => new Uint8Array(n).fill(byte) },
      });
      await sync.start();
      const idle = sleep.mock.calls[0]?.[0] ?? 0;
      expect(idle).toBeGreaterThanOrEqual(67_500);
      expect(idle).toBeLessThanOrEqual(112_500);
      log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
      log.append({
        type: "task.created",
        actor: "human",
        payload: taskCreated({ owner: MAC, repo: "https://example.com/code.git" }),
      });
      refs.remote["refs/heads/main"] = log.tip;
      await vt.advance(idle);
      const active = sleep.mock.calls.at(-1)?.[0] ?? 0;
      expect(active).toBeGreaterThanOrEqual(15_000);
      expect(active).toBeLessThanOrEqual(25_000);
      expect(active / 20_000).toBe(idle / 90_000);
    },
  );

  it("skips an unchanged fetch regardless of ref order, but fetches heartbeat updates and deletions", async () => {
    const { sync, deps, refs, log, fetch, read, vt } = setup({
      intervals: { idleMs: 30_000, activeMs: 10_000, jitter: 0 },
    });
    refs.remote["refs/heads/hb/mac.coding"] = fakeSha("beat-1");
    await sync.start();
    const updates = vi.fn();
    sync.onState(updates);
    refs.remote = { "refs/heads/hb/mac.coding": fakeSha("beat-1"), "refs/heads/main": log.tip };
    await vt.advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sync.current().fetchedAtMonoMs).toBe(30_000);
    refs.remote["refs/heads/hb/mac.coding"] = fakeSha("beat-2");
    await vt.advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    delete refs.remote["refs/heads/hb/mac.coding"];
    await vt.advance(30_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(refs.local).toEqual({ "refs/heads/main": log.tip });
    expect(read).toHaveBeenCalledTimes(1);
    expect(updates).not.toHaveBeenCalled();
    expect(vi.mocked(deps.git.run).mock.calls[0]?.[0]).toEqual([
      "ls-remote",
      "--heads",
      "origin",
      "refs/heads/main",
      "refs/heads/hb/*",
    ]);
  });

  it("caches the fetched refs when the remote moves between advertisement and fetch", async () => {
    const { sync, refs, log, fetch, vt } = setup();
    fetch.mockImplementationOnce(async () => {
      log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
      refs.remote["refs/heads/main"] = log.tip;
      refs.local = { ...refs.remote };
    });
    await sync.start();
    expect(sync.current().seq).toBe(1);
    await vt.advance(90_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("100 hints in one second cause at most one extra fetch, with another allowed after two seconds", async () => {
    const { sync, log, refs, hints, fetch, vt } = setup();
    await sync.start();
    for (let i = 0; i < 100; i++) {
      refs.remote["refs/heads/hb/mac.coding"] = fakeSha(`beat-${i}`);
      hints.emit(hint(refs.remote["refs/heads/hb/mac.coding"], "hb/mac.coding"));
      await settle();
      await vt.advance(10);
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sync.current().state).toEqual(replay(log.entries));
    await vt.advance(1_000);
    hints.emit(hint(fakeSha("unknown-sha"), "hb/mac.coding"));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sync.current().tip).toBe(log.tip);
  });

  it("forged/invalid/wake hints cannot change state or fetch arbitrary SHAs", async () => {
    const { sync, hints, deps, fetch, vt } = setup();
    await sync.start();
    const previous = sync.current().state;
    const listener = vi.fn();
    sync.onState(listener);
    const unknown = fakeSha("forged");
    hints.emit(hint(unknown));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sync.current().state).toEqual(previous);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.mocked(deps.git.run).mock.calls.some(([args]) => args.includes(unknown))).toBe(false);
    await vt.advance(2_000);
    expect(hints.emit({ ...hint(), extra: "invalid" })).toBe(false);
    hints.emit({ v: 1, kind: "wake", topic: "test-topic", device: "mac" });
    await settle();
    expect(
      vi.mocked(deps.git.run).mock.calls.filter(([args]) => args[0] === "ls-remote"),
    ).toHaveLength(2);
  });

  it("bounds cycles by their actual start and coalesces hints during a slow fetch", async () => {
    const { sync, refs, hints, fetch, vt } = setup();
    await sync.start();
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetch.mockImplementationOnce(async () => {
      await gate;
      refs.local = { ...refs.remote };
    });
    refs.remote["refs/heads/hb/mac.coding"] = fakeSha("slow-beat");
    hints.emit(hint());
    await settle();
    await vt.advance(5_000);
    for (let i = 0; i < 100; i++) hints.emit(hint());
    release();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vt.nextTimerAt()).toBe(95_000);
  });

  it("reports poll failures, preserves freshness, and retries on the next clock interval", async () => {
    const { sync, log, refs, fetch, vt, alarms } = setup();
    await sync.start();
    const previous = sync.current();
    refs.remote["refs/heads/hb/mac.coding"] = fakeSha("new-beat");
    fetch.mockRejectedValueOnce(new GitError(["fetch"], -1, "Remote unavailable"));
    await vt.advance(90_000);
    expect(sync.current()).toEqual(previous);
    expect(alarms[0]).toMatchObject({ kind: "sync_failed", error: expect.any(SyncError) });
    await vt.advance(90_000);
    expect(sync.current()).toMatchObject({ tip: log.tip, fetchedAtMonoMs: 180_000 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("supports idempotent start/stop/restart and cancels clock sleeps and hint delivery", async () => {
    const { sync, hints, fetch, vt } = setup();
    await Promise.all([sync.start(), sync.start()]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vt.nextTimerAt()).toBe(90_000);
    await Promise.all([sync.stop(), sync.stop()]);
    expect(vt.nextTimerAt()).toBeNull();
    expect(hints.health().connected).toBe(false);
    expect(hints.emit(hint())).toBe(false);
    await vt.advance(500_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await sync.start();
    expect(hints.health().connected).toBe(true);
    expect(sync.current().fetchedAtMonoMs).toBe(500_000);
    await sync.stop();
  });

  it("polls with NullHintChannel by default and survives an unavailable optional hint channel", async () => {
    const { deps, fetch, alarms, sync } = setup();
    vi.spyOn(deps.hints, "start").mockRejectedValueOnce(new Error("Relay unavailable"));
    await sync.start();
    expect(alarms[0]).toMatchObject({ kind: "hint_failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await sync.stop();
    const start = vi.spyOn(NullHintChannel.prototype, "start");
    const defaultSync = new Sync({ ...deps, hints: undefined });
    pollers.push(defaultSync);
    await defaultSync.start();
    expect(start).toHaveBeenCalledOnce();
    expect(defaultSync.current().seq).toBe(0);
  });

  it("rejects unsafe intervals and malformed remote ref output without updating state", async () => {
    const { sync, deps } = setup();
    for (const intervals of [
      { activeMs: 0 },
      { idleMs: Number.POSITIVE_INFINITY },
      { activeMs: 100_000 },
      { jitter: -0.1 },
      { jitter: 1 },
      { minHintGapMs: 1_999 },
    ])
      expect(() => new Sync({ ...deps, intervals })).toThrow(SyncError);
    for (const stdout of [
      "bad-ref\n",
      `${fakeSha()}\trefs/heads/unexpected\n`,
      "",
      `${fakeSha()}\trefs/heads/main\n${fakeSha()}\trefs/heads/main\n`,
    ]) {
      vi.mocked(deps.git.run).mockResolvedValueOnce({ code: 0, stdout, stderr: "" });
      await sync.start();
      expect(sync.current().state).toBeNull();
      await sync.stop();
    }
  });
});

describe("sync against a signed temporary blackboard", () => {
  const git = new NodeGitRunner();
  const ident = {
    name: "Skep Test",
    email: "test@example.invalid",
    timestampSec: 1_791_158_400,
    tz: "+0000",
  };
  let root: string;
  let caseDir: string;
  let remote: string;
  let trustPath: string;
  let human: SshKeySigner;
  let mac: SshKeySigner;
  let writerClone: BlackboardClone;
  let sync: Sync;
  let readerClone: BlackboardClone;
  let publisher: Publisher;
  let vt: VirtualTime;
  let fetch: MockInstance<BlackboardClone["fetch"]>;

  beforeAll(async () => {
    root = await tempDir("blackboard-sync-");
    vi.stubEnv("HOME", root);
    const humanKey = await generateKey(root, "human");
    const macKey = await generateKey(root, "mac");
    human = new SshKeySigner({ principal: "human", keyPath: humanKey.privPath });
    mac = new SshKeySigner({ principal: "daemon:mac", keyPath: macKey.privPath });
    trustPath = join(root, "allowed_signers");
    await writeAllowedSigners(trustPath, [
      { principal: "human", pubLine: humanKey.pubLine },
      { principal: "daemon:mac", pubLine: macKey.pubLine },
    ]);
  });

  beforeEach(async () => {
    caseDir = await mkdtemp(join(root, "case-"));
    remote = join(caseDir, "remote.git");
    await initRepo(remote, { bare: true });
    writerClone = new BlackboardClone({ git, dir: join(caseDir, "writer"), remoteUrl: remote });
    await createGenesis({
      git,
      clone: writerClone,
      signer: human,
      genesis: genesisDoc(),
      allowedSignersText: await readFile(trustPath, "utf8"),
      ident,
    });
    readerClone = new BlackboardClone({ git, dir: join(caseDir, "reader"), remoteUrl: remote });
    await readerClone.init();
    vt = new VirtualTime();
    const clock = new FakeClock(vt, { wallStartMs: 1_791_158_400_000 });
    sync = new Sync({
      git,
      clone: readerClone,
      trustPath,
      clock,
      rng: new Rng("sync-integration"),
      intervals: { jitter: 0 },
    });
    fetch = vi.spyOn(readerClone, "fetch");
    publisher = new Publisher({
      git,
      clone: writerClone,
      signer: mac,
      clock,
      rng: new Rng("publisher"),
      state: fullReplaySource(git, writerClone.dir, trustPath),
      ident,
    });
  });

  afterEach(async () => {
    await sync.stop();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function register() {
    expect(
      await publisher.publish(() => draft("agent.registered", null, MAC, agentRegistered(), {})),
    ).toMatchObject({ status: "accepted" });
  }

  it("incremental replay equals full replay for accepted, rejected, invalid and duplicate commits", async () => {
    const read = vi.spyOn(logReader, "readLog");
    const initial = await sync.observeNow();
    await register();
    let state = await sync.observeNow();
    expect(
      read.mock.calls.some((call) => call[3]?.from?.sha === initial.tip && call[3].from.seq === 0),
    ).toBe(true);
    expect(
      await publisher.publish(
        () =>
          draft(
            "task.created",
            T1,
            "human",
            taskCreated({ owner: MAC, repo: "https://example.com/code.git" }),
            {},
          ),
        { signer: human },
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await publisher.publish(
        (current) =>
          draft(
            "task.cancelled",
            T1,
            "human",
            { reason: "Stale revision" },
            { task_rev: current.tasks[T1]?.rev === 1 ? 99 : 0 },
          ),
        { signer: human },
      ),
    ).toMatchObject({ status: "rejected", reason: "pre_mismatch" });
    state = await sync.observeNow();
    const invalidSha = await commitFile(git, writerClone.dir, "unexpected.txt", "Unsigned entry\n");
    await git.run(["push", "origin", `${invalidSha}:refs/heads/main`], { cwd: writerClone.dir });
    state = await sync.observeNow();
    expect(sync.current().invalidCount).toBe(1);
    const entries = await logReader.readLog(git, readerClone.dir, trustPath, { ref: state.tip });
    expect(canonicalJson(state)).toBe(canonicalJson(replay(entries)));
    expect(state.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "accepted",
      "accepted",
      "rejected",
      "invalid",
    ]);
    const eventEntry = entries[1];
    const eventPath = eventEntry?.changes[0]?.path;
    const content = eventPath ? eventEntry?.added[eventPath] : null;
    if (!eventPath || !content) throw new Error("Missing registration event");
    await git.run(["rm", "--", eventPath], { cwd: writerClone.dir });
    const deletion = await commitFile(
      git,
      writerClone.dir,
      "deletion.txt",
      "Remove event for duplicate test\n",
      mac,
    );
    const duplicate = await commitFile(git, writerClone.dir, eventPath, content, mac);
    await git.run(["push", "origin", `${duplicate}:refs/heads/main`], { cwd: writerClone.dir });
    state = await sync.observeNow();
    expect(state.outcomes.find((outcome) => outcome.sha === deletion)?.outcome).toBe("invalid");
    expect(state.outcomes.at(-1)?.outcome).toBe("duplicate");
    expect(state).toEqual(
      await fullReplaySource(git, readerClone.dir, trustPath).replayTo(state.tip),
    );
  });

  it("returns an ancestor snapshot after a newer poll without raising a rewrite alarm", async () => {
    const alarms: SyncAlarm[] = [];
    sync.onAlarm((alarm) => alarms.push(alarm));
    const initial = await sync.observeNow();
    await register();
    const older = await sync.observeNow();
    expect(
      await publisher.publish(
        () => draft("task.created", T1, "human", taskCreated({ owner: MAC }), {}),
        { signer: human },
      ),
    ).toMatchObject({ status: "accepted" });
    const newer = await sync.observeNow();

    await sync.replayTo(newer.tip);
    expect(await sync.replayTo(older.tip)).toEqual(older);
    expect(await sync.replayTo(initial.tip)).toEqual(initial);
    expect(sync.current().state).toEqual(newer);
    expect(alarms).toEqual([]);
  });

  it("alarms and fully rebuilds after remote history rewrites and rollback to genesis", async () => {
    const alarms: SyncAlarm[] = [];
    sync.onAlarm((alarm) => alarms.push(alarm));
    const initial = await sync.observeNow();
    await register();
    const old = await sync.observeNow();
    await git.run(["reset", "--hard", initial.tip], { cwd: writerClone.dir });
    const alternative = await commitFile(
      git,
      writerClone.dir,
      "other.txt",
      "Rewritten unsigned branch\n",
    );
    await git.run(["push", "--force", "origin", `${alternative}:refs/heads/main`], {
      cwd: writerClone.dir,
    });
    const rebuilt = await sync.observeNow();
    expect(rebuilt.tip).not.toBe(old.tip);
    expect(rebuilt.agents).toEqual({});
    expect(rebuilt).toEqual(
      await fullReplaySource(git, readerClone.dir, trustPath).replayTo(alternative),
    );
    expect(alarms.map((alarm) => alarm.kind)).toEqual(["log_read", "invalid_commit"]);
    await git.run(["push", "--force", "origin", `${initial.tip}:refs/heads/main`], {
      cwd: writerClone.dir,
    });
    expect(await sync.observeNow()).toEqual(initial);
    expect(sync.current().invalidCount).toBe(0);
    expect(alarms.filter((alarm) => alarm.kind === "log_read")).toHaveLength(2);
  });

  it("fetches and prunes real heartbeat refs and skips idle fetches when refs are unchanged", async () => {
    const tip = (await sync.observeNow()).tip;
    await git.run(["push", "origin", `${tip}:refs/heads/hb/mac.coding`], { cwd: writerClone.dir });
    await sync.start();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      (
        await git.run(["rev-parse", "refs/remotes/origin/hb/mac.coding"], { cwd: readerClone.dir })
      ).stdout.trim(),
    ).toBe(tip);
    await vt.advance(90_000);
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    await git.run(["push", "origin", ":refs/heads/hb/mac.coding"], { cwd: writerClone.dir });
    await sync.observeNow();
    expect(
      (
        await git.run(["show-ref", "--verify", "refs/remotes/origin/hb/mac.coding"], {
          cwd: readerClone.dir,
          allowFailure: true,
        })
      ).code,
    ).not.toBe(0);
    expect(sync.current()).toMatchObject({ tip, seq: 0, fetchedAtMonoMs: 90_000 });
  });

  it("is usable directly as the publisher's incremental StateSource", async () => {
    const clock = new FakeClock(vt, { wallStartMs: 1_791_158_400_000 });
    const localPublisher = new Publisher({
      git,
      clone: readerClone,
      signer: mac,
      clock,
      rng: new Rng("local"),
      state: sync,
      ident,
    });
    expect(
      await localPublisher.publish(() =>
        draft("agent.registered", null, MAC, agentRegistered(), {}),
      ),
    ).toMatchObject({ status: "accepted", seq: 1 });
    const state = await sync.observeNow();
    expect(state.agents[MAC]?.device).toBe("mac");
    expect(state).toEqual(
      await fullReplaySource(git, readerClone.dir, trustPath).replayTo(state.tip),
    );
  });
});
