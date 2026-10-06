import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  fakeEventId,
  fakeSha,
  LogBuilder,
  MAC,
  planProposed,
  T1,
  taskCreated,
  VPS,
} from "../../../test/helpers/log-builder.js";
import { canonicalJson } from "../canonical.js";
import type { LogEntry } from "../log.js";
import type { EventType } from "../schemas/events.js";
import { applyEvent } from "./apply.js";
import { applyEntry, replay } from "./replay.js";

function mixed(): LogBuilder {
  const builder = new LogBuilder();
  const registration = builder.append({
    type: "agent.registered",
    actor: VPS,
    payload: agentRegistered(),
  });
  builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
  builder.append({ type: "task.created", actor: "human", payload: taskCreated() });
  const proposal = planProposed();
  builder.append({
    type: "plan.proposed",
    actor: MAC,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  builder.append(
    { type: "plan.proposed", actor: VPS, payload: proposal, pre: { task_rev: 1, owner_gen: 1 } },
    { observedTip: fakeSha("stale") },
  );
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 2 },
  });
  builder.append({
    type: "plan.proposed",
    actor: VPS,
    payload: { ...proposal, plan_hash: `sha256:${"a".repeat(64)}` },
    pre: { task_rev: 1, owner_gen: 1 },
  });
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
    type: "task.cancelled",
    actor: "human",
    payload: { reason: "Cancel" },
    pre: { task_rev: 2 },
  });
  builder.append(
    { type: "task.cancelled", actor: "human", payload: { reason: "Cancel" }, pre: { task_rev: 3 } },
    {
      mutate: (entry) => {
        entry.signature = { status: "bad", detail: "tampered" };
      },
    },
  );
  builder.appendRaw(registration);
  builder.append({
    type: "task.cancelled",
    actor: "human",
    payload: { reason: "Cancel" },
    pre: { task_rev: 3 },
  });
  return builder;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

describe("replay audit and idempotency", () => {
  it("checks duplicates before stale tips and authorization, without changing domain state", () => {
    const builder = new LogBuilder();
    const first = builder.append({
      type: "agent.registered",
      actor: VPS,
      payload: agentRegistered(),
    });
    const before = replay(builder.entries);
    builder.append(
      { type: "task.created", actor: MAC, event_id: first.event_id, payload: taskCreated() },
      { observedTip: fakeSha("stale") },
    );
    const after = replay(builder.entries);
    expect(after.outcomes.at(-1)).toMatchObject({ outcome: "duplicate", reason: null });
    expect(after).toEqual({
      ...before,
      tip: builder.tip,
      seq: 2,
      outcomes: [...before.outcomes, after.outcomes.at(-1)],
    });
    expect(after.seen_event_ids[first.event_id]).toBe(1);
  });

  it.each(["stale_tip", "unauthorized"] as const)(
    "does not consume an event ID rejected as %s",
    (reason) => {
      const builder = new LogBuilder();
      builder.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
      const id = fakeEventId();
      const spec = {
        type: "agent.registered",
        actor: VPS,
        payload: agentRegistered(),
        event_id: id,
      } as const;
      builder.append(
        spec,
        reason === "stale_tip" ? { observedTip: fakeSha("stale") } : { signer: "daemon:mac" },
      );
      const rejected = replay(builder.entries);
      expect(rejected.outcomes.at(-1)?.reason).toBe(reason);
      expect(Object.hasOwn(rejected.seen_event_ids, id)).toBe(false);
      builder.append(spec);
      const accepted = replay(builder.entries);
      expect(accepted.outcomes.at(-1)?.outcome).toBe("accepted");
      expect(accepted.seen_event_ids[id]).toBe(3);
      expect(accepted.agents[VPS]?.registered_seq).toBe(3);
    },
  );

  it("marks semantic rejection IDs seen and treats a corrected retry as duplicate", () => {
    const builder = new LogBuilder();
    const event = builder.append({ type: "task.created", actor: "human", payload: taskCreated() });
    expect(replay(builder.entries).outcomes.at(-1)?.reason).toBe("unknown_agent");
    builder.append({ type: "agent.registered", actor: VPS, payload: agentRegistered() });
    builder.append({
      type: "task.created",
      actor: "human",
      event_id: event.event_id,
      payload: taskCreated(),
    });
    const state = replay(builder.entries);
    expect(state.outcomes.at(-1)?.outcome).toBe("duplicate");
    expect(state.seen_event_ids[event.event_id]).toBe(1);
    expect(state.tasks).toEqual({});
  });

  it("increments revisions only for accepted task events and records every non-genesis position", () => {
    const builder = mixed();
    const state = replay(builder.entries);
    const accepted = state.outcomes.filter(
      (outcome) => outcome.task_id === T1 && outcome.outcome === "accepted",
    );
    expect(accepted).toHaveLength(4);
    expect(state.tasks[T1]?.rev).toBe(accepted.length);
    expect(state.tasks[T1]?.last_seq).toBe(13);
    expect(state.tasks[T1]?.status).toBe("cancelled");
    expect(state.outcomes).toHaveLength(builder.entries.length - 1);
    expect(state.outcomes.map((outcome) => outcome.seq)).toEqual(
      builder.entries.slice(1).map((entry) => entry.seq),
    );
    expect(state.tip).toBe(builder.tip);
    expect(state.seq).toBe(13);
  });

  it("rejects a discontinuous incremental log with an actionable error", () => {
    const builder = mixed();
    const state = replay(builder.entries.slice(0, 2));
    expect(() => applyEntry(state, builder.entries[3] as LogEntry)).toThrow(/Expected log seq 2/);
    expect(() => applyEntry(state, builder.entries[1] as LogEntry)).toThrow(RangeError);
  });
});

