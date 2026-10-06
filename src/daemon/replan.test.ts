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
import {
  checkpointIntent,
  claimIntent,
  draft,
  finalizeEvent,
  type Intent,
} from "../core/intents.js";
import { replay } from "../core/reducer/replay.js";
import type { CommandRunEvidence } from "../core/schemas/evidence.js";
import type { Snapshot } from "../core/schemas/snapshot.js";
import type { WorkReport } from "../core/schemas/work-report.js";
import { EvidenceVerifier } from "../exec/evidence.js";
import { Journal } from "../exec/journal.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import {
  BARRIER_DEADLINE_MS,
  createReplanDuty,
  publishReplanRequest,
  type ReplanDutyContext,
} from "./replan.js";
import { SlotRegistry } from "./slots.js";

const REPO = "https://example.invalid/code.git";
const evidence: CommandRunEvidence = {
  id: "ev_example",
  type: "command_run",
  run_id: "run_example",
  argv_sha256: "a".repeat(64),
  sha: "b".repeat(40),
  exit: 1,
  log_sha256: "c".repeat(64),
};
const evidenceKey = { task: T1, item: "W1", epoch: 1 };
const report: WorkReport = {
  schema: "skep.work_report/v1",
  summary: "An example assumption failed.",
  files_intended: [],
  concerns: [],
  replan_request: { summary: "Revise the example plan.", evidence: [evidence] },
};

async function fixture(device = "vps") {
  const log = new LogBuilder();
  for (const actor of [MAC, VPS])
    log.append({ type: "agent.registered", actor, payload: agentRegistered() });
  log.append({
    type: "task.created",
    actor: "human",
    payload: taskCreated({ owner: MAC, repo: REPO }),
  });
  const plan = samplePlan();
  plan.base.repo = REPO;
  log.append({
    type: "plan.proposed",
    actor: MAC,
    payload: planProposed(plan),
    pre: { task_rev: 1, owner_gen: 1 },
  });
  log.append({
    type: "plan.approved",
    actor: "human",
    payload: {
      plan_version: 1,
      plan_hash: planProposed(plan).plan_hash,
    },
    pre: { task_rev: 2, plan_version: 1, plan_hash: planProposed(plan).plan_hash },
  });
  let state = replay(log.entries);
  const time = new VirtualTime();
  const clock = new FakeClock(time);
  let sequence = 6050;
  const publish = vi.fn(async (intent: Intent) => {
    const value = intent(state);
    const eventId = fakeEventId(sequence++);
    if (!value) return { status: "dropped" as const, eventId };
    log.appendRaw(
      finalizeEvent(value, {
        event_id: eventId,
        observed_tip: log.tip,
        created_at: "2026-10-05T00:00:00Z",
      }),
    );
    state = replay(log.entries);
    expect(state.outcomes.at(-1)?.outcome).toBe("accepted");
    return { status: "accepted" as const, eventId };
  });
  const slots = new SlotRegistry({
    device,
    adapter: () => ({
      cli: "codex",
      probe: async () => ({ ok: true, version: "0.0.0-test", detail: "Example" }),
      invoke: vi.fn(),
    }),
    resolveUser: async () => ({}),
    loadPolicy: async () => ({
      file: "AGENT.md",
      body: "Implement the example item.",
      frontMatter: {
        schema: "skep.agent/v1",
        role: "coding",
        agent_cli: "codex",
        cli_version: "0.0.0-test",
        repos: [REPO],
        capabilities: [],
        requires_local: [],
        max_parallel_items: 1,
        budgets: { max_invocation_minutes: 30 },
      },
    }),
  });
  const slot = await slots.start({
    roleDir: `.skep-sim/replan-${device}`,
    home: ".skep-sim/agent",
    user: "skep",
    path: "example-bin",
  });
  const journal = new Journal({ roleDir: slot.roleDir, clock });
  const read = vi.spyOn(journal, "read").mockResolvedValue([]);
  const attempt = { interrupt: vi.fn(async () => true) };
  const notify = vi.fn(async (_message: string) => {});
  const duty = createReplanDuty({ clock, journal: () => journal, notify });
  const context = (): ReplanDutyContext => {
    const task = state.tasks[T1];
    if (!task) throw new Error("Missing fixture task");
    return { state, task, slot, nowMonoMs: clock.monotonicMs(), publisher: { publish }, attempt };
  };
  const claim = async () =>
    publish(claimIntent({ task_id: T1, actor: VPS, item: "W1", attempt_id: "att_example" }));
  const request = async () =>
    publish((latest) =>
      draft(
        "replan.requested",
        T1,
        "human",
        { item: "W1", summary: "Revise the example plan.", evidence: [] },
        { task_rev: latest.tasks[T1]?.rev },
      ),
    );
  const snapshot = (): Snapshot => {
    const lease = state.tasks[T1]?.items.W1?.lease;
    if (!lease) throw new Error("Missing fixture lease");
    return {
      schema: "skep.snapshot/v1",
      item: "W1",
      epoch: lease.epoch,
      attempt_id: lease.attempt_id,
      branch: lease.branch,
      base_sha: plan.base.commit,
      head_sha: "d".repeat(40),
      pushed: true,
      invocation_state: "interrupted",
      diffstat: { files: 1, insertions: 1, deletions: 0 },
      files_changed: ["example.txt"],
      check_runs: [],
      agent_note: null,
    };
  };
  const checkpoint = async (barrierId = state.tasks[T1]?.barrier?.id ?? null) =>
    publish(
      checkpointIntent({
        task_id: T1,
        actor: VPS,
        item: "W1",
        epoch: snapshot().epoch,
        barrier_id: barrierId,
        snapshot: snapshot(),
      }),
    );
  const activate = async (version: number) => {
    const next = samplePlan({ version, parent_version: version - 1 });
    next.base.repo = REPO;
    const proposal = planProposed(next);
    await publish((latest) =>
      draft("plan.proposed", T1, MAC, proposal, { task_rev: latest.tasks[T1]?.rev, owner_gen: 1 }),
    );
    await publish((latest) =>
      draft(
        "plan.approved",
        T1,
        "human",
        {
          plan_version: version,
          plan_hash: proposal.plan_hash,
        },
        { task_rev: latest.tasks[T1]?.rev, plan_version: version, plan_hash: proposal.plan_hash },
      ),
    );
  };
  await claim();
  return {
    log,
    state: () => state,
    time,
    clock,
    slot,
    journal,
    read,
    attempt,
    notify,
    duty,
    context,
    publish,
    claim,
    request,
    snapshot,
    checkpoint,
    activate,
  };
}

