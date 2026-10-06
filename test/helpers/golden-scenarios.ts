import { createHash } from "node:crypto";
import { contentHash } from "../../src/core/canonical.js";
import { eventPath, workBranch } from "../../src/core/ids.js";
import type { LogEntry, SignatureCheck } from "../../src/core/log.js";
import { applyEntry, replay } from "../../src/core/reducer/replay.js";
import type { ItemState, State, TaskState } from "../../src/core/reducer/state.js";
import { DEFAULT_BUDGETS } from "../../src/core/schemas/common.js";
import {
  EVENT_SCHEMA,
  type PayloadOf,
  type Pre,
  type SkepEvent,
  serializeEvent,
} from "../../src/core/schemas/events.js";
import type { Evidence } from "../../src/core/schemas/evidence.js";
import type { Genesis } from "../../src/core/schemas/genesis.js";
import type { Plan, PlanItem } from "../../src/core/schemas/plan.js";

/**
 * Hand-built blackboard logs behind the golden fixtures (SK-305, ARCHITECTURE §14).
 *
 * Each scenario is a script of events the reducer accepts, plus the forged entries the "forged"
 * scenario plants. Event ids and commit shas come from the scenario name and the seq, so a script
 * always produces the same log. The scripts read the reducer's state for preconditions; they do
 * not re-implement handler rules, and a step the reducer rejects throws rather than landing.
 */

const MAC = "mac.coding";
const VPS = "vps.coding";

const REPO = "git@example.invalid:example/app.git";
const BRANCH = "main";
const AT = "2026-10-05T09:00:00Z";

export interface Scenario {
  name: string;
  /** One sentence describing the path the log pins, for the fixture header. */
  summary: string;
  entries: LogEntry[];
}

export function buildScenarios(): Scenario[] {
  return [solo(), team(), replan(), escalate(), forged(), verifyFailResume()];
}

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

/** Solo task, one item, human approval, delivery, verification, merge: planning → done. */
function solo(): Scenario {
  const log = new Script("solo");
  log.register(VPS);
  const task = log.createTask("solo", VPS);
  log.propose(task, "solo", [item("W1", VPS, [])]);
  log.approve();
  log.claim("W1");
  log.deliver("W1");
  log.verify(true);
  log.merge("W1");
  return log.scenario("Solo task from proposal through delivery, verification and merge to done.");
}

/** Team task: peer review, lock, stacked delivery by two agents, verification, both merges. */
function team(): Scenario {
  const log = new Script("team");
  log.register(VPS, 1);
  log.register(MAC, 1);
  const task = log.createTask("team", VPS);
  log.propose(task, "team", [item("W1", VPS, []), item("W2", MAC, ["W1"])]);
  log.review("approve");
  log.lock();
  log.approve();
  log.claim("W1");
  log.deliver("W1");
  log.claim("W2");
  log.deliver("W2");
  log.verify(true);
  log.merge("W1");
  log.merge("W2");
  return log.scenario(
    "Team stack reviewed, locked, delivered by both agents, verified and merged.",
  );
}

/**
 * One replan inside budget: the leased item checkpoints, a replacement plan adds a fix item on
 * top of the carried-over delivery, and the new item is delivered.
 */
function replan(): Scenario {
  const log = new Script("replan");
  log.register(VPS, 2);
  log.register(MAC, 1);
  // Two items so one can be delivered and carried over (D7) while the other still holds the lease
  // the barrier waits on. A solo plan may have only one item (D13), so this task is team.
  const task = log.createTask("team", VPS, { replans: 2 });
  log.propose(task, "team", [item("W1", VPS, []), item("W2", MAC, ["W1"])]);
  log.review("approve");
  log.lock();
  log.approve();
  log.claim("W1");
  log.deliver("W1");
  log.claim("W2");
  log.requestReplan();
  log.checkpoint("W2");
  const fix: PlanItem = {
    ...item("W2", VPS, ["W1"]),
    title: "Fix the gap the first delivery left",
  };
  log.propose(
    task,
    "team",
    // W1 is byte-for-byte the same item, so its delivery carries over (D7) and activation lands on
    // `executing` rather than `delivered` because the replacement W2 is still ready (D15).
    [item("W1", VPS, []), fix],
    "Keep the delivered item; replace the rest with a fix item.",
  );
  log.review("approve");
  log.lock();
  log.approve();
  log.claim("W2");
  log.deliver("W2");
  return log.scenario(
    "One in-budget replan carries the delivered item over (D7) and delivers the replacement (D15).",
  );
}

