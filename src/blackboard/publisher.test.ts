import { describe, expect, it, vi } from "vitest";
import { agentRegistered, fakeSha, LogBuilder, MAC } from "../../test/helpers/log-builder.js";
import { draft } from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import { GitError, type GitRunner } from "../git/runner.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { Rng } from "../sim/rng.js";
import { newEventId } from "../util/random.js";
import { BlackboardClone } from "./clone.js";
import { PublishError, Publisher } from "./publisher.js";

function setup(maxAttempts?: number) {
  const git: GitRunner = {
    run: vi.fn(async () => {
      throw new Error("Unexpected git command");
    }),
  };
  const clone = new BlackboardClone({
    git,
    dir: ".skep-sim/unused",
    remoteUrl: "https://example.invalid/blackboard.git",
  });
  const log = new LogBuilder();
  const state = replay(log.entries);
  const fetch = vi.spyOn(clone, "fetch").mockResolvedValue();
  const reset = vi.spyOn(clone, "resetToRemoteMain").mockResolvedValue(state.tip);
  const vt = new VirtualTime();
  const clock = new FakeClock(vt, { wallStartMs: 1_791_158_400_000 });
  const sleep = vi.spyOn(clock, "sleep");
  const source = { replayTo: vi.fn(async () => state) };
  const deps = {
    git,
    clone,
    clock,
    state: source,
    rng: new Rng("publisher-unit"),
    signer: { principal: "daemon:mac", sign: vi.fn(async () => "unused") },
    ident: { name: "Skep Test", email: "test@example.invalid", timestampSec: 0, tz: "+0000" },
    maxAttempts,
  };
  return { publisher: new Publisher(deps), deps, source, fetch, reset, vt, sleep, log };
}

describe("publisher retry and state boundaries", () => {
  it("drops a null intent without signing or writing anything", async () => {
    const { publisher, deps, source } = setup();
    const intent = vi.fn(() => null);
    const result = await publisher.publish(intent);
    expect(result.status).toBe("dropped");
    expect(intent).toHaveBeenCalledWith(await source.replayTo());
    expect(deps.signer.sign).not.toHaveBeenCalled();
    expect(deps.git.run).not.toHaveBeenCalled();
  });

  it("resolves an already seen ID before evaluating the intent", async () => {
    const { publisher, source, reset, log } = setup();
    const eventId = newEventId(new Rng("publisher-unit"));
    log.append({
      type: "agent.registered",
      actor: MAC,
      payload: agentRegistered(),
      event_id: eventId,
    });
    const state = replay(log.entries);
    source.replayTo.mockResolvedValue(state);
    reset.mockResolvedValue(state.tip);
    const intent = vi.fn(() => null);
    expect(await publisher.publish(intent)).toEqual({ status: "accepted", eventId, seq: 1 });
    expect(intent).not.toHaveBeenCalled();
  });

  it("uses the injected clock and jittered backoff for all eight attempts, then fails closed", async () => {
    const { publisher, fetch, sleep, vt } = setup();
    fetch.mockRejectedValue(new GitError(["fetch", "origin"], -1, "Remote unavailable"));
    const intent = vi.fn(() => null);
    const pending = publisher.publish(intent);
    for (let turn = 0; turn < 100; turn++) {
      await Promise.resolve();
      await vt.runNext();
      if (fetch.mock.calls.length === 8) break;
    }
    expect(await pending).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("after 8 attempts"),
    });
    expect(fetch).toHaveBeenCalledTimes(8);
    expect(intent).not.toHaveBeenCalled();
    const delays = sleep.mock.calls.map(([ms]) => ms);
    expect(delays).toHaveLength(7);
    for (const [index, ms] of delays.entries()) {
      const base = Math.min(30_000, 500 * 2 ** index);
      expect(ms).toBeGreaterThanOrEqual(base * 0.75);
      expect(ms).toBeLessThanOrEqual(Math.min(30_000, base * 1.25));
    }
  });

  it("serializes intents FIFO and recovers the queue after a callback failure", async () => {
    const { publisher } = setup();
    const order: string[] = [];
    const first = publisher.publish(() => {
      order.push("first");
      throw new PublishError("Invalid local action");
    });
    const second = publisher.publish(() => {
      order.push("second");
      return null;
    });
    expect(await first).toMatchObject({ status: "failed", reason: "Invalid local action" });
    expect(await second).toMatchObject({ status: "dropped" });
    expect(order).toEqual(["first", "second"]);
  });

  it("fails without publication for invalid drafts and inconsistent replay tips", async () => {
    const { publisher, source, deps } = setup();
    const invalid = draft(
      "task.cancelled",
      "T-20261005-7f3a",
      "human",
      { reason: "Stop work" },
      {},
    );
    expect(await publisher.publish(() => invalid)).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("missing required pre"),
    });
    source.replayTo.mockResolvedValue({
      ...replay(new LogBuilder().entries),
      tip: fakeSha("wrong-tip"),
    });
    const intent = vi.fn(() => null);
    expect(await publisher.publish(intent)).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("did not replay requested tip"),
    });
    expect(intent).not.toHaveBeenCalled();
    expect(deps.git.run).not.toHaveBeenCalled();
  });

  it("rejects invalid attempt limits", () => {
    const { deps } = setup();
    for (const maxAttempts of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new Publisher({ ...deps, maxAttempts })).toThrow(PublishError);
    }
  });
});