describe("replay purity and determinism", () => {
  it("produces byte-identical JSON when replaying the same log twice", () => {
    const builder = mixed();
    const entries = freeze(builder.entries);
    const first = replay(entries);
    const second = replay(entries);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it("matches full replay from every incremental prefix", () => {
    const builder = mixed();
    const expected = canonicalJson(replay(builder.entries));
    for (let prefix = 1; prefix <= builder.entries.length; prefix++) {
      const initial = replay(builder.entries.slice(0, prefix));
      const incremental = builder.entries.slice(prefix).reduce(applyEntry, initial);
      expect(canonicalJson(incremental), `prefix ${prefix}`).toBe(expected);
    }
  });

  it("never mutates or shares mutable objects with frozen states or log entries", () => {
    const builder = mixed();
    let state = freeze(replay(builder.entries.slice(0, 1)));
    for (const entry of builder.entries.slice(1)) {
      const snapshot = canonicalJson(state);
      const next = applyEntry(state, freeze(entry));
      expect(canonicalJson(state)).toBe(snapshot);
      expect(next).not.toBe(state);
      expect(next.agents).not.toBe(state.agents);
      expect(next.tasks).not.toBe(state.tasks);
      expect(next.outcomes).not.toBe(state.outcomes);
      state = freeze(next);
    }
    expect(state).toEqual(replay(builder.entries));
  });
});

describe("later-wave handler dispatch", () => {
  const types = [
    "lease.claimed",
    "lease.released",
    "lease.revoked",
    "work.delivered",
    "work.failed",
    "replan.requested",
    "checkpoint.recorded",
    "barrier.closed",
    "item.merged",
    "task.verified",
  ] as const satisfies readonly EventType[];
  it.each(types)("keeps %s as the required non-mutating stub", (type) => {
    const builder = mixed();
    const state = replay(builder.entries.slice(0, 10));
    const before = canonicalJson(state);
    // Stub dispatch is independent of payloads; strict event validation is covered above.
    const event = {
      ...builder.event({
        type: "task.cancelled",
        actor: "human",
        payload: { reason: "Cancel" },
        pre: { task_rev: 3 },
      }),
      type,
    } as Parameters<typeof applyEvent>[1];
    expect(
      applyEvent(state, event, { seq: 10, sha: builder.tip, principal: { kind: "human" } }),
    ).toEqual({ ok: false, reason: "bad_task_state", detail: "not implemented" });
    expect(canonicalJson(state)).toBe(before);
  });

  it("checks preconditions before dispatching even a stub", () => {
    const builder = mixed();
    const state = replay(builder.entries.slice(0, 10));
    const event = builder.event({
      type: "lease.released",
      actor: VPS,
      payload: { item: "W1", epoch: 1, reason: "Release" },
      pre: { task_rev: 99, item: "W1" },
    });
    expect(
      applyEvent(state, event, {
        seq: 10,
        sha: builder.tip,
        principal: { kind: "daemon", device: "vps" },
      }),
    ).toMatchObject({ ok: false, reason: "pre_mismatch" });
  });
});