/** Replan budget 1: the second request opens an escalating barrier and settles into escalated. */
function escalate(): Scenario {
  const log = new Script("escalate");
  log.register(VPS);
  const task = log.createTask("solo", VPS, { replans: 1 });
  log.propose(task, "solo", [item("W1", VPS, [])]);
  log.approve();
  log.claim("W1");
  log.requestReplan();
  log.checkpoint("W1");
  log.propose(task, "solo", [item("W1", VPS, [])], "Same item, second attempt.");
  log.approve();
  log.claim("W1");
  log.requestReplan();
  log.checkpoint("W1");
  return log.scenario(
    "The replan past the budget escalates once its barrier checkpoint settles (D5, D20).",
  );
}

/**
 * A valid solo delivery, then one of every forgery the reducer must ignore: unsigned, bad
 * signature, unknown key, a daemon principal signing a human event, and a stale observed tip.
 */
function forged(): Scenario {
  const log = new Script("forged");
  log.register(VPS);
  const task = log.createTask("solo", VPS);
  log.propose(task, "solo", [item("W1", VPS, [])]);
  log.approve();
  log.claim("W1");
  log.deliver("W1");
  log.forge("missing");
  log.forge("bad");
  log.forge("unknown_key");
  log.forge("unauthorized");
  log.forge("stale_tip");
  return log.scenario(
    "Forged commits (unsigned, bad signature, unknown key, unauthorized, stale tip) are no-ops.",
  );
}

/**
 * D14/D15: a failed top-of-stack verification escalates with reason `verification_failed`; the
 * human resumes, the owner re-verifies, the human merges, and the task is done.
 */
function verifyFailResume(): Scenario {
  const log = new Script("verify-fail-resume");
  log.register(VPS);
  const task = log.createTask("solo", VPS);
  log.propose(task, "solo", [item("W1", VPS, [])]);
  log.approve();
  log.claim("W1");
  log.deliver("W1");
  log.verify(false);
  log.decide("resume_with_plan");
  log.verify(true);
  log.merge("W1");
  return log.scenario(
    "Failed verification escalates; resume, re-verification and merge reach done (D14/D15).",
  );
}

// ---------------------------------------------------------------------------------------------
// Script: append events against the reducer's current state.
// ---------------------------------------------------------------------------------------------

interface BudgetOverrides {
  replans?: number;
  review_rounds?: number;
  item_retries?: number;
}

class Script {
  readonly entries: LogEntry[] = [];
  private state: State;

  constructor(private readonly name: string) {
    const genesis: Genesis = {
      schema: "skep.genesis/v1",
      protocol_version: 1,
      reducer_version: 1,
      blackboard_id: "bb_golden01",
      created_at: "2026-10-05T00:00:00Z",
    };
    this.entries.push({
      seq: 0,
      sha: sha(`${name}:genesis`),
      parents: [],
      signature: { status: "good", principal: "human" },
      changes: [{ status: "A", path: "skep.json" }],
      added: { "skep.json": `${JSON.stringify(genesis, null, 2)}\n` },
    });
    this.state = replay(this.entries);
  }

  scenario(summary: string): Scenario {
    return { name: this.name, summary, entries: this.entries };
  }

  register(agent: string, maxParallel = 1): void {
    this.step(
      built("agent.registered", {
        task_id: null,
        actor: agent,
        payload: {
          role: "coding",
          agent_cli: "codex",
          cli_version: "0.0.0-test",
          capabilities: ["typescript"],
          requires_local: [],
          max_parallel_items: maxParallel,
        },
      }),
    );
  }

  createTask(mode: "solo" | "team", owner: string, budgets: BudgetOverrides = {}): TaskState {
    this.step(
      built("task.created", {
        task_id: taskId(0),
        actor: "human",
        payload: {
          title: "Ship the requested change",
          body: "Implement the change described by the human and cover it with the unit check.",
          repo: REPO,
          base_branch: BRANCH,
          mode,
          owner,
          budgets: { ...DEFAULT_BUDGETS, ...budgets },
          plan_approval: "human",
        },
      }),
    );
    return this.task();
  }

