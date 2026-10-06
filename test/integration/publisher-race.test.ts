import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BlackboardClone } from "../../src/blackboard/clone.js";
import { createGenesis } from "../../src/blackboard/genesis.js";
import { fullReplaySource, Publisher } from "../../src/blackboard/publisher.js";
import { draft, type Intent } from "../../src/core/intents.js";
import { replay } from "../../src/core/reducer/replay.js";
import type { State } from "../../src/core/reducer/state.js";
import { MAX_EVENT_BYTES } from "../../src/core/schemas/common.js";
import { parseEventFile } from "../../src/core/schemas/events.js";
import { LogReadError, readLog } from "../../src/git/log-reader.js";
import {
  GitError,
  type GitRunner,
  type GitRunOptions,
  NodeGitRunner,
} from "../../src/git/runner.js";
import { type Signer, SshKeySigner } from "../../src/git/signer.js";
import { Rng } from "../../src/sim/rng.js";
import type { Clock } from "../../src/util/clock.js";
import { generateKey, initRepo, tempDir, writeAllowedSigners } from "../helpers/git-fixture.js";
import {
  agentRegistered,
  fakeEventId,
  genesisDoc,
  MAC,
  T1,
  taskCreated,
} from "../helpers/log-builder.js";

class RecordingGit implements GitRunner {
  readonly commands: { args: string[]; input?: string | Uint8Array }[] = [];
  readonly attemptedPushes: string[] = [];
  lostAck = false;
  refusePush = false;
  failAdd = false;
  failObservationFetch = false;
  private failNextFetch = false;
  onPush?: () => Promise<void>;
  private readonly real = new NodeGitRunner();

  async run(args: string[], opts: GitRunOptions) {
    this.commands.push({ args: [...args], input: opts.input });
    if (args[0] === "add" && this.failAdd) {
      this.failAdd = false;
      throw new GitError(args, 1, "Temporary index write failure");
    }
    if (args[0] === "fetch" && this.failNextFetch) {
      this.failNextFetch = false;
      throw new GitError(args, -1, "Connection reset while observing successful push");
    }
    if (args[0] !== "push") return this.real.run(args, opts);
    this.attemptedPushes.push(args[2] ?? "");
    await this.onPush?.();
    if (this.refusePush) throw new GitError(args, 1, "Remote rejected the push");
    const result = await this.real.run(args, opts);
    if (this.failObservationFetch) {
      this.failObservationFetch = false;
      this.failNextFetch = true;
    }
    if (this.lostAck) {
      this.lostAck = false;
      throw new GitError(args, -1, "Connection reset after remote accepted push");
    }
    return result;
  }
}

class AdvancingClock implements Clock {
  readonly delays: number[] = [];
  private elapsed = 0;
  nowMs() {
    return 1_791_158_400_000 + this.elapsed;
  }
  monotonicMs() {
    return this.elapsed;
  }
  async sleep(ms: number) {
    this.delays.push(ms);
    this.elapsed += ms;
  }
}

