import { describe, expect, it } from "vitest";
import type { EventSpec } from "../../../test/helpers/log-builder.js";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../../test/helpers/log-builder.js";
import type { Principal } from "../principal.js";
import type { EventType, SkepEvent } from "../schemas/events.js";
import { authorize } from "./authz.js";
import { replay } from "./replay.js";

function reviewing() {
  const builder = new LogBuilder();
  builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  builder.append({ type: "task.created", actor: "human", payload: taskCreated({ mode: "team" }) });
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: planProposed(samplePlan({ mode: "team" }), [MAC]),
    pre: { task_rev: 1, owner_gen: 1 },
  });
  return builder;
}

function envelope(type: EventType, actor: string): SkepEvent {
  // Authorization depends only on the envelope, not on type-specific payload validation.
  return {
    ...new LogBuilder().event({ type: "agent.registered", actor, payload: agentRegistered() }),
    type,
    task_id: type === "agent.registered" ? null : T1,
  } as SkepEvent;
}

describe("authorization matrix (ARCHITECTURE §5.4)", () => {
  const matrix: [EventType, boolean, boolean, boolean][] = [
    ["agent.registered", false, true, true],
    ["task.created", true, false, false],
    ["task.cancelled", true, false, false],
    ["owner.transferred", true, false, false],
    ["human.decided", true, false, false],
    ["plan.proposed", false, true, false],
    ["plan.locked", false, true, false],
    ["plan.approved", true, false, false],
    ["plan.rejected", true, false, false],
    ["review.submitted", true, false, true],
    ["lease.claimed", false, true, true],
    ["lease.released", false, true, true],
    ["lease.revoked", true, false, false],
    ["checkpoint.recorded", false, true, true],
    ["work.delivered", false, true, true],
    ["work.failed", false, true, true],
    ["replan.requested", true, true, false],
    ["barrier.closed", true, true, false],
    ["item.merged", true, true, true],
    ["task.verified", false, true, false],
  ];
  it.each(matrix)(
    "enforces the human/owner/peer permissions for %s",
    (type, human, owner, peer) => {
      const state = replay(reviewing().entries);
      expect(authorize({ kind: "human" }, envelope(type, "human"), state)).toBe(human);
      expect(authorize({ kind: "daemon", device: "vps" }, envelope(type, VPS), state)).toBe(
        owner,
      );
      expect(authorize({ kind: "daemon", device: "mac" }, envelope(type, MAC), state)).toBe(peer);
    },
  );

  it.each([
    [{ kind: "daemon", device: "vps" }, "human"],
    [{ kind: "daemon", device: "vps" }, MAC],
    [{ kind: "human" }, VPS],
  ] satisfies [Principal, string][])(
    "binds principal %j to actor %s before type permissions",
    (principal, actor) => {
      expect(
        authorize(principal, envelope("item.merged", actor), replay(reviewing().entries)),
      ).toBe(false);
    },
  );

  it("permits a holder to request replan and denies a non-holder", () => {
    const state = replay(reviewing().entries);
    const task = state.tasks[T1];
    if (!task) throw new Error("fixture task missing");
    task.items.W1 = {
      id: "W1",
      title: "Work",
      assignee: MAC,
      depends_on: [],
      requires: [],
      status: "leased",
      lease: {
        epoch: 1,
        holder: MAC,
        attempt_id: "att_test",
        branch: "branch",
        plan_version: 1,
        plan_hash: "hash",
        granted_at_seq: 5,
        interrupt: null,
      },
      delivered: null,
      merged: null,
      failure: null,
      last_checkpoint: null,
      attempts_this_plan: 1,
    };
    expect(
      authorize({ kind: "daemon", device: "mac" }, envelope("replan.requested", MAC), state),
    ).toBe(true);
    expect(
      authorize(
        { kind: "daemon", device: "mac" },
        envelope("replan.requested", "mac.coding.2"),
        state,
      ),
    ).toBe(false);
    task.items.W1.lease = null;
    expect(
      authorize({ kind: "daemon", device: "mac" }, envelope("replan.requested", MAC), state),
    ).toBe(false);
  });

  it.each([
    "plan.proposed",
    "plan.locked",
    "task.verified",
    "barrier.closed",
    "review.submitted",
    "replan.requested",
  ] satisfies EventType[])("defers unknown-task checks for %s to preconditions", (type) => {
    const state = replay(new LogBuilder().entries);
    expect(authorize({ kind: "daemon", device: "mac" }, envelope(type, MAC), state)).toBe(true);
  });

  type Spec = EventSpec<EventType>;
  const unauthorized: [string, Spec, string?][] = [
    ["daemon creation", { type: "task.created", actor: VPS, payload: taskCreated() }],
    [
      "daemon cancellation",
      { type: "task.cancelled", actor: VPS, payload: { reason: "Cancel" }, pre: { task_rev: 2 } },
    ],
    [
      "daemon approval",
      {
        type: "plan.approved",
        actor: VPS,
        payload: {
          plan_version: 1,
          plan_hash: planProposed(samplePlan({ mode: "team" })).plan_hash,
        },
        pre: {
          task_rev: 2,
          plan_version: 1,
          plan_hash: planProposed(samplePlan({ mode: "team" })).plan_hash,
        },
      },
    ],
    [
      "other device",
      { type: "agent.registered", actor: MAC, payload: agentRegistered() },
      "daemon:vps",
    ],
    [
      "human actor with daemon key",
      {
        type: "task.cancelled",
        actor: "human",
        payload: { reason: "Cancel" },
        pre: { task_rev: 2 },
      },
      "daemon:mac",
    ],
    [
      "non-owner proposal",
      {
        type: "plan.proposed",
        actor: MAC,
        payload: planProposed(samplePlan({ mode: "team" }), [MAC]),
        pre: { task_rev: 2, owner_gen: 1 },
      },
    ],
    [
      "non-reviewer review",
      {
        type: "review.submitted",
        actor: VPS,
        payload: {
          plan_version: 1,
          plan_hash: planProposed(samplePlan({ mode: "team" })).plan_hash,
          verdict: "approve",
          blockers: [],
          suggestions: [],
        },
        pre: {
          task_rev: 2,
          plan_version: 1,
          plan_hash: planProposed(samplePlan({ mode: "team" })).plan_hash,
        },
      },
    ],
  ];
  it.each(unauthorized)(
    "records %s as unauthorized without consuming the ID",
    (_name, spec, signer) => {
      const builder = reviewing();
      const before = replay(builder.entries);
      const event = builder.append(spec, { signer });
      const after = replay(builder.entries);
      expect(after.outcomes.at(-1)).toMatchObject({
        outcome: "rejected",
        reason: "unauthorized",
        event_id: event.event_id,
      });
      expect(after.tasks).toEqual(before.tasks);
      expect(after.agents).toEqual(before.agents);
      expect(after.seen_event_ids).toEqual(before.seen_event_ids);
    },
  );
});