  propose(
    task: TaskState,
    mode: "solo" | "team",
    items: PlanItem[],
    changes: string | null = null,
  ): void {
    const version = (this.task().current_plan_version ?? 0) + 1;
    const plan: Plan = {
      schema: "skep.plan/v1",
      task_id: task.task_id,
      version,
      parent_version: version === 1 ? null : version - 1,
      base: { repo: REPO, branch: BRANCH, commit: sha(`${this.name}:base`) },
      mode,
      summary: `Plan version ${version} for ${task.task_id}.`,
      items,
      stack_order: items.map((entry) => entry.id),
      changes_from_parent: version === 1 ? null : changes,
    };
    const reviewers = mode === "team" ? [MAC] : [];
    this.step(
      built("plan.proposed", {
        task_id: task.task_id,
        actor: this.task().owner,
        pre: { task_rev: this.task().rev, owner_gen: this.task().owner_gen },
        payload: {
          version,
          parent_version: version === 1 ? null : version - 1,
          plan,
          plan_hash: contentHash(plan),
          base_commit: plan.base.commit,
          reviewers,
        },
      }),
    );
  }

  review(verdict: "approve" | "block"): void {
    const plan = this.plan();
    const reviewer = plan.reviewers[0];
    if (!reviewer) throw new Error(`${this.name}: plan v${plan.version} has no reviewer`);
    this.step(
      built("review.submitted", {
        task_id: this.task().task_id,
        actor: reviewer,
        pre: { task_rev: this.task().rev, plan_version: plan.version, plan_hash: plan.plan_hash },
        payload: {
          plan_version: plan.version,
          plan_hash: plan.plan_hash,
          verdict,
          blockers: verdict === "block" ? [blocker(this.state)] : [],
          suggestions: [],
        },
      }),
    );
  }

  lock(): void {
    const plan = this.plan();
    const missing = plan.reviewers.filter((reviewer) => !plan.reviews[reviewer]);
    this.step(
      built("plan.locked", {
        task_id: this.task().task_id,
        actor: this.task().owner,
        pre: {
          task_rev: this.task().rev,
          owner_gen: this.task().owner_gen,
          plan_version: plan.version,
          plan_hash: plan.plan_hash,
        },
        payload: {
          plan_version: plan.version,
          plan_hash: plan.plan_hash,
          overrides: [],
          missing_reviews: missing,
        },
      }),
    );
  }

  approve(): void {
    const plan = this.plan();
    this.step(
      built("plan.approved", {
        task_id: this.task().task_id,
        actor: "human",
        pre: { task_rev: this.task().rev, plan_version: plan.version, plan_hash: plan.plan_hash },
        payload: { plan_version: plan.version, plan_hash: plan.plan_hash, note: "Approved." },
      }),
    );
  }

  claim(id: string): void {
    const task = this.task();
    const itemState = this.item(id);
    const plan = task.plans[String(task.active_plan_version)];
    if (!plan) throw new Error(`${this.name}: no active plan to claim ${id} against`);
    const epoch = task.epochs[id] ?? 0;
    this.step(
      built("lease.claimed", {
        task_id: task.task_id,
        actor: itemState.assignee,
        pre: {
          task_rev: task.rev,
          plan_version: plan.version,
          plan_hash: plan.plan_hash,
          item: id,
          expected_epoch: epoch,
        },
        payload: {
          item: id,
          attempt_id: `att_${String(this.entries.length).padStart(2, "0")}`,
          branch: workBranch(task.task_id, id, epoch + 1),
        },
      }),
    );
  }

  deliver(id: string): void {
    const itemState = this.item(id);
    const lease = itemState.lease;
    if (!lease) throw new Error(`${this.name}: ${id} has no lease to deliver`);
    const pr = this.nextPr();
    const head = sha(`${this.name}:head:${id}:e${lease.epoch}`);
    this.step(
      built("work.delivered", {
        task_id: this.task().task_id,
        actor: lease.holder,
        pre: { task_rev: this.task().rev, item: id },
        payload: {
          item: id,
          epoch: lease.epoch,
          branch: lease.branch,
          head_sha: head,
          pr_url: `https://example.com/example/app/pull/${pr}`,
          pr_number: pr,
          check_runs: [checkRun(head)],
        },
      }),
    );
  }

  verify(passed: boolean): void {
    const task = this.task();
    const plan = task.plans[String(task.active_plan_version)];
    const top = plan?.plan.stack_order.at(-1);
    const head = top ? task.items[top]?.delivered?.head_sha : undefined;
    if (!plan || !head) throw new Error(`${this.name}: nothing delivered to verify`);
    this.step(
      built("task.verified", {
        task_id: task.task_id,
        actor: task.owner,
        pre: { task_rev: task.rev, owner_gen: task.owner_gen, plan_hash: plan.plan_hash },
        payload: { top_of_stack_sha: head, check_runs: [checkRun(head)], passed },
      }),
    );
  }

