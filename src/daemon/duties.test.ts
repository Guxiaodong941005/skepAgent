import { describe, expect, it, vi } from "vitest";
import {
  agentRegistered,
  fakeEventId,
  LogBuilder,
  MAC,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import { contentHash } from "../core/canonical.js";
import { draft, finalizeEvent, type Intent } from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { Duties } from "./duties.js";
import { SlotRegistry } from "./slots.js";

async function fixture(device = "vps", team = false, approval: "human" | "owner" = "human") {
  const log = new LogBuilder();
  for (const actor of [MAC, VPS])
    log.append({ type: "agent.registered", actor, payload: agentRegistered() });
  log.append({
    type: "task.created",
    actor: "human",
    payload: taskCreated({ owner: VPS, mode: team ? "team" : "solo", plan_approval: approval }),
  });
  let state = replay(log.entries);
  const time = new VirtualTime();
  const clock = new FakeClock(time);
  let event = 601;
  const publish = vi.fn(async (intent: Intent) => {
    const value = intent(state);
    const id = fakeEventId(event++);
    if (!value) return { status: "dropped" as const, eventId: id };
    log.appendRaw(
      finalizeEvent(value, {
        event_id: id,
        observed_tip: log.tip,
        created_at: "2026-10-05T00:00:00Z",
      }),
    );
    state = replay(log.entries);
    const outcome = state.outcomes.at(-1);
    if (!outcome) throw new Error("Missing publication outcome");
    return {
      status: outcome.outcome === "accepted" ? ("accepted" as const) : ("rejected" as const),
      eventId: id,
      seq: outcome.seq,
    };
  });
  const adapter = {
    cli: "codex" as const,
    probe: vi.fn(async () => ({ ok: true, version: "0.0.0-test", detail: "Test" })),
    invoke: vi.fn(),
  };
  const slots = new SlotRegistry({
    device,
    adapter: () => adapter,
    resolveUser: async () => ({}),
    loadPolicy: async () => ({
      file: "AGENT.md",
      body: "Implement assigned work.",
      frontMatter: {
        schema: "skep.agent/v1",
        role: "coding",
        agent_cli: "codex",
        cli_version: "0.0.0-test",
        repos: ["https://example.invalid/code.git"],
        capabilities: ["typescript"],
        requires_local: [],
        max_parallel_items: 1,
        budgets: { max_invocation_minutes: 1 },
      },
    }),
  });
  const slot = await slots.start({
    roleDir: ".skep-sim/role",
    home: process.cwd(),
    user: "skep",
    path: "agent-bin",
  });
  const plan = samplePlan();
  if (team) {
    plan.mode = "team";
    plan.items.push({
      ...(plan.items[0] as NonNullable<(typeof plan.items)[0]>),
      id: "W2",
      assignee: MAC,
      depends_on: ["W1"],
    });
    plan.stack_order.push("W2");
  }
  const planInvoke = vi.fn(async () => plan);
  const review = vi.fn(async () => ({
    schema: "skep.review/v1",
    plan_version: 1,
    plan_hash: contentHash(plan),
    verdict: "approve",
    blockers: [],
    suggestions: [],
  }));
  const attempt = {
    run: vi.fn(async (_input: import("../exec/attempt.js").AttemptInput) => ({
      status: "stale" as const,
    })),
    interrupt: vi.fn(async () => true),
  };
  const delivery = vi.fn(async (_context: import("./delivery.js").DeliveryDutyContext) => {});
  const replan = vi.fn(async () => {});
  const stale = vi.fn(async () => {});
  const error = vi.fn();
  const duties = new Duties({
    slots,
    clock,
    random: { bytes: (n) => new Uint8Array(n) },
    publisher: { publish },
    current: () => state,
    plan: planInvoke,
    review,
    verifyReview: async (input) => input,
    validation: (_slot, s, task) => ({
      state: s,
      task,
      loadChecks: async () => ({
        schema: "skep.checks/v1",
        checks: {
          unit: { argv: ["node", "-e", "process.exit(0)"], timeout_sec: 600, parser: "none" },
        },
      }),
      pathExists: async () => true,
    }),
    attempt: () => attempt,
    onError: error,
    wake: vi.fn(),
    delivery,
    replan,
    recordStale: stale,
  });
  const approve = () =>
    publish((s) => {
      const task = s.tasks[T1];
      const record = task?.plans[String(task.current_plan_version)];
      return task && record
        ? draft(
            "plan.approved",
            T1,
            "human",
            { plan_version: record.version, plan_hash: record.plan_hash },
            { task_rev: task.rev, plan_version: record.version, plan_hash: record.plan_hash },
          )
        : null;
    });
  return {
    slots,
    slot,
    duties,
    plan,
    planInvoke,
    adapter,
    attempt,
    delivery,
    replan,
    error,
    review,
    stale,
    state: () => state,
    publish,
    approve,
    time,
  };
}
describe("daemon duties", () => {
  it("activates a normal solo plan under owner approval but leaves high risk for the human", async () => {
    const normal = await fixture("vps", false, "owner");
    normal.duties.tick(normal.state());
    await normal.duties.settle();
    normal.duties.tick(normal.state());
    await normal.duties.settle();
    expect(normal.state().tasks[T1]?.status).toBe("executing");
    const high = await fixture("vps", false, "owner");
    const item = high.plan.items[0];
    if (!item) throw new Error("Missing plan item");
    item.risk = "high";
    high.duties.tick(high.state());
    await high.duties.settle();
    high.duties.tick(high.state());
    await high.duties.settle();
    high.duties.tick(high.state());
    await high.duties.settle();
    expect(high.state().tasks[T1]?.status).toBe("awaiting_approval");
    expect(high.publish).toHaveBeenCalledOnce();
    expect(high.attempt.run).not.toHaveBeenCalled();
  });
  it("locks immediately after every peer review arrives", async () => {
    const f = await fixture("vps", true);
    f.duties.tick(f.state());
    await f.duties.settle();
    await f.publish((state) => {
      const task = state.tasks[T1];
      return task
        ? draft(
            "review.submitted",
            T1,
            MAC,
            {
              plan_version: 1,
              plan_hash: contentHash(f.plan),
              verdict: "approve",
              blockers: [],
              suggestions: [],
            },
            { task_rev: task.rev, plan_version: 1, plan_hash: contentHash(f.plan) },
          )
        : null;
    });
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.state().tasks[T1]?.status).toBe("awaiting_approval");
    expect(f.state().tasks[T1]?.plans["1"]?.locked?.missing_reviews).toEqual([]);
  });
  it("plans once despite repeated ticks, then claims and starts an attempt after acceptance", async () => {
    const f = await fixture();
    f.duties.tick(f.state());
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.planInvoke).toHaveBeenCalledOnce();
    expect(f.state().tasks[T1]?.status).toBe("awaiting_approval");
    await f.approve();
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.attempt.run).toHaveBeenCalledOnce();
    expect(f.attempt.run.mock.calls[0]?.[0]).toMatchObject({
      lease: { holder: VPS, epoch: 1, item: "W1" },
      baseSha: f.plan.base.commit,
      prBase: f.plan.base.branch,
    });
    expect(f.error).not.toHaveBeenCalled();
  });
  it("does not invoke or claim after the CLI version changes (F14)", async () => {
    const f = await fixture();
    f.adapter.probe.mockResolvedValueOnce({ ok: true, version: "changed", detail: "CLI upgraded" });
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.planInvoke).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenCalled();
  });
  it("reviews only its missing current review and fences the plan hash", async () => {
    const f = await fixture("mac", true);
    await f.publish((s) => {
      const task = s.tasks[T1];
      return task
        ? draft(
            "plan.proposed",
            T1,
            VPS,
            {
              version: 1,
              parent_version: null,
              plan: f.plan,
              plan_hash: contentHash(f.plan),
              base_commit: f.plan.base.commit,
              reviewers: [MAC],
            },
            { task_rev: task.rev, owner_gen: task.owner_gen },
          )
        : null;
    });
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.review).toHaveBeenCalledOnce();
    expect(f.state().tasks[T1]?.plans["1"]?.reviews[MAC]?.verdict).toBe("approve");
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.review).toHaveBeenCalledOnce();
  });
  it("locks after the monotonic review timeout with exact missing reviewers", async () => {
    const f = await fixture("vps", true);
    f.duties.tick(f.state());
    await f.duties.settle();
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.state().tasks[T1]?.status).toBe("reviewing");
    await f.time.advance(15 * 60_000);
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.state().tasks[T1]?.status).toBe("awaiting_approval");
    expect(f.state().tasks[T1]?.plans["1"]?.locked?.missing_reviews).toEqual([MAC]);
  });
  it("routes a D15 delivered activation to verification, including after human resume", async () => {
    const f = await fixture();
    f.duties.tick(f.state());
    await f.duties.settle();
    await f.approve();
    const task = f.state().tasks[T1];
    if (!task) throw new Error("Missing task");
    task.status = "delivered";
    task.verified = null;
    f.duties.tick(f.state());
    await f.duties.settle();
    expect(f.delivery).toHaveBeenCalled();
    expect(f.delivery.mock.calls.at(-1)?.[0]).toMatchObject({
      task: { status: "delivered", verified: null },
    });
  });
  it("journals and interrupts revoked attempts, removes stale leases from reverify (G15)", async () => {
    const f = await fixture();
    f.duties.tick(f.state());
    await f.duties.settle();
    await f.approve();
    let finish: (value: { status: "stale" }) => void = () => {};
    f.attempt.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.duties.tick(f.state());
    for (let i = 0; i < 20 && f.duties.heldLeases().length === 0; i++) await Promise.resolve();
    expect(f.duties.heldLeases()).toHaveLength(1);
    await f.publish((s) => {
      const task = s.tasks[T1];
      return task
        ? draft(
            "lease.revoked",
            T1,
            "human",
            { item: "W1", epoch: 1, reason: "Test revoke", observed_hb: null },
            { task_rev: task.rev, item: "W1" },
          )
        : null;
    });
    await f.duties.discardStale(f.state());
    expect(f.attempt.interrupt).toHaveBeenCalledWith({ task: T1, item: "W1", epoch: 1 });
    expect(f.stale).toHaveBeenCalledOnce();
    expect(f.duties.heldLeases()).toEqual([]);
    finish({ status: "stale" });
    await f.duties.settle();
    expect(f.slot.busy.size).toBe(0);
  });
});