describe("coarse replan duty", () => {
  it("interrupts only its awaited holder once, passing the barrier id", async () => {
    const f = await fixture();
    await f.request();
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.attempt.interrupt).toHaveBeenCalledExactlyOnceWith(
      { task: T1, item: "W1", epoch: 1 },
      f.state().tasks[T1]?.barrier?.id,
    );
    await f.checkpoint();
    await f.duty(f.context());
    expect(f.attempt.interrupt).toHaveBeenCalledTimes(1);
    expect(f.state().tasks[T1]?.items.W1).toMatchObject({
      status: "interrupted",
      lease: { holder: VPS },
    });
  });

  it("retries interruption when the runner has not registered the attempt yet", async () => {
    const f = await fixture();
    f.attempt.interrupt.mockResolvedValueOnce(false);
    await f.request();
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.attempt.interrupt).toHaveBeenCalledTimes(2);
    expect(f.state().tasks[T1]?.status).toBe("interrupting");
  });

  it("an unrelated slot does not interrupt or close the barrier", async () => {
    const f = await fixture("mac");
    await f.request();
    f.slot.agent = "mac.coding.2";
    await f.duty(f.context());
    await f.time.advance(BARRIER_DEADLINE_MS);
    await f.duty(f.context());
    expect(f.attempt.interrupt).not.toHaveBeenCalled();
    expect(f.state().tasks[T1]?.status).toBe("interrupting");
  });

  it("uses exactly twenty monotonic minutes despite wall jumps and suspension", async () => {
    const f = await fixture("mac");
    await f.request();
    await f.duty(f.context());
    f.clock.setSkew(24 * 60 * 60_000);
    f.clock.suspend();
    await f.time.advance(BARRIER_DEADLINE_MS);
    f.clock.resume();
    await f.time.advance(BARRIER_DEADLINE_MS - 1);
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.status).toBe("interrupting");
    await f.time.advance(1);
    await f.duty(f.context());
    expect(f.log.events.at(-1)).toMatchObject({
      type: "barrier.closed",
      payload: { missing: ["W1"] },
    });
    expect(f.state().tasks[T1]?.items.W1).toMatchObject({ status: "unknown", lease: null });
    expect(f.state().tasks[T1]?.status).toBe("replanning");
  });

  it("drops a closure when a checkpoint settles the barrier during the write loop", async () => {
    const f = await fixture("mac");
    await f.request();
    await f.duty(f.context());
    await f.time.advance(BARRIER_DEADLINE_MS);
    const original = f.publish.getMockImplementation();
    if (!original) throw new Error("Missing publisher");
    const saved = f.snapshot();
    f.publish.mockImplementationOnce(async (intent) => {
      await original(
        checkpointIntent({
          task_id: T1,
          actor: VPS,
          item: "W1",
          epoch: 1,
          barrier_id: f.state().tasks[T1]?.barrier?.id ?? null,
          snapshot: saved,
        }),
      );
      return original(intent);
    });
    await f.duty(f.context());
    expect(f.log.events.some((event) => event?.type === "barrier.closed")).toBe(false);
    expect(f.state().tasks[T1]?.status).toBe("replanning");
  });

  it("fences a deadline intent after ownership changes", async () => {
    const f = await fixture("mac");
    await f.request();
    await f.duty(f.context());
    const stale = f.context();
    await f.publish((latest) =>
      draft(
        "owner.transferred",
        T1,
        "human",
        { new_owner: VPS },
        { task_rev: latest.tasks[T1]?.rev, owner_gen: 1 },
      ),
    );
    await f.time.advance(BARRIER_DEADLINE_MS);
    await f.duty(stale);
    expect(f.state().tasks[T1]?.status).toBe("interrupting");
    expect(f.log.events.some((event) => event?.type === "barrier.closed")).toBe(false);
  });

  it("keeps a deadline across coalesced requests and starts anew for the next barrier", async () => {
    const f = await fixture("mac");
    await f.request();
    await f.duty(f.context());
    await f.time.advance(10 * 60_000);
    await f.request();
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.replan_count).toBe(1);
    expect(f.state().tasks[T1]?.barrier?.requests).toHaveLength(2);
    await f.time.advance(10 * 60_000);
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.status).toBe("replanning");
    await f.activate(2);
    await f.claim();
    await f.request();
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.status).toBe("interrupting");
  });

  it("rebinds a stopped voluntary checkpoint to the new barrier", async () => {
    const f = await fixture();
    const saved = f.snapshot();
    await f.checkpoint(null);
    await f.request();
    f.attempt.interrupt.mockResolvedValue(false);
    f.read.mockResolvedValue([
      {
        step: "checkpointed",
        ts_mono: 0,
        ts_wall: "2026-10-05T00:00:00Z",
        result: { status: "checkpointed", snapshot: saved },
      },
    ]);
    await f.duty(f.context());
    expect(f.state().tasks[T1]?.status).toBe("replanning");
    expect(f.state().tasks[T1]?.items.W1?.last_checkpoint?.barrier_id).toBe(
      f.state().tasks[T1]?.barrier?.id,
    );
  });

  it("rejects a journal checkpoint bound to a different attempt", async () => {
    const f = await fixture();
    await f.request();
    f.attempt.interrupt.mockResolvedValue(false);
    f.read.mockResolvedValue([
      {
        step: "checkpointed",
        ts_mono: 0,
        ts_wall: "2026-10-05T00:00:00Z",
        result: { snapshot: { ...f.snapshot(), attempt_id: "att_other" } },
      },
    ]);
    await expect(f.duty(f.context())).rejects.toThrow("invalid checkpoint");
    expect(f.state().tasks[T1]?.status).toBe("interrupting");
  });

  it("waits for checkpoints on the third replan, then notifies the owner once", async () => {
    const f = await fixture("mac");
    for (let round = 1; round <= 3; round++) {
      await f.request();
      expect(f.state().tasks[T1]?.status).toBe("interrupting");
      await f.checkpoint();
      if (round < 3) {
        await f.activate(round + 1);
        await f.claim();
      }
    }
    expect(f.state().tasks[T1]?.status).toBe("escalated");
    await f.duty(f.context());
    await f.duty(f.context());
    expect(f.notify).toHaveBeenCalledOnce();
    expect(f.notify.mock.calls[0]?.[0]).toContain("skep decide");
    expect(f.notify.mock.calls[0]?.[0]).toContain("3 requests");
  });

  it("the third barrier also escalates when its holder misses the deadline", async () => {
    const f = await fixture("mac");
    for (let round = 1; round <= 2; round++) {
      await f.request();
      await f.checkpoint();
      await f.activate(round + 1);
      await f.claim();
    }
    await f.request();
    await f.duty(f.context());
    await f.time.advance(BARRIER_DEADLINE_MS);
    await f.duty(f.context());
    expect(f.state().tasks[T1]).toMatchObject({
      status: "escalated",
      replan_count: 3,
      escalation: { reason: "replans" },
    });
    expect(f.state().tasks[T1]?.items.W1).toMatchObject({ status: "unknown", lease: null });
    await f.duty(f.context());
    expect(f.notify).toHaveBeenCalledOnce();
  });
});