  merge(id: string): void {
    const delivered = this.item(id).delivered;
    if (!delivered) throw new Error(`${this.name}: ${id} was never delivered`);
    this.step(
      built("item.merged", {
        task_id: this.task().task_id,
        actor: "human",
        pre: { task_rev: this.task().rev, item: id },
        payload: {
          item: id,
          pr_number: delivered.pr_number,
          merge_sha: sha(`${this.name}:merge:${id}`),
        },
      }),
    );
  }

  requestReplan(): void {
    const task = this.task();
    const leased = Object.values(task.items).find((entry) => entry.status === "leased");
    this.step(
      built("replan.requested", {
        task_id: task.task_id,
        actor: task.owner,
        pre: { task_rev: task.rev },
        payload: {
          summary: "The plan no longer matches what the code needs.",
          evidence: [evidenceOf(this.state)],
          item: leased?.id ?? null,
        },
      }),
    );
  }

  checkpoint(id: string): void {
    const task = this.task();
    const lease = this.item(id).lease;
    const barrier = task.barrier;
    if (!lease || !barrier) throw new Error(`${this.name}: ${id} has no lease or open barrier`);
    const head = sha(`${this.name}:ckpt:${id}:e${lease.epoch}`);
    this.step(
      built("checkpoint.recorded", {
        task_id: task.task_id,
        actor: lease.holder,
        pre: { task_rev: task.rev, item: id },
        payload: {
          item: id,
          epoch: lease.epoch,
          barrier_id: barrier.id,
          snapshot: {
            schema: "skep.snapshot/v1",
            item: id,
            epoch: lease.epoch,
            attempt_id: lease.attempt_id,
            branch: lease.branch,
            base_sha: sha(`${this.name}:base`),
            head_sha: head,
            pushed: true,
            invocation_state: "interrupted",
            diffstat: { files: 1, insertions: 1, deletions: 0 },
            files_changed: [`src/${id.toLowerCase()}/`],
            check_runs: [],
            agent_note: null,
          },
        },
      }),
    );
  }

  decide(decision: PayloadOf<"human.decided">["decision"]): void {
    this.step(
      built("human.decided", {
        task_id: this.task().task_id,
        actor: "human",
        pre: { task_rev: this.task().rev },
        payload: { decision, note: "Decided after escalation." },
      }),
    );
  }

  /**
   * A commit the reducer must ignore (ARCHITECTURE §5.3 steps 1–3, §5.4). Appended
   * unconditionally: its outcome is `invalid` or `rejected` and nothing in the task moves.
   */
  forge(kind: "missing" | "bad" | "unknown_key" | "unauthorized" | "stale_tip"): void {
    const task = this.task();
    const ev = built("task.cancelled", {
      task_id: task.task_id,
      actor: "human",
      observedTip: kind === "stale_tip" ? sha(`${this.name}:stale`) : this.tip,
      pre: { task_rev: task.rev },
      payload: { reason: "Forged cancellation." },
      eventId: eventId(`${this.name}:${this.entries.length}`),
    });
    const signature: SignatureCheck =
      kind === "missing"
        ? { status: "missing" }
        : kind === "bad"
          ? { status: "bad", detail: "forged signature" }
          : kind === "unknown_key"
            ? { status: "unknown_key", detail: "not in allowed_signers" }
            : kind === "unauthorized"
              ? { status: "good", principal: "daemon:mac" }
              : { status: "good", principal: "human" };
    this.appendRaw(ev, signature);
  }

  private step(ev: SkepEvent): void {
    this.appendRaw(this.stamp(ev), signerFor(ev.actor));
    const outcome = this.state.outcomes.at(-1);
    if (outcome?.outcome !== "accepted") {
      throw new Error(
        `${this.name}: ${ev.type} at seq ${outcome?.seq} was ${outcome?.outcome}` +
          ` (${outcome?.reason})`,
      );
    }
  }

  /** Fill the seq-derived event id and the current tip once the entry position is known. */
  private stamp(ev: SkepEvent): SkepEvent {
    return {
      ...ev,
      event_id:
        ev.event_id === eventId("pending")
          ? eventId(`${this.name}:${this.entries.length}`)
          : ev.event_id,
      observed_tip: ev.observed_tip === "" ? this.tip : ev.observed_tip,
    } as SkepEvent;
  }

  private appendRaw(ev: SkepEvent, signature: SignatureCheck): void {
    const path = eventPath(ev.task_id, ev.event_id);
    this.entries.push({
      seq: this.entries.length,
      sha: sha(`${this.name}:commit:${this.entries.length}`),
      parents: [this.tip],
      signature,
      changes: [{ status: "A", path }],
      added: { [path]: serializeEvent(ev) },
    });
    this.state = applyEntry(this.state, this.entries[this.entries.length - 1] as LogEntry);
  }

