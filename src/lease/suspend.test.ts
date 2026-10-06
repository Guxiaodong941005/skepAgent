import { describe, expect, it, vi } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { LivenessTracker } from "../blackboard/liveness.js";
import { SyncError } from "../blackboard/sync.js";
import { workBranch } from "../core/ids.js";
import { replay } from "../core/reducer/replay.js";
import type { State } from "../core/reducer/state.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import type { LeaseIdentity } from "./reverify.js";
import { SuspendDetector, SuspendError } from "./suspend.js";

const POLL = 20_000;
const held: LeaseIdentity = { task_id: T1, item: "W1", epoch: 1, holder: VPS };

function fixture(skewMs = 0) {
  const time = new VirtualTime();
  const clock = new FakeClock(time, { skewMs });
  const detector = new SuspendDetector(clock, POLL);
  detector.setHeldLeases([held]);
  return { time, clock, detector };
}

function leaseState(): State {
  const builder = new LogBuilder();
  const repo = "https://example.invalid/code.git";
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "task.created", actor: "human", payload: taskCreated({ repo }) });
  const plan = samplePlan();
  plan.base.repo = repo;
  const proposal = planProposed(plan);
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append({
    type: "plan.approved",
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposal.plan_hash },
    pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  builder.append({
    type: "lease.claimed",
    actor: VPS,
    payload: { item: "W1", attempt_id: "att_test", branch: workBranch(T1, "W1", 1) },
    pre: {
      task_rev: 3,
      plan_version: 1,
      plan_hash: proposal.plan_hash,
      item: "W1",
      expected_epoch: 0,
    },
  });
  const state = replay(builder.entries);
  expect(state.outcomes.every((entry) => entry.outcome === "accepted")).toBe(true);
  return state;
}