describe("verified daemon replan requests", () => {
  it("verifies an owner request against the explicit W2 epoch-7 invocation journal", async () => {
    const f = await fixture("mac");
    const invocationKey = { task: T1, item: "W2", epoch: 7 };
    const { id: _id, type: _type, ...facts } = evidence;
    f.read.mockImplementation(async (key) =>
      key.item === "W2" && key.epoch === 7
        ? [{ step: "command_run", ts_mono: 0, ts_wall: "2026-10-05T00:00:00Z", ...facts }]
        : [],
    );
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal: f.journal,
    });
    expect(
      await publishReplanRequest(
        {
          task: f.context().task,
          actor: MAC,
          item: null,
          report,
          evidenceKey: invocationKey,
        },
        { verifier, publisher: { publish: f.publish } },
      ),
    ).toMatchObject({ status: "accepted" });
    expect(f.read).toHaveBeenCalledWith(invocationKey);
    expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("drops mismatched invocation keys before verifying or publishing", async () => {
    const f = await fixture();
    const verifier = { verifyAll: vi.fn(async () => [evidence]) };
    for (const key of [
      { ...evidenceKey, item: "W2" },
      { ...evidenceKey, epoch: 2 },
      { ...evidenceKey, task: "T-20261005-ffff" },
    ]) {
      expect(
        await publishReplanRequest(
          {
            task: f.context().task,
            actor: VPS,
            item: "W1",
            report,
            evidenceKey: key,
          },
          { verifier, publisher: { publish: f.publish } },
        ),
      ).toMatchObject({ status: "dropped", reason: "stale" });
    }
    expect(verifier.verifyAll).not.toHaveBeenCalled();
    expect(f.state().tasks[T1]?.barrier).toBeNull();
  });

  it("fences a revoked holder even when that holder is also the owner", async () => {
    const f = await fixture();
    await f.publish((state) =>
      draft(
        "owner.transferred",
        T1,
        "human",
        { new_owner: VPS },
        { task_rev: state.tasks[T1]?.rev, owner_gen: 1 },
      ),
    );
    const task = f.context().task;
    const verifier = {
      verifyAll: async () => {
        await f.publish((state) =>
          draft(
            "lease.revoked",
            T1,
            "human",
            { item: "W1", epoch: 1, reason: "Move example work", observed_hb: null },
            { task_rev: state.tasks[T1]?.rev, item: "W1" },
          ),
        );
        return [evidence];
      },
    };
    expect(
      await publishReplanRequest(
        { task, actor: VPS, item: "W1", report, evidenceKey },
        { verifier, publisher: { publish: f.publish } },
      ),
    ).toMatchObject({ status: "dropped" });
    expect(f.state().tasks[T1]?.barrier).toBeNull();
  });

  it("drops fabricated evidence and publishes only locally verified facts", async () => {
    const f = await fixture();
    const git = { run: vi.fn() };
    const mirror = { mirrorPath: vi.fn() };
    const verifier = new EvidenceVerifier({ git, mirror, journal: f.journal });
    const input = { task: f.context().task, actor: VPS, item: "W1", report, evidenceKey };
    expect(
      await publishReplanRequest(input, { verifier, publisher: { publish: f.publish } }),
    ).toMatchObject({ status: "dropped", reason: "no_verified_evidence" });
    const { id: _id, type: _type, ...facts } = evidence;
    f.read.mockResolvedValue([
      { step: "command_run", ts_mono: 0, ts_wall: "2026-10-05T00:00:00Z", ...facts },
    ]);
    const mixed = {
      ...report,
      replan_request: {
        ...report.replan_request,
        summary: "Revise the example plan.",
        evidence: [evidence, { ...evidence, id: "ev_forged", exit: 0 }],
      },
    };
    await publishReplanRequest(
      { ...input, report: mixed },
      { verifier, publisher: { publish: f.publish } },
    );
    expect(f.log.events.at(-1)).toMatchObject({
      type: "replan.requested",
      actor: VPS,
      payload: { evidence: [evidence] },
    });
    expect(git.run).not.toHaveBeenCalled();
  });

  it("drops a request if the holder is fenced while evidence is being verified", async () => {
    const f = await fixture();
    const input = { task: f.context().task, actor: VPS, item: "W1", report, evidenceKey };
    const verifier = {
      verifyAll: async () => {
        await f.publish((latest) =>
          draft(
            "lease.revoked",
            T1,
            "human",
            {
              item: "W1",
              epoch: 1,
              reason: "Move the example work.",
              observed_hb: null,
            },
            { task_rev: latest.tasks[T1]?.rev, item: "W1" },
          ),
        );
        return [evidence];
      },
    };
    const result = await publishReplanRequest(input, {
      verifier,
      publisher: { publish: f.publish },
    });
    expect(result).toMatchObject({ status: "dropped" });
    expect(f.state().tasks[T1]?.barrier).toBeNull();
  });

  it("rejects extra model-output fields before verification or publication", async () => {
    const f = await fixture();
    const verifier = { verifyAll: vi.fn(async () => [evidence]) };
    await expect(
      publishReplanRequest(
        {
          task: f.context().task,
          actor: VPS,
          item: "W1",
          evidenceKey,
          report: { ...report, extra: true },
        },
        { verifier, publisher: { publish: f.publish } },
      ),
    ).rejects.toThrow();
    expect(verifier.verifyAll).not.toHaveBeenCalled();
  });

  it("redacts the request summary and drops evidence containing a secret", async () => {
    const f = await fixture();
    const secret = `sk-test-${"x".repeat(32)}`;
    const unsafe = { ...evidence, id: "ev_unsafe", run_id: secret };
    const verifier = { verifyAll: vi.fn(async () => [evidence, unsafe]) };
    await publishReplanRequest(
      {
        task: f.context().task,
        actor: VPS,
        item: "W1",
        evidenceKey,
        report: {
          ...report,
          replan_request: {
            summary: `Revise the example plan: ${secret}`,
            evidence: [evidence, unsafe],
          },
        },
      },
      { verifier, publisher: { publish: f.publish } },
    );
    expect(f.log.events.at(-1)).toMatchObject({
      type: "replan.requested",
      payload: { evidence: [evidence] },
    });
    expect(JSON.stringify(f.log.events.at(-1))).not.toContain(secret);
  });

  it("fences owner requests if ownership changes during evidence verification", async () => {
    const f = await fixture("mac");
    const task = f.context().task;
    const verifier = {
      verifyAll: async () => {
        await f.publish((latest) =>
          draft(
            "owner.transferred",
            T1,
            "human",
            { new_owner: VPS },
            { task_rev: latest.tasks[T1]?.rev, owner_gen: 1 },
          ),
        );
        return [evidence];
      },
    };
    expect(
      await publishReplanRequest(
        { task, actor: MAC, item: null, report, evidenceKey },
        { verifier, publisher: { publish: f.publish } },
      ),
    ).toMatchObject({ status: "dropped" });
    expect(f.state().tasks[T1]?.barrier).toBeNull();
  });
});