describe("publisher on local bare remotes", () => {
  const git = new NodeGitRunner();
  const ident = { name: "Skep Test", email: "test@example.invalid", timestampSec: 0, tz: "+0000" };
  let root: string;
  let caseDir: string;
  let remote: string;
  let human: SshKeySigner;
  let mac: SshKeySigner;
  let trustPath: string;
  let allowedSignersText: string;

  beforeAll(async () => {
    root = await tempDir("publisher-race-");
    vi.stubEnv("HOME", root);
    const humanKey = await generateKey(root, "human");
    const macKey = await generateKey(root, "mac");
    human = new SshKeySigner({ principal: "human", keyPath: humanKey.privPath });
    mac = new SshKeySigner({ principal: "daemon:mac", keyPath: macKey.privPath });
    trustPath = join(root, "allowed_signers");
    await writeAllowedSigners(trustPath, [
      { principal: human.principal, pubLine: humanKey.pubLine },
      { principal: mac.principal, pubLine: macKey.pubLine },
    ]);
    allowedSignersText = await readFile(trustPath, "utf8");
  });

  beforeEach(async () => {
    caseDir = await mkdtemp(join(root, "case-"));
    remote = join(caseDir, "remote.git");
    await initRepo(remote, { bare: true });
    const clone = new BlackboardClone({ git, dir: join(caseDir, "bootstrap"), remoteUrl: remote });
    await createGenesis({
      git,
      clone,
      signer: human,
      genesis: genesisDoc(),
      allowedSignersText,
      ident,
    });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function writer(name = "mac", opts: { signer?: Signer; maxAttempts?: number } = {}) {
    const recording = new RecordingGit();
    const clone = new BlackboardClone({
      git: recording,
      dir: join(caseDir, name),
      remoteUrl: remote,
    });
    await clone.init();
    const clock = new AdvancingClock();
    const source = fullReplaySource(recording, clone.dir, trustPath);
    const publisher = new Publisher({
      git: recording,
      clone,
      signer: opts.signer ?? mac,
      clock,
      rng: new Rng(name),
      state: source,
      ident,
      maxAttempts: opts.maxAttempts,
    });
    return { recording, clone, clock, source, publisher };
  }

  function registration(actor = MAC): Intent {
    return () => draft("agent.registered", null, actor, agentRegistered(), {});
  }

  function humanTask(): Intent {
    return () =>
      draft(
        "task.created",
        T1,
        "human",
        taskCreated({ owner: MAC, repo: "https://example.invalid/code.git" }),
        {},
      );
  }

  async function entries() {
    return readLog(git, remote, trustPath);
  }

  function rendezvous(count: number) {
    let arrived = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return async () => {
      if (++arrived === count) release();
      await gate;
    };
  }

  function assertSafeCommands(recording: RecordingGit) {
    for (const { args } of recording.commands) {
      expect(args.some((arg) => ["pull", "merge", "rebase"].includes(arg))).toBe(false);
      expect(args.some((arg) => arg.startsWith("--force"))).toBe(false);
      if (args[0] === "push")
        expect(args).toEqual([
          "push",
          "origin",
          expect.stringMatching(/^[0-9a-f]+:refs\/heads\/main$/),
        ]);
    }
  }

  it("lands eight concurrent publishers exactly once with signed, linear, single-add history", async () => {
    const writers = await Promise.all(Array.from({ length: 8 }, (_, i) => writer(`mac-${i}`)));
    const gate = rendezvous(8);
    for (const instance of writers) {
      let first = true;
      instance.recording.onPush = async () => {
        if (first) {
          first = false;
          await gate();
        }
      };
    }
    const results = await Promise.all(
      writers.map((instance, i) => instance.publisher.publish(registration(`mac.coding.${i + 1}`))),
    );
    expect(results.every((result) => result.status === "accepted")).toBe(true);
    expect(new Set(results.map((result) => result.eventId)).size).toBe(8);
    expect(results.map((result) => result.seq).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const log = await entries();
    expect(log).toHaveLength(9);
    const state = replay(log);
    expect(Object.keys(state.agents)).toHaveLength(8);
    expect(Object.keys(state.seen_event_ids).sort()).toEqual(
      results.map((result) => result.eventId).sort(),
    );
    for (const [index, entry] of log.slice(1).entries()) {
      expect(entry.parents).toEqual([log[index]?.sha]);
      expect(entry.signature).toEqual({ status: "good", principal: "daemon:mac" });
      expect(entry.changes).toHaveLength(1);
      expect(entry.changes[0]?.status).toBe("A");
      const content = Object.values(entry.added)[0];
      expect(content).toBeTypeOf("string");
      if (content === null || content === undefined) throw new Error("Missing event bytes");
      const parsed = parseEventFile(content);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.event.observed_tip).toBe(entry.parents[0]);
    }
    for (const [index, instance] of writers.entries()) {
      assertSafeCommands(instance.recording);
      const commitWrites = instance.recording.commands.filter(
        ({ args }) => args.includes("commit") && args[0] === "hash-object",
      );
      expect(commitWrites.length).toBeGreaterThan(0);
      for (const write of commitWrites)
        expect(String(write.input)).toContain(results[index]?.eventId);
    }
    expect(
      writers.reduce((sum, instance) => sum + instance.recording.attemptedPushes.length, 0),
    ).toBeGreaterThan(8);
  }, 60_000);

  it("resolves a lost acknowledgement via seen_event_ids without rerunning or resigning the intent", async () => {
    const instance = await writer();
    instance.recording.lostAck = true;
    const intent = vi.fn(registration());
    const result = await instance.publisher.publish(intent);
    expect(result).toMatchObject({ status: "accepted", seq: 1 });
    expect(intent).toHaveBeenCalledTimes(1);
    expect(instance.recording.attemptedPushes).toHaveLength(1);
    expect(instance.clock.delays).toHaveLength(1);
    const log = await entries();
    expect(log).toHaveLength(2);
    expect(replay(log).seen_event_ids[result.eventId]).toBe(1);
    assertSafeCommands(instance.recording);
  });

  it("recovers a failed fetch after a successful push without creating a second commit", async () => {
    const instance = await writer();
    instance.recording.failObservationFetch = true;
    expect(await instance.publisher.publish(registration())).toMatchObject({
      status: "accepted",
      seq: 1,
    });
    expect(instance.recording.attemptedPushes).toHaveLength(1);
    expect(await entries()).toHaveLength(2);
  });

  it("recovers a landed caller-supplied event ID after restart without appending a duplicate", async () => {
    const original = await writer("mac");
    const eventId = fakeEventId(301);
    const first = await original.publisher.publish(registration(), { eventId });
    expect(first).toEqual({ status: "accepted", seq: 1, eventId });

    const restarted = await writer("vps");
    const intent = vi.fn(registration());
    expect(await restarted.publisher.publish(intent, { eventId })).toEqual(first);
    expect(intent).not.toHaveBeenCalled();
    expect(restarted.recording.attemptedPushes).toHaveLength(0);
    const log = await entries();
    expect(log).toHaveLength(2);
    expect(replay(log).outcomes.map((outcome) => outcome.outcome)).toEqual(["accepted"]);
  });

  it("fails closed on a non-GitError after push and recovers with the same event ID after restart", async () => {
    const original = await writer("mac");
    const replayTo = original.source.replayTo;
    vi.spyOn(original.source, "replayTo")
      .mockImplementationOnce(replayTo)
      .mockRejectedValueOnce(new LogReadError("Temporary observation failure"));
    const eventId = fakeEventId(302);
    expect(await original.publisher.publish(registration(), { eventId })).toEqual({
      status: "failed",
      eventId,
      reason: "Temporary observation failure",
    });
    expect(original.recording.attemptedPushes).toHaveLength(1);
    expect(original.clock.delays).toHaveLength(0);

    const restarted = await writer("vps");
    const intent = vi.fn(registration());
    expect(await restarted.publisher.publish(intent, { eventId })).toEqual({
      status: "accepted",
      seq: 1,
      eventId,
    });
    expect(intent).not.toHaveBeenCalled();
    expect(restarted.recording.attemptedPushes).toHaveLength(0);
    const log = await entries();
    expect(log).toHaveLength(2);
    expect(replay(log).outcomes.map((outcome) => outcome.outcome)).toEqual(["accepted"]);
  });

  it("discards an untracked event after a failed add so a retry can land the same event ID", async () => {
    const instance = await writer();
    instance.recording.failAdd = true;
    const result = await instance.publisher.publish(registration());
    expect(result).toMatchObject({ status: "accepted", seq: 1 });
    expect(instance.recording.commands.filter(({ args }) => args[0] === "add")).toHaveLength(2);
    expect(instance.recording.attemptedPushes).toHaveLength(1);
    expect(instance.clock.delays).toHaveLength(1);
    expect(replay(await entries()).seen_event_ids[result.eventId]).toBe(1);
  });

  it("recomputes a losing intent against the winner's state and drops it when it is no longer valid", async () => {
    const writers = await Promise.all([writer("mac"), writer("vps")]);
    const gate = rendezvous(2);
    for (const instance of writers) instance.recording.onPush = gate;
    const intents = writers.map(() =>
      vi.fn((state: State) =>
        state.agents[MAC] ? null : draft("agent.registered", null, MAC, agentRegistered(), {}),
      ),
    );
    const results = await Promise.all(
      writers.map((instance, i) => instance.publisher.publish(intents[i] ?? registration())),
    );
    expect(results.map((result) => result.status).sort()).toEqual(["accepted", "dropped"]);
    expect(intents.map((intent) => intent.mock.calls.length).sort()).toEqual([1, 2]);
    expect(await entries()).toHaveLength(2);
    for (const instance of writers) assertSafeCommands(instance.recording);
  });

  it("returns dropped for a null intent without changing main", async () => {
    const instance = await writer();
    expect(await instance.publisher.publish(() => null)).toMatchObject({ status: "dropped" });
    expect(instance.recording.attemptedPushes).toHaveLength(0);
    expect(await entries()).toHaveLength(1);
  });

  it("returns a reducer rejection and its reason, including after a lost acknowledgement", async () => {
    const instance = await writer();
    instance.recording.lostAck = true;
    const result = await instance.publisher.publish(humanTask(), { signer: human });
    expect(result).toMatchObject({ status: "rejected", reason: "unknown_agent", seq: 1 });
    const state = replay(await entries());
    expect(state.seen_event_ids[result.eventId]).toBe(1);
    expect(state.tasks[T1]).toBeUndefined();
    expect(instance.recording.attemptedPushes).toHaveLength(1);
  });

  it("reports unauthorized events exactly once after lost acknowledgements without marking them seen (D3)", async () => {
    const instance = await writer();
    instance.recording.lostAck = true;
    const result = await instance.publisher.publish(humanTask());
    expect(result).toMatchObject({ status: "rejected", reason: "unauthorized", seq: 1 });
    const log = await entries();
    expect(log).toHaveLength(2);
    expect(replay(log).seen_event_ids[result.eventId]).toBeUndefined();
    expect(instance.recording.attemptedPushes).toHaveLength(1);
  });

  it("serializes daemon and human events FIFO and uses the human override key for accepted task creation", async () => {
    const instance = await writer();
    const first = instance.publisher.publish(registration());
    const second = instance.publisher.publish(humanTask(), { signer: human });
    expect(await first).toMatchObject({ status: "accepted", seq: 1 });
    expect(await second).toMatchObject({ status: "accepted", seq: 2 });
    const log = await entries();
    expect(log[1]?.signature).toEqual({ status: "good", principal: "daemon:mac" });
    expect(log[2]?.signature).toEqual({ status: "good", principal: "human" });
    expect(replay(log).tasks[T1]?.status).toBe("planning");
    const timestamp = (
      await git.run(["show", "-s", "--format=%at", log[2]?.sha ?? "HEAD"], { cwd: remote })
    ).stdout.trim();
    expect(timestamp).toBe("1791158400");
  });

  it("exhausts the default eight push attempts with one stable event ID and leaves remote main unchanged", async () => {
    const instance = await writer();
    instance.recording.refusePush = true;
    const result = await instance.publisher.publish(registration());
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("after 8 attempts"),
    });
    expect(instance.recording.attemptedPushes).toHaveLength(8);
    expect(instance.clock.delays).toHaveLength(7);
    expect(await entries()).toHaveLength(1);
    const commitWrites = instance.recording.commands.filter(
      ({ args }) => args.includes("commit") && args[0] === "hash-object",
    );
    expect(commitWrites).toHaveLength(8);
    for (const write of commitWrites) expect(String(write.input)).toContain(result.eventId);
    assertSafeCommands(instance.recording);
  });

  it("rejects oversized serialized events before adding any file or pushing", async () => {
    const instance = await writer();
    const payload = taskCreated({
      owner: MAC,
      repo: "https://example.invalid/code.git",
      body: "\u0000".repeat(16_000),
    });
    expect(JSON.stringify(payload).length).toBeGreaterThan(MAX_EVENT_BYTES);
    const result = await instance.publisher.publish(
      () => draft("task.created", T1, "human", payload, {}),
      { signer: human },
    );
    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("exceeds 65536 bytes"),
    });
    expect(instance.recording.commands.some(({ args }) => args[0] === "add")).toBe(false);
    expect(instance.recording.attemptedPushes).toHaveLength(0);
    expect(await entries()).toHaveLength(1);
  });

  it("fullReplaySource replays the requested immutable tip without using the current branch or a cache", async () => {
    const instance = await writer();
    await instance.clone.fetch();
    const genesisSha = await instance.clone.resetToRemoteMain();
    await instance.publisher.publish(registration());
    const oldState = await instance.source.replayTo(genesisSha);
    expect(oldState.seq).toBe(0);
    expect(oldState.agents).toEqual({});
    const log = await entries();
    const newest = log.at(-1);
    if (!newest) throw new Error("Missing latest commit");
    expect(await instance.source.replayTo(newest.sha)).toEqual(replay(log));
  });
});