describe("suspend detection", () => {
  it("marks every held lease unverified and pauses invocations after a suspend gap", async () => {
    const { time, clock, detector } = fixture();
    const second = { ...held, item: "W2" };
    detector.setHeldLeases([held, second]);
    const listener = vi.fn();
    detector.onSuspend(listener);
    expect(detector.paused).toBe(false);
    expect(detector.isVerified(held)).toBe(true);
    await time.advance(POLL);
    expect(detector.tick()).toBe(false);
    clock.suspend();
    await time.advance(3 * POLL);
    clock.resume();
    expect(detector.tick()).toBe(true);
    expect(detector.paused).toBe(true);
    expect(detector.isVerified(held)).toBe(false);
    expect(detector.isVerified(second)).toBe(false);
    expect(listener).toHaveBeenCalledWith({
      reason: "gap",
      gapMs: 3 * POLL,
      leases: [held, second],
    });
    expect(detector.tick()).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
  });

  it.each([-3_600_000, 3_600_000])("ignores constant wall-clock skew %s", async (skew) => {
    const { time, detector } = fixture(skew);
    const listener = vi.fn();
    detector.onSuspend(listener);
    for (const elapsed of [POLL, 3 * POLL, 3_600_000]) {
      await time.advance(elapsed);
      expect(detector.tick()).toBe(false);
    }
    expect(detector.paused).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it.each([2 * POLL - 1, 2 * POLL, 2 * POLL + 1])(
    "uses the strict threshold at gap %s",
    async (gap) => {
      const { time, clock, detector } = fixture();
      clock.suspend();
      await time.advance(gap);
      clock.resume();
      expect(detector.tick()).toBe(gap > 2 * POLL);
      expect(detector.paused).toBe(gap > 2 * POLL);
    },
  );

  it("rebases each sample after backwards wall adjustment and allows bounded drift", async () => {
    const { time, clock, detector } = fixture();
    clock.setSkew(-POLL);
    expect(detector.tick()).toBe(false);
    await time.advance(POLL);
    expect(detector.tick()).toBe(false);
    clock.setSkew(0);
    expect(detector.tick()).toBe(false);
    expect(detector.paused).toBe(false);
  });

  it("handles explicit wake notifications and listener unsubscription", () => {
    const { detector } = fixture();
    const listener = vi.fn();
    const unsubscribe = detector.onSuspend(listener);
    detector.notifyWake();
    expect(detector.paused).toBe(true);
    expect(detector.isVerified(held)).toBe(false);
    expect(listener).toHaveBeenCalledWith({ reason: "wake", gapMs: 0, leases: [held] });
    unsubscribe();
    detector.notifyWake();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("wires suspend notification to LivenessTracker.resetAll (F16)", async () => {
    const { time, clock, detector } = fixture();
    const tracker = new LivenessTracker(clock);
    const hb = {
      schema: "skep.hb/v1" as const,
      agent: VPS,
      boot_id: "b_abcd",
      n: 1,
      state: "running" as const,
      task_id: T1,
      item: "W1",
      epoch: 1,
      observed_main: "a".repeat(40),
      runtime: "native" as const,
      sent_at: "2026-10-05T00:00:00Z",
    };
    tracker.observe(VPS, "b".repeat(40), hb);
    tracker.observe(VPS, "b".repeat(40), hb);
    expect(tracker.classify(VPS).cls).toBe("live");
    detector.onSuspend(() => tracker.resetAll());
    clock.suspend();
    await time.advance(3_600_000);
    clock.resume();
    detector.tick();
    expect(tracker.classify(VPS)).toEqual({ cls: "unknown", sinceChangeMs: 0 });
  });

  it("remains paused until a fresh verification succeeds for all held leases", async () => {
    const { detector } = fixture();
    const state = leaseState();
    const observeNow = vi.fn(async () => state);
    detector.notifyWake();
    const second = { ...held, epoch: 2 };
    detector.setHeldLeases([held, second]);
    expect(await detector.verifyHeld({ observeNow })).toBe(false);
    expect(detector.paused).toBe(true);
    expect(detector.isVerified(held)).toBe(false);
    detector.setHeldLeases([held]);
    expect(detector.paused).toBe(true);
    expect(await detector.verifyHeld({ observeNow })).toBe(true);
    expect(detector.paused).toBe(false);
    expect(detector.isVerified(held)).toBe(true);
    expect(detector.isVerified(second)).toBe(false);
    expect(observeNow).toHaveBeenCalledTimes(2);
  });

  it("fails closed on fetch failure", async () => {
    const { detector } = fixture();
    detector.notifyWake();
    const error = new SyncError("Blackboard fetch failed; retry verification before invocation");
    await expect(
      detector.verifyHeld({ observeNow: vi.fn().mockRejectedValue(error) }),
    ).rejects.toBe(error);
    expect(detector.paused).toBe(true);
    expect(detector.isVerified(held)).toBe(false);
  });

  it("pauses a previously verified holder if a fresh observation finds it stale", async () => {
    const { detector } = fixture();
    const state = replay(new LogBuilder().entries);
    expect(detector.isVerified(held)).toBe(true);
    expect(await detector.verifyHeld({ observeNow: async () => state })).toBe(false);
    expect(detector.paused).toBe(true);
    expect(detector.isVerified(held)).toBe(false);
  });

  it("keeps an older observation from unpausing a newer verification", async () => {
    const { detector } = fixture();
    detector.notifyWake();
    let finish: (state: State) => void = () => {
      throw new Error("Observation has not started");
    };
    const older = detector.verifyHeld({
      observeNow: () =>
        new Promise<State>((resolve) => {
          finish = resolve;
        }),
    });
    const error = new SyncError("Fresh observation failed; keep invocations paused");
    const newer = detector.verifyHeld({ observeNow: vi.fn().mockRejectedValue(error) });
    await expect(newer).rejects.toBe(error);
    finish(leaseState());
    expect(await older).toBe(false);
    expect(detector.paused).toBe(true);
    expect(detector.isVerified(held)).toBe(false);
  });

  it.each(["wake", "leases"])(
    "does not unpause when %s changes during verification",
    async (change) => {
      const { detector } = fixture();
      detector.notifyWake();
      let finish: (state: State) => void = () => {
        throw new Error("Observation has not started");
      };
      const verifying = detector.verifyHeld({
        observeNow: () =>
          new Promise<State>((resolve) => {
            finish = resolve;
          }),
      });
      if (change === "wake") detector.notifyWake();
      else detector.setHeldLeases([{ ...held, epoch: 2 }]);
      finish(leaseState());
      expect(await verifying).toBe(false);
      expect(detector.paused).toBe(true);
    },
  );

  it("accepts an unchanged lease set during verification and isolates listener mutation", async () => {
    const { detector } = fixture();
    detector.onSuspend((event) => {
      if (event.leases[0]) event.leases[0].epoch = 9;
    });
    const listener = vi.fn();
    detector.onSuspend(listener);
    detector.notifyWake();
    expect(listener.mock.calls[0]?.[0].leases).toEqual([held]);
    let finish: (state: State) => void = () => {
      throw new Error("Observation has not started");
    };
    const verifying = detector.verifyHeld({
      observeNow: () =>
        new Promise<State>((resolve) => {
          finish = resolve;
        }),
    });
    detector.setHeldLeases([{ ...held }]);
    finish(leaseState());
    expect(await verifying).toBe(true);
    expect(detector.isVerified(held)).toBe(true);
  });

  it("requires fresh observation even after stale attempts are removed or wake occurred idle", async () => {
    const { detector } = fixture();
    detector.notifyWake();
    detector.setHeldLeases([]);
    expect(detector.paused).toBe(true);
    const observeNow = vi.fn(async () => replay(new LogBuilder().entries));
    expect(await detector.verifyHeld({ observeNow })).toBe(true);
    detector.notifyWake();
    expect(detector.paused).toBe(true);
    expect(await detector.verifyHeld({ observeNow })).toBe(true);
    expect(observeNow).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid polling interval %s",
    (pollMs) => {
      expect(() => new SuspendDetector(new FakeClock(new VirtualTime()), pollMs)).toThrow(
        SuspendError,
      );
    },
  );
});
