import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  taskCreated,
} from "../../../test/helpers/log-builder.js";
import { EVENT_TYPES, parseEvent, parseEventFile, REQUIRED_PRE, serializeEvent } from "./events.js";
import { PlanSchema } from "./plan.js";

describe("event schemas", () => {
  it("accepts well-formed events from the log builder", () => {
    const log = new LogBuilder();
    const reg = log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    const created = log.append({ type: "task.created", actor: "human", payload: taskCreated() });
    const proposed = log.append({
      type: "plan.proposed",
      actor: "vps.coding",
      pre: { task_rev: 1, owner_gen: 1 },
      payload: planProposed(),
    });
    for (const ev of [reg, created, proposed]) {
      const r = parseEventFile(serializeEvent(ev));
      expect(r.ok, r.ok ? "" : r.error).toBe(true);
    }
  });

  it("rejects unknown fields (strict schemas)", () => {
    const log = new LogBuilder();
    const ev = log.event({ type: "task.created", actor: "human", payload: taskCreated() });
    const r = parseEvent({ ...ev, extra: 1 });
    expect(r.ok).toBe(false);
    const r2 = parseEvent({ ...ev, payload: { ...ev.payload, extra: 1 } });
    expect(r2.ok).toBe(false);
  });

  it("enforces required preconditions per type", () => {
    const log = new LogBuilder();
    const ev = log.event({ type: "task.cancelled", actor: "human", payload: { reason: "nope" } });
    const r = parseEvent(ev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("task_rev");
  });

  it("requires task_id null exactly for cluster events", () => {
    const log = new LogBuilder();
    const ev = log.event({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    expect(parseEvent({ ...ev, task_id: "T-20261005-7f3a" }).ok).toBe(false);
  });

  it("enforces the 64 KiB size limit", () => {
    const r = parseEventFile("x".repeat(64 * 1024 + 1));
    expect(r.ok).toBe(false);
  });

  it("covers every event type in REQUIRED_PRE", () => {
    expect(Object.keys(REQUIRED_PRE).sort()).toEqual([...EVENT_TYPES].sort());
  });
});

describe("plan schema", () => {
  it("accepts a linear stack", () => {
    const base = samplePlan();
    const w1 = base.items[0];
    if (!w1) throw new Error("fixture");
    const plan = samplePlan({
      mode: "team",
      items: [w1, { ...w1, id: "W2", assignee: MAC, depends_on: ["W1"] }],
      stack_order: ["W1", "W2"],
    });
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  it("rejects non-linear dependencies and bad paths", () => {
    const base = samplePlan();
    const w1 = base.items[0];
    if (!w1) throw new Error("fixture");
    const bad = samplePlan({
      items: [w1, { ...w1, id: "W2", depends_on: [] }],
      stack_order: ["W1", "W2"],
    });
    expect(PlanSchema.safeParse(bad).success).toBe(false);
    const badPath = samplePlan({ items: [{ ...w1, touches: ["../etc/passwd"] }] });
    expect(PlanSchema.safeParse(badPath).success).toBe(false);
  });
});
