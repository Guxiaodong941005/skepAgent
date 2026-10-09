import { readFile, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "../../test/helpers/git-fixture.js";
import {
  agentRegistered,
  fakeEventId,
  fakeSha,
  LogBuilder,
  MAC,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import type { PublishResult } from "../blackboard/publisher.js";
import type { CodeHost } from "../codehost/types.js";
import { contentHash } from "../core/canonical.js";
import { workBranch } from "../core/ids.js";
import {
  claimIntent,
  deliverIntent,
  draft,
  finalizeEvent,
  type Intent,
  releaseIntent,
} from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import type { CheckRun } from "../core/schemas/common.js";
import { ChecksRunner, type RunChecksOptions } from "../exec/checks.js";
import { Journal } from "../exec/journal.js";
import type { CodeMirror, CreateWorktreeOptions } from "../exec/worktree.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { createDeliveryDuty, type DeliveryDutyContext, DeliveryError } from "./delivery.js";
import { Duties } from "./duties.js";
import { SlotRegistry } from "./slots.js";

const REPO = "https://example.invalid/code.git";
const HEAD = fakeSha("top");

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing fixture value");
  return value;
}

async function fixture(delivered = true, maximumChecks = false) {
  const log = new LogBuilder();
  let state = replay(log.entries);
  let serial = 606;
  const publish = vi.fn(async (intent: Intent): Promise<PublishResult> => {
    const value = intent(state);
    const eventId = fakeEventId(serial++);
    if (!value) return { status: "dropped" as const, eventId };
    log.appendRaw(
      finalizeEvent(value, {
        event_id: eventId,
        observed_tip: log.tip,
        created_at: "2026-10-05T00:00:00Z",
      }),
    );
    state = replay(log.entries);
    const outcome = state.outcomes.at(-1);
    if (!outcome) throw new Error("Missing outcome");
    return {
      status: outcome.outcome === "accepted" ? "accepted" : "rejected",
      eventId,
      seq: outcome.seq,
    };
  });
  for (const actor of [MAC, VPS])
    await publish(() => draft("agent.registered", null, actor, agentRegistered(), {}));
  await publish(() =>
    draft("task.created", T1, "human", taskCreated({ repo: REPO, owner: MAC, mode: "team" }), {}),
  );
  const plan = samplePlan({
    mode: "team",
    base: { repo: REPO, branch: "main", commit: fakeSha("base") },
    items: [
      {
        id: "W1",
        title: "First example",
        role: "coding",
        assignee: MAC,
        depends_on: [],
        touches: ["one.txt"],
        risk: "normal",
        acceptance: [
          { kind: "check", name: "unit" },
          { kind: "manual", text: "Inspect output" },
        ],
      },
      {
        id: "W2",
        title: "Second example",
        role: "coding",
        assignee: VPS,
        depends_on: ["W1"],
        touches: ["two.txt"],
        risk: "normal",
        acceptance: [
          { kind: "check", name: "unit" },
          { kind: "check", name: "combined" },
        ],
      },
    ],
    stack_order: ["W1", "W2"],
  });
  if (maximumChecks) {
    plan.items.push(
      ...Array.from({ length: 2 }, (_, index) => ({
        ...required(plan.items[index]),
        id: `W${index + 3}`,
        depends_on: [`W${index + 2}`],
      })),
    );
    plan.stack_order.push("W3", "W4");
    for (const [index, item] of plan.items.entries())
      item.acceptance = Array.from({ length: 16 }, (_, offset) => ({
        kind: "check",
        name: `check_${index * 16 + offset}`,
      }));
  }
  await publish((s) =>
    draft(
      "plan.proposed",
      T1,
      MAC,
      {
        version: 1,
        parent_version: null,
        plan,
        plan_hash: contentHash(plan),
        base_commit: plan.base.commit,
        reviewers: [VPS],
      },
      { task_rev: s.tasks[T1]?.rev, owner_gen: 1 },
    ),
  );
  await publish((s) =>
    draft(
      "plan.locked",
      T1,
      MAC,
      {
        plan_version: 1,
        plan_hash: contentHash(plan),
        overrides: [],
        missing_reviews: [VPS],
      },
      { task_rev: s.tasks[T1]?.rev, owner_gen: 1, plan_version: 1, plan_hash: contentHash(plan) },
    ),
  );
  await publish((s) =>
    draft(
      "plan.approved",
      T1,
      "human",
      {
        plan_version: 1,
        plan_hash: contentHash(plan),
      },
      { task_rev: s.tasks[T1]?.rev, plan_version: 1, plan_hash: contentHash(plan) },
    ),
  );
  const deliver = async (item: string, actor: string, head: string, number: number) => {
    await publish(
      claimIntent({ task_id: T1, item, actor, attempt_id: `att_${fakeSha(item).slice(0, 12)}` }),
    );
    await publish(
      deliverIntent({
        task_id: T1,
        item,
        actor,
        epoch: 1,
        head_sha: head,
        submit: {
          method: "pr",
          state: "opened",
          pr_url: `https://example.invalid/pull/${number}`,
          pr_number: number,
        },
        check_runs: [],
      }),
    );
  };
  for (const [index, item] of (delivered ? plan.items : plan.items.slice(0, 1)).entries())
    await deliver(
      item.id,
      item.assignee,
      index === 0 ? fakeSha("first") : index === plan.items.length - 1 ? HEAD : fakeSha(item.id),
      index + 1,
    );
  const clock = new FakeClock(new VirtualTime());
  const slots = new SlotRegistry({
    device: "mac",
    adapter: () => ({
      cli: "codex",
      probe: async () => ({ ok: true, version: "test", detail: "Test" }),
      invoke: vi.fn(),
    }),
    resolveUser: async () => ({}),
    loadPolicy: async () => ({
      file: "AGENT.md",
      body: "Implement example work.",
      frontMatter: {
        schema: "skep.agent/v1",
        role: "coding",
        agent_cli: "codex",
        cli_version: "test",
        repos: [REPO],
        capabilities: [],
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
  const mirror = {
    createWorktree: vi.fn(async (opts: CreateWorktreeOptions) => ({
      repo: REPO,
      path: "verification-checkout",
      mirrorDir: "mirror",
      branch: opts.branch,
      baseSha: opts.baseSha,
    })),
    removeWorktree: vi.fn(async () => {}),
  };
  let failed = false;
  const checks = {
    run: vi.fn(async (opts: RunChecksOptions) =>
      opts.checks.map(
        (check: string): CheckRun => ({
          run_id: `run_${check}`,
          check,
          sha: HEAD,
          exit: failed ? 1 : 0,
          duration_ms: 1,
          log_sha256: "0".repeat(64),
        }),
      ),
    ),
  };
  const statuses = new Map<
    number,
    { state: "open" | "closed" | "merged"; mergeSha: string | null }
  >([
    [1, { state: "open", mergeSha: null }],
    [2, { state: "open", mergeSha: null }],
  ]);
  const bases = new Map([
    [1, "main"],
    [2, workBranch(T1, "W1", 1)],
  ]);
  const host = {
    remoteBranchSha: vi.fn(),
    createPr: vi.fn(),
    findPr: vi.fn(async (_repo, branch) => {
      const number =
        branch === workBranch(T1, "W1", 1) ? 1 : branch === workBranch(T1, "W2", 1) ? 2 : null;
      if (number === null || statuses.get(number)?.state !== "open") return null;
      return {
        number,
        url: `https://example.invalid/pull/${number}`,
        head: branch,
        base: bases.get(number) ?? "main",
        title: "Example",
        state: "open" as const,
        mergeSha: null,
      };
    }),
    prState: vi.fn(
      async (_repo, number) => statuses.get(number) ?? { state: "closed" as const, mergeSha: null },
    ),
    retargetPr: vi.fn(async (_repo, number, base) => {
      bases.set(number, base);
    }),
    closePr: vi.fn(async (_repo, number) => {
      statuses.set(number, { state: "closed", mergeSha: null });
    }),
  } satisfies CodeHost;
  const git = { run: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
  const notify = vi.fn(async (_message: string) => {});
  const duty = createDeliveryDuty({
    clock,
    git,
    mirror: () => mirror as unknown as CodeMirror,
    checks: () => checks as unknown as ChecksRunner,
    codeHost: () => host,
    notify,
  });
  const context = (): DeliveryDutyContext => {
    const task = state.tasks[T1];
    if (!task) throw new Error("Missing task");
    return { state, task, slot, publisher: { publish }, nowMonoMs: clock.monotonicMs() };
  };
  return {
    log,
    state: () => state,
    plan,
    publish,
    slot,
    slots,
    duty,
    context,
    checks,
    mirror,
    host,
    git,
    notify,
    statuses,
    bases,
    clock,
    fail: (value = true) => {
      failed = value;
    },
  };
}

describe("stacked delivery duty", () => {
  it.each(["push", "none", "ask"] as const)(
    "verifies %s deliveries without code-host calls or stale closure",
    async (method) => {
      const f = await fixture();
      const task = required(f.state().tasks[T1]);
      for (const item of Object.values(task.items)) {
        const delivery = required(item.delivered);
        delivery.submit = {
          method,
          state: method === "push" ? "pushed" : method === "none" ? "local" : "pending",
        };
        task.epochs[item.id] = 3;
      }
      task.epochs.W3 = 2;
      await f.duty(f.context());
      expect(f.checks.run).toHaveBeenCalledOnce();
      expect(f.host.prState).not.toHaveBeenCalled();
      expect(f.host.findPr).not.toHaveBeenCalled();
      expect(f.host.retargetPr).not.toHaveBeenCalled();
      expect(f.host.closePr).not.toHaveBeenCalled();
    },
  );

  it("runs every named acceptance check once at the top SHA using the trusted plan base", async () => {
    const f = await fixture();
    const original = f.context();
    await f.duty(original);
    await f.duty(original);
    await f.duty(f.context());
    expect(f.checks.run).toHaveBeenCalledOnce();
    expect(f.checks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        checks: ["unit", "combined"],
        baseCommit: f.plan.base.commit,
        worktree: "verification-checkout",
        attempt: { task: T1, item: expect.stringMatching(/^verification-[0-9a-f]{64}$/), epoch: 1 },
      }),
    );
    expect(f.mirror.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ baseSha: HEAD }),
    );
    expect(f.state().tasks[T1]?.verified).toMatchObject({ top_of_stack_sha: HEAD, passed: true });
    expect(f.mirror.removeWorktree).toHaveBeenCalledOnce();
    expect(f.git.run).toHaveBeenCalledWith(expect.arrayContaining(["branch", "-D"]), {
      cwd: "mirror",
    });
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("uses a separate durable journal through the real checks runner", async () => {
    const root = await tempDir("delivery-journal-");
    try {
      const f = await fixture();
      const journal = new Journal({ roleDir: root, clock: f.clock });
      const attempt = { task: T1, item: "W2", epoch: 1 };
      await journal.append(attempt, { step: "delivered_published" });
      const delivered = await readFile(journal.path(attempt), "utf8");
      const runner = new ChecksRunner({
        clock: f.clock,
        journal,
        git: { run: vi.fn(async () => ({ code: 0, stdout: `${HEAD}\n`, stderr: "" })) },
        mirror: { mirrorPath: async () => root },
        env: { home: root, user: "agent", source: {} },
        runtime: {
          name: "native",
          spawn: async () => ({
            pid: 123,
            pgid: 123,
            startToken: "check-123",
            signalGroup: vi.fn(),
            wait: async () => ({ code: 0, signal: null }),
          }),
          isAlive: async () => false,
        },
      });
      vi.spyOn(runner, "load").mockResolvedValue({
        schema: "skep.checks/v1",
        checks: {
          unit: { argv: ["example-check"], timeout_sec: 1, parser: "none" },
          combined: { argv: ["example-check"], timeout_sec: 1, parser: "none" },
        },
      });
      f.checks.run.mockImplementation(async (opts) => runner.run({ ...opts, worktree: root }));
      await f.duty(f.context());
      const verification = required(f.checks.run.mock.calls[0]?.[0].attempt);
      expect(verification).not.toEqual(attempt);
      expect((await journal.read(verification)).map((record) => record.step)).toEqual([
        "check_started",
        "check_run",
        "check_started",
        "check_run",
        "checks",
      ]);
      expect(await readFile(journal.path(attempt), "utf8")).toBe(delivered);
      const restarted = new Journal({ roleDir: root, clock: f.clock });
      expect(await restarted.unfinishedAttempts()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("escalates a failed combined check without a work failure or automatic retry, then re-verifies after resume", async () => {
    const f = await fixture();
    const before = structuredClone(f.state().tasks[T1]);
    f.fail();
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.state().tasks[T1]).toMatchObject({
      status: "escalated",
      escalation: { reason: "verification_failed" },
    });
    expect(f.state().tasks[T1]?.items).toEqual(before?.items);
    expect(f.state().tasks[T1]?.budgets).toEqual(before?.budgets);
    expect(f.checks.run).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.log.events.filter((event) => event?.type === "work.failed")).toEqual([]);
    await f.publish((s) =>
      draft(
        "human.decided",
        T1,
        "human",
        { decision: "resume_with_plan" },
        { task_rev: s.tasks[T1]?.rev },
      ),
    );
    expect(f.state().tasks[T1]).toMatchObject({ status: "delivered", verified: null });
    f.fail(false);
    await f.duty(f.context());
    expect(f.checks.run).toHaveBeenCalledTimes(2);
    expect(f.checks.run.mock.calls[0]?.[0].attempt).not.toEqual(
      f.checks.run.mock.calls[1]?.[0].attempt,
    );
    expect(f.state().tasks[T1]?.verified?.passed).toBe(true);
  });

  it("notifies again after a notification error without re-running checks", async () => {
    const f = await fixture();
    f.fail();
    f.notify.mockRejectedValueOnce(new Error("Notifier unavailable"));
    await expect(f.duty(f.context())).rejects.toBeInstanceOf(DeliveryError);
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.notify).toHaveBeenCalledTimes(2);
    expect(f.checks.run).toHaveBeenCalledOnce();
  });

  it("verifies again when a new plan carries over the whole delivered stack (D15)", async () => {
    const f = await fixture();
    f.fail();
    await f.duty(f.context());
    await f.publish((s) =>
      draft("human.decided", T1, "human", { decision: "replan" }, { task_rev: s.tasks[T1]?.rev }),
    );
    const plan = {
      ...f.plan,
      version: 2,
      parent_version: 1,
      changes_from_parent: "Keep the delivered stack for another verification.",
    };
    const hash = contentHash(plan);
    await f.publish((s) =>
      draft(
        "plan.proposed",
        T1,
        MAC,
        {
          version: 2,
          parent_version: 1,
          plan,
          plan_hash: hash,
          base_commit: plan.base.commit,
          reviewers: [VPS],
        },
        { task_rev: s.tasks[T1]?.rev, owner_gen: 1 },
      ),
    );
    await f.publish((s) =>
      draft(
        "plan.locked",
        T1,
        MAC,
        {
          plan_version: 2,
          plan_hash: hash,
          overrides: [],
          missing_reviews: [VPS],
        },
        { task_rev: s.tasks[T1]?.rev, owner_gen: 1, plan_version: 2, plan_hash: hash },
      ),
    );
    await f.publish((s) =>
      draft(
        "plan.approved",
        T1,
        "human",
        {
          plan_version: 2,
          plan_hash: hash,
        },
        { task_rev: s.tasks[T1]?.rev, plan_version: 2, plan_hash: hash },
      ),
    );
    expect(f.state().tasks[T1]).toMatchObject({
      status: "delivered",
      verified: null,
      active_plan_version: 2,
    });
    f.fail(false);
    await f.duty(f.context());
    expect(f.checks.run).toHaveBeenCalledTimes(2);
    expect(f.state().tasks[T1]?.verified?.passed).toBe(true);
  });

  it("batches the maximum acceptance-check union without omitting or repeating a check", async () => {
    const f = await fixture(true, true);
    await f.duty(f.context());
    expect(f.checks.run).toHaveBeenCalledTimes(2);
    expect(f.checks.run.mock.calls.flatMap(([opts]) => opts.checks)).toEqual(
      Array.from({ length: 64 }, (_, index) => `check_${index}`),
    );
    const event = f.log.events.findLast((entry) => entry?.type === "task.verified");
    if (event?.type !== "task.verified") throw new Error("Missing verification");
    expect(event.payload.check_runs).toHaveLength(64);
  });

  it("runs checks of an already merged item when verifying the delivered stack", async () => {
    const f = await fixture();
    await f.publish((s) =>
      draft(
        "item.merged",
        T1,
        MAC,
        {
          item: "W1",
          pr_number: 1,
          merge_sha: fakeSha("merge-first"),
        },
        { task_rev: s.tasks[T1]?.rev, item: "W1" },
      ),
    );
    f.statuses.set(1, { state: "merged", mergeSha: fakeSha("merge-first") });
    await f.duty(f.context());
    expect(f.checks.run).toHaveBeenCalledWith(
      expect.objectContaining({ checks: ["unit", "combined"] }),
    );
    expect(f.state().tasks[T1]?.verified?.passed).toBe(true);
  });

  it("reuses completed checks after a failed publication", async () => {
    const f = await fixture();
    f.publish.mockResolvedValueOnce({
      status: "failed",
      eventId: fakeEventId(999),
    });
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.verified).toBeNull();
    await f.duty(f.context());
    expect(f.checks.run).toHaveBeenCalledOnce();
    expect(f.state().tasks[T1]?.verified?.passed).toBe(true);
  });

  it.each(["owner", "plan", "activation", "head"])(
    "drops stale verification after a changed %s",
    async (change) => {
      const f = await fixture();
      f.checks.run.mockImplementationOnce(async (opts) => {
        const task = f.state().tasks[T1];
        if (!task) throw new Error("Missing task");
        if (change === "owner") task.owner_gen++;
        if (change === "plan") required(task.plans["1"]).plan_hash = `sha256:${"1".repeat(64)}`;
        if (change === "activation")
          f.state().outcomes.push({
            ...required(f.state().outcomes.at(-1)),
            seq: 999,
            type: "human.decided",
          });
        if (change === "head")
          required(required(task.items.W2).delivered).head_sha = fakeSha("changed");
        return opts.checks.map((check: string) => ({
          run_id: `run_${check}`,
          check,
          sha: HEAD,
          exit: 0,
          duration_ms: 1,
          log_sha256: "0".repeat(64),
        }));
      });
      // Keep the captured state immutable like Sync snapshots while the publisher sees the new one.
      const context = f.context();
      context.state = structuredClone(context.state);
      context.task = required(context.state.tasks[T1]);
      await f.duty(context);
      expect(f.state().tasks[T1]?.verified).toBeNull();
    },
  );

  it("rejects check evidence for another SHA and still removes the checkout", async () => {
    const f = await fixture();
    f.checks.run.mockResolvedValueOnce([
      {
        run_id: "run_unit",
        check: "unit",
        sha: fakeSha("wrong"),
        exit: 0,
        duration_ms: 1,
        log_sha256: "0".repeat(64),
      },
    ]);
    await expect(f.duty(f.context())).rejects.toBeInstanceOf(DeliveryError);
    expect(f.state().tasks[T1]?.verified).toBeNull();
    expect(f.mirror.removeWorktree).toHaveBeenCalledOnce();
  });

  it("treats parsed failing tests as failure even when the command exits zero", async () => {
    const f = await fixture();
    f.checks.run.mockResolvedValueOnce(
      ["unit", "combined"].map((check) => ({
        run_id: `run_${check}`,
        check,
        sha: HEAD,
        exit: 0,
        failed: 1,
        duration_ms: 1,
        log_sha256: "0".repeat(64),
      })),
    );
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.verified?.passed).toBe(false);
  });

  it("observes human merges, records actual merge SHAs, retargets once, and finishes", async () => {
    const f = await fixture();
    f.statuses.set(1, { state: "merged", mergeSha: fakeSha("merge-first") });
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.items.W1?.merged?.merge_sha).toBe(fakeSha("merge-first"));
    expect(f.host.retargetPr).toHaveBeenCalledWith(REPO, 2, "main");
    await f.duty(f.context());
    expect(f.host.retargetPr).toHaveBeenCalledOnce();
    expect(f.host.findPr).toHaveBeenCalledOnce();
    f.statuses.set(2, { state: "merged", mergeSha: fakeSha("merge-top") });
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.status).toBe("done");
    expect(f.log.events.filter((event) => event?.type === "item.merged")).toHaveLength(2);
  });

  it("repairs retargeting after item.merged was recorded but retargeting failed", async () => {
    const f = await fixture();
    f.statuses.set(1, { state: "merged", mergeSha: fakeSha("merge-first") });
    f.host.retargetPr.mockRejectedValueOnce(new Error("Host unavailable"));
    await expect(f.duty(f.context())).rejects.toBeInstanceOf(DeliveryError);
    expect(f.state().tasks[T1]?.items.W1?.status).toBe("merged");
    await f.duty(f.context());
    expect(f.bases.get(2)).toBe("main");
    expect(f.log.events.filter((event) => event?.type === "item.merged")).toHaveLength(1);
  });

  it("retries merge publication using cached terminal evidence", async () => {
    const f = await fixture(false);
    f.statuses.set(1, { state: "merged", mergeSha: fakeSha("merge-first") });
    f.publish.mockResolvedValueOnce({ status: "failed", eventId: fakeEventId(999) });
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.items.W1?.status).toBe("delivered");
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.items.W1?.status).toBe("merged");
    expect(f.host.prState).toHaveBeenCalledOnce();
  });

  it("polls open PRs, caches closed PRs, and observes a new delivery epoch", async () => {
    const f = await fixture(false);
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.host.prState).toHaveBeenCalledTimes(2);
    f.statuses.set(1, { state: "closed", mergeSha: null });
    await f.duty(f.context());
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.host.prState).toHaveBeenCalledTimes(3);
    const task = required(f.state().tasks[T1]);
    task.epochs.W1 = 2;
    Object.assign(required(required(task.items.W1).delivered), {
      epoch: 2,
      branch: workBranch(T1, "W1", 2),
      submit: {
        method: "pr",
        state: "opened",
        pr_url: "https://example.invalid/pull/3",
        pr_number: 3,
      },
    });
    f.statuses.set(3, { state: "open", mergeSha: null });
    await f.duty(f.context());
    expect(f.host.prState).toHaveBeenLastCalledWith(REPO, 3);
    expect(f.host.prState).toHaveBeenCalledTimes(4);
    expect(f.host.findPr).not.toHaveBeenCalled();
  });

  it("does not cache failed PR observations", async () => {
    const f = await fixture(false);
    f.host.prState.mockRejectedValueOnce(new Error("Example outage"));
    await expect(f.duty(f.context())).rejects.toBeInstanceOf(DeliveryError);
    await f.duty(f.context());
    expect(f.host.prState).toHaveBeenCalledTimes(2);
  });

  it("allows human merges to finish an escalated verification failure", async () => {
    const f = await fixture();
    f.fail();
    await f.duty(f.context());
    for (const number of [1, 2])
      f.statuses.set(number, { state: "merged", mergeSha: fakeSha(`merge-${number}`) });
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.status).toBe("done");
    expect(f.checks.run).toHaveBeenCalledOnce();
  });

  it("closes known PR stale epochs while ignoring removed items and preserving deliveries and leases", async () => {
    const f = await fixture(false);
    await f.publish(claimIntent({ task_id: T1, item: "W2", actor: VPS, attempt_id: "att_active" }));
    const task = required(f.state().tasks[T1]);
    task.epochs.W1 = 2;
    task.epochs.W3 = 1;
    f.host.findPr.mockImplementation(async (_repo, branch) => ({
      number: branch.endsWith("e2") ? 3 : 4,
      url: "https://example.invalid/pull/3",
      head: branch,
      base: "main",
      title: "Stale",
      state: "open",
      mergeSha: null,
    }));
    await f.duty(f.context());
    expect(f.host.closePr).toHaveBeenCalledTimes(1);
    expect(f.host.findPr.mock.calls.map((call) => call[1])).toEqual([workBranch(T1, "W1", 2)]);
    expect(f.checks.run).not.toHaveBeenCalled();
    await f.duty(f.context());
    expect(f.host.closePr).toHaveBeenCalledTimes(1);
    expect(f.host.findPr).toHaveBeenCalledTimes(1);
    task.epochs.W1 = 3;
    await f.duty(f.context());
    expect(f.host.closePr).toHaveBeenCalledTimes(2);
    expect(f.host.findPr).toHaveBeenLastCalledWith(REPO, workBranch(T1, "W1", 3));
  });

  it("caches absent stale PRs across ticks and scans only new epochs", async () => {
    const f = await fixture(false);
    const task = required(f.state().tasks[T1]);
    task.epochs.W1 = 2;
    await f.duty(f.context());
    await f.duty(f.context());
    task.rev++;
    await f.duty(f.context());
    expect(f.host.findPr).toHaveBeenCalledExactlyOnceWith(REPO, workBranch(T1, "W1", 2));
    task.epochs.W1 = 3;
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.host.findPr.mock.calls.map((call) => call[1])).toEqual([
      workBranch(T1, "W1", 2),
      workBranch(T1, "W1", 3),
    ]);
    expect(f.host.closePr).not.toHaveBeenCalled();
  });

  it.each(["lookup", "close"])(
    "retries a failed stale PR %s without poisoning the cache",
    async (operation) => {
      const f = await fixture(false);
      required(f.state().tasks[T1]).epochs.W1 = 2;
      f.host.findPr.mockResolvedValue({
        number: 3,
        url: "https://example.invalid/pull/3",
        head: workBranch(T1, "W1", 2),
        base: "main",
        title: "Stale",
        state: "open",
        mergeSha: null,
      });
      if (operation === "lookup") f.host.findPr.mockRejectedValueOnce(new Error("Example outage"));
      else f.host.closePr.mockRejectedValueOnce(new Error("Example outage"));
      await expect(f.duty(f.context())).rejects.toBeInstanceOf(DeliveryError);
      await f.duty(f.context());
      await f.duty(f.context());
      expect(f.host.findPr).toHaveBeenCalledTimes(2);
      expect(f.host.closePr).toHaveBeenCalledTimes(operation === "lookup" ? 1 : 2);
    },
  );

  it.each(["cancel", "release"])(
    "rescans known PRs after %s without probing undelivered epochs",
    async (change) => {
      const f = await fixture(false);
      await f.publish(
        claimIntent({ task_id: T1, item: "W2", actor: VPS, attempt_id: "att_active" }),
      );
      await f.duty(f.context());
      expect(f.host.findPr).not.toHaveBeenCalled();
      const epochs = structuredClone(f.state().tasks[T1]?.epochs);
      if (change === "cancel") {
        await f.publish((s) =>
          draft(
            "task.cancelled",
            T1,
            "human",
            { reason: "End the example task." },
            { task_rev: s.tasks[T1]?.rev },
          ),
        );
      } else {
        await f.publish(
          releaseIntent({
            task_id: T1,
            item: "W2",
            actor: VPS,
            epoch: 1,
            reason: "End the example lease.",
          }),
        );
      }
      expect(f.state().tasks[T1]?.epochs).toEqual(epochs);
      await f.duty(f.context());
      await f.duty(f.context());
      expect(f.host.closePr).toHaveBeenCalledTimes(change === "cancel" ? 1 : 0);
    },
  );

  it("does not verify for an assignee or an executing task, but assignees can observe merges", async () => {
    const f = await fixture(false);
    await f.duty(f.context());
    expect(f.checks.run).not.toHaveBeenCalled();
    const full = await fixture();
    full.slot.agent = VPS;
    full.statuses.set(1, { state: "merged", mergeSha: fakeSha("merge-first") });
    await full.duty(full.context());
    expect(full.checks.run).not.toHaveBeenCalled();
    expect(full.state().tasks[T1]?.items.W1?.status).toBe("merged");
  });

  it("rejects a merged PR without a valid merge SHA", async () => {
    const f = await fixture(false);
    f.statuses.set(1, { state: "merged", mergeSha: null });
    await expect(f.duty(f.context())).rejects.toBeInstanceOf(DeliveryError);
    expect(f.state().tasks[T1]?.items.W1?.status).toBe("delivered");
    f.statuses.set(1, { state: "merged", mergeSha: fakeSha("merge-first") });
    await f.duty(f.context());
    expect(f.host.prState).toHaveBeenCalledTimes(2);
    expect(f.state().tasks[T1]?.items.W1?.status).toBe("merged");
  });

  it.each([false, true])(
    "starts W2 at W1's delivered SHA with the correct PR base (merged=%s)",
    async (merged) => {
      const f = await fixture(false);
      if (merged) {
        f.statuses.set(1, { state: "merged", mergeSha: fakeSha("merge-first") });
        await f.duty(f.context());
      }
      f.slot.agent = VPS;
      const attempt = {
        run: vi.fn(async () => ({ status: "stale" as const })),
        interrupt: vi.fn(),
      };
      const error = vi.fn();
      const duties = new Duties({
        slots: f.slots,
        clock: f.clock,
        random: { bytes: (n) => new Uint8Array(n) },
        publisher: { publish: f.publish },
        current: f.state,
        plan: vi.fn(),
        review: vi.fn(),
        verifyReview: vi.fn(),
        validation: vi.fn(),
        attempt: () => attempt,
        recordStale: vi.fn(),
        onError: error,
        wake: vi.fn(),
      });
      duties.tick(f.state());
      await duties.settle();
      expect(error).not.toHaveBeenCalled();
      expect(attempt.run).toHaveBeenCalledWith(
        expect.objectContaining({
          baseSha: fakeSha("first"),
          prBase: merged ? "main" : workBranch(T1, "W1", 1),
        }),
      );
    },
  );
});
