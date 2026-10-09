import { describe, expect, it, vi } from "vitest";
import {
  agentRegistered,
  fakeEventId,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { SyncError } from "../blackboard/sync.js";
import { claimIntent, deliverIntent, finalizeEvent, revokeIntent } from "../core/intents.js";
import { applyEntry, replay } from "../core/reducer/replay.js";
import type { State } from "../core/reducer/state.js";
import { leasesHeldBy } from "../core/reducer/views.js";
import { type LeaseIdentity, reverify } from "./reverify.js";

const lease: LeaseIdentity = { task_id: T1, item: "W1", epoch: 1, holder: VPS };

function holding(): { builder: LogBuilder; state: State } {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  const repo = "https://example.invalid/code.git";
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
  let state = replay(builder.entries);
  const claim = claimIntent({ task_id: T1, item: "W1", actor: VPS, attempt_id: "att_test" })(state);
  if (!claim) throw new Error("Missing claim draft");
  state = applyEntry(
    state,
    builder.appendRaw(
      finalizeEvent(claim, {
        event_id: fakeEventId(),
        observed_tip: builder.tip,
        created_at: "2026-10-05T00:00:00Z",
      }),
    ),
  );
  expect(state.outcomes.every((outcome) => outcome.outcome === "accepted")).toBe(true);
  return { builder, state };
}

describe("fresh lease re-verification", () => {
  it("forces a new observation on each call and accepts a matching unflagged holder", async () => {
    const { state } = holding();
    const observer = {
      observeNow: vi.fn(async () => state),
      current: vi.fn(() => {
        throw new Error("Delivery must not read the polling cache");
      }),
    };
    const held = leasesHeldBy(state, VPS)[0];
    if (!held) throw new Error("Missing held lease view");
    expect(await reverify(observer, { ...held, holder: VPS })).toBe("ok");
    expect(await reverify(observer, lease)).toBe("ok");
    expect(observer.observeNow).toHaveBeenCalledTimes(2);
    expect(observer.current).not.toHaveBeenCalled();
  });

  it.each(["task", "item", "lease", "holder", "epoch", "interrupt", "status"])(
    "returns stale after a fresh observation changes %s",
    async (change) => {
      const { state } = holding();
      const task = state.tasks[T1];
      const item = task?.items.W1;
      if (!task || !item?.lease) throw new Error("Missing fixture lease");
      if (change === "task") delete state.tasks[T1];
      if (change === "item") delete task.items.W1;
      if (change === "lease") item.lease = null;
      if (change === "holder" && item.lease) item.lease.holder = MAC;
      if (change === "epoch" && item.lease) item.lease.epoch = 2;
      if (change === "interrupt" && item.lease) item.lease.interrupt = "B10";
      if (change === "status") task.status = "interrupting";
      const observeNow = vi.fn(async () => state);
      expect(await reverify({ observeNow }, lease)).toBe("stale");
      expect(observeNow).toHaveBeenCalledOnce();
    },
  );

  it("observes a revoke instead of a cached lease and prevents delivery between checks", async () => {
    const { builder, state } = holding();
    const eventDraft = revokeIntent({
      task_id: T1,
      item: "W1",
      epoch: 1,
      reason: "Holder is stale",
    })(state);
    if (!eventDraft) throw new Error("Missing revoke draft");
    const fresh = applyEntry(
      state,
      builder.appendRaw(
        finalizeEvent(eventDraft, {
          event_id: fakeEventId(),
          observed_tip: builder.tip,
          created_at: "2026-10-05T00:00:00Z",
        }),
      ),
    );
    expect(await reverify({ observeNow: async () => state }, lease)).toBe("ok");
    expect(await reverify({ observeNow: async () => fresh }, lease)).toBe("stale");
    const deliver = deliverIntent({
      task_id: T1,
      item: "W1",
      epoch: 1,
      actor: VPS,
      head_sha: state.tip,
      submit: {
        method: "pr",
        state: "opened",
        pr_url: "https://example.invalid/pull/1",
        pr_number: 1,
      },
      check_runs: [],
    });
    expect(deliver(state)).not.toBeNull();
    expect(deliver(fresh)).toBeNull();
  });

  it("fails closed when fresh observation fails and preserves the actionable error", async () => {
    const error = new SyncError("Could not fetch the blackboard; retry before delivery");
    const observer = { observeNow: vi.fn().mockRejectedValue(error) };
    await expect(reverify(observer, lease)).rejects.toBe(error);
  });

  it("pins the attempted identity while observation is in flight", async () => {
    const { state } = holding();
    const attempted = { ...lease, epoch: 2 };
    let finish: (state: State) => void = () => {
      throw new Error("Observation has not started");
    };
    const pending = reverify(
      {
        observeNow: () =>
          new Promise<State>((resolve) => {
            finish = resolve;
          }),
      },
      attempted,
    );
    attempted.epoch = 1;
    finish(state);
    expect(await pending).toBe("stale");
  });
});