  private get tip(): string {
    return this.entries[this.entries.length - 1]?.sha ?? "";
  }

  private task(): TaskState {
    const task = this.taskOrNull();
    if (!task) throw new Error(`${this.name}: no task in state`);
    return task;
  }

  private taskOrNull(): TaskState | undefined {
    return this.state.tasks[taskId(0)];
  }

  private plan() {
    const task = this.task();
    const plan = task.plans[String(task.current_plan_version)];
    if (!plan) throw new Error(`${this.name}: no current plan`);
    return plan;
  }

  private item(id: string): ItemState {
    const itemState = this.task().items[id];
    if (!itemState) throw new Error(`${this.name}: item ${id} missing`);
    return itemState;
  }

  private nextPr(): number {
    let max = 0;
    for (const task of Object.values(this.state.tasks)) {
      for (const itemState of Object.values(task.items)) {
        if (itemState.delivered && itemState.delivered.pr_number > max) {
          max = itemState.delivered.pr_number;
        }
      }
    }
    return max + 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Event assembly
// ---------------------------------------------------------------------------------------------

interface Built<T extends keyof PayloadMap> {
  type: T;
  task_id: string | null;
  actor: string;
  payload: PayloadMap[T];
  pre?: Pre;
  observedTip?: string;
  eventId?: string;
}

interface PayloadMap {
  "agent.registered": PayloadOf<"agent.registered">;
  "task.created": PayloadOf<"task.created">;
  "task.cancelled": PayloadOf<"task.cancelled">;
  "plan.proposed": PayloadOf<"plan.proposed">;
  "review.submitted": PayloadOf<"review.submitted">;
  "plan.locked": PayloadOf<"plan.locked">;
  "plan.approved": PayloadOf<"plan.approved">;
  "lease.claimed": PayloadOf<"lease.claimed">;
  "work.delivered": PayloadOf<"work.delivered">;
  "replan.requested": PayloadOf<"replan.requested">;
  "checkpoint.recorded": PayloadOf<"checkpoint.recorded">;
  "item.merged": PayloadOf<"item.merged">;
  "task.verified": PayloadOf<"task.verified">;
  "human.decided": PayloadOf<"human.decided">;
}

function built<T extends keyof PayloadMap>(type: T, spec: Omit<Built<T>, "type">): SkepEvent {
  return {
    schema: EVENT_SCHEMA,
    event_id: spec.eventId ?? eventId("pending"),
    type,
    task_id: spec.task_id,
    actor: spec.actor,
    observed_tip: spec.observedTip ?? "",
    pre: spec.pre ?? {},
    created_at: AT,
    lang: "en",
    payload: spec.payload,
  } as SkepEvent;
}

function item(id: string, assignee: string, dependsOn: string[]): PlanItem {
  return {
    id,
    title: `Implement ${id}`,
    role: "coding",
    assignee,
    depends_on: dependsOn,
    touches: [`src/${id.toLowerCase()}/`],
    risk: "normal",
    acceptance: [{ kind: "check", name: "unit" }],
  };
}

function signerFor(actor: string): SignatureCheck {
  return {
    status: "good",
    principal: actor === "human" ? "human" : `daemon:${actor.split(".")[0]}`,
  };
}

function blocker(state: State): PayloadOf<"review.submitted">["blockers"][number] {
  return {
    id: "B1",
    claim: "The acceptance check does not cover the changed path.",
    evidence: [evidenceOf(state)],
  };
}

function evidenceOf(state: State): Evidence {
  return {
    id: "ev_check_1",
    type: "check_run",
    run_id: "run-1",
    check: "unit",
    sha: sha(`evidence:${state.seq}`),
    exit: 1,
    log_sha256: "ab".repeat(32),
  };
}

function checkRun(head: string): PayloadOf<"work.delivered">["check_runs"][number] {
  return {
    run_id: "run-1",
    check: "unit",
    sha: head,
    exit: 0,
    duration_ms: 10,
    passed: 1,
    failed: 0,
    log_sha256: sha(`log:${head}`).padEnd(64, "0").slice(0, 64),
  };
}

function sha(label: string): string {
  return createHash("sha1").update(label).digest("hex");
}

function eventId(key: string): string {
  const hex = createHash("sha256").update(`golden:${key}`).digest("hex");
  return (
    `evt_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}` +
    `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

function taskId(n: number): string {
  return `T-20261005-${n.toString(16).padStart(4, "0")}`;
}
