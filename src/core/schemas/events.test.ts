import { describe, expect, it } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  taskCreated,
} from "../../../test/helpers/log-builder.js";
import {
  DeliverySubmitSchema,
  EVENT_TYPES,
  parseEvent,
  parseEventFile,
  REQUIRED_PRE,
  serializeEvent,
  TaskCreatedPayload,
  WorkSubmittedPayload,
} from "./events.js";
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

describe("submission payloads", () => {
  const methods = ["pr", "mr", "push", "none", "ask"] as const;
  const states = ["opened", "pushed", "local", "pending"] as const;
  const expected = { pr: "opened", mr: "opened", push: "pushed", none: "local", ask: "pending" };
  for (const method of methods) {
    it.each(states)(`${method} accepts only its matching state %s`, (state) => {
      const submit = {
        method,
        state,
        ...(state === "opened" ? { pr_url: "https://example.invalid/pull/1", pr_number: 1 } : {}),
      };
      expect(DeliverySubmitSchema.safeParse(submit).success).toBe(expected[method] === state);
    });
  }
  it.each([
    { method: "pr", state: "opened" },
    { method: "pr", state: "opened", pr_url: "https://example.invalid/pull/1" },
    { method: "mr", state: "opened", pr_number: 1 },
    { method: "pr", state: "opened", pr_url: "bad", pr_number: 1 },
    { method: "pr", state: "opened", pr_url: "https://example.invalid/pull/1", pr_number: 0 },
    { method: "push", state: "pushed", pr_number: 1 },
    { method: "none", state: "local", pr_url: "https://example.invalid/pull/1" },
    { method: "ask", state: "pending", pr_url: "https://example.invalid/pull/1", pr_number: 1 },
    { method: "skip", state: "skipped" },
    { method: "none", state: "local", extra: true },
  ])("rejects invalid PR data or unknown fields %j", (submit) => {
    expect(DeliverySubmitSchema.safeParse(submit).success).toBe(false);
  });
  it("defaults older task creation events to device policy", () => {
    const { submit: _submit, ...legacy } = taskCreated();
    expect(TaskCreatedPayload.parse(legacy).submit).toBe("device");
    expect(TaskCreatedPayload.safeParse({ ...legacy, submit: "skip" }).success).toBe(false);
  });
  it.each([
    { method: "pr", state: "opened", pr_url: "https://example.invalid/pull/1", pr_number: 1 },
    { method: "mr", state: "opened", pr_url: "https://example.invalid/merge/1", pr_number: 1 },
    { method: "push", state: "pushed" },
    { method: "none", state: "local" },
    { method: "none", state: "skipped" },
  ])("accepts strict later submission %j without a lease precondition", (submission) => {
    const payload = { item: "W1", epoch: 1, head_sha: "a".repeat(40), ...submission };
    expect(WorkSubmittedPayload.safeParse(payload).success).toBe(true);
    const log = new LogBuilder();
    const event = log.event({
      type: "work.submitted",
      actor: "human",
      payload: WorkSubmittedPayload.parse(payload),
      pre: { task_rev: 1, item: "W1" },
    });
    expect(parseEvent(event).ok).toBe(true);
    expect(parseEvent({ ...event, pre: { task_rev: 1 } }).ok).toBe(false);
    expect(WorkSubmittedPayload.safeParse({ ...payload, extra: true }).success).toBe(false);
  });
  it.each([
    { method: "ask", state: "pending" },
    { method: "pr", state: "local" },
    { method: "pr", state: "opened", pr_url: "https://example.invalid/pull/1" },
    { method: "push", state: "pushed", pr_number: 1 },
    { method: "none", state: "skipped", pr_url: "https://example.invalid/pull/1" },
  ])("rejects inconsistent later submission %j", (submission) => {
    expect(
      WorkSubmittedPayload.safeParse({
        item: "W1",
        epoch: 1,
        head_sha: "a".repeat(40),
        ...submission,
      }).success,
    ).toBe(false);
  });
});
