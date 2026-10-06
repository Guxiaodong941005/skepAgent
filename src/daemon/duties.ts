import type { Publisher, PublishResult } from "../blackboard/publisher.js";
import { contentHash } from "../core/canonical.js";
import { claimIntent, draft, releaseIntent } from "../core/intents.js";
import type { State, TaskState } from "../core/reducer/state.js";
import { pendingReviews } from "../core/reducer/views.js";
import { type Plan, PlanSchema } from "../core/schemas/plan.js";
import { type Review, ReviewSchema } from "../core/schemas/review.js";
import type { AttemptInput, AttemptReplanHandler, AttemptRunner } from "../exec/attempt.js";
import type { PlanValidationContext } from "../exec/plan-validator.js";
import { validatePlan } from "../exec/plan-validator.js";
import { isCurrentLease, type LeaseIdentity } from "../lease/reverify.js";
import type { Clock } from "../util/clock.js";
import { newAttemptId, type RandomSource } from "../util/random.js";
import { type DeliveryDuty, deliveryDuty } from "./delivery.js";
import { publishReplanRequest, type ReplanDuty, replanDuty } from "./replan.js";
import { claimCandidates, type Slot, type SlotRegistry } from "./slots.js";

export interface DutiesDependencies {
  slots: SlotRegistry;
  clock: Clock;
  random: RandomSource;
  publisher: Pick<Publisher, "publish">;
  current(): State;
  plan(slot: Slot, task: TaskState, state: State, signal: AbortSignal): Promise<unknown>;
  review(slot: Slot, plan: Plan, hash: string, signal: AbortSignal): Promise<unknown>;
  verifyReview(review: Review, task: TaskState, slot: Slot): Promise<Review>;
  validation(slot: Slot, state: State, task: TaskState): PlanValidationContext;
  attempt(
    slot: Slot,
  ): Pick<AttemptRunner, "run" | "interrupt"> & Partial<Pick<AttemptRunner, "runWithReplan">>;
  onError(error: unknown): void;
  onWarning?: (message: string) => void;
  wake(): void;
  replan?: ReplanDuty;
  delivery?: DeliveryDuty;
  reviewTimeoutMs?: number;
  /** Persist stale before removing the invocation from scheduling. */
  recordStale(slot: Slot, lease: LeaseIdentity): Promise<unknown>;
}
interface ActiveAttempt {
  slot: Slot;
  key: string;
  input: AttemptInput;
  done: Promise<void>;
  stale: boolean;
}

export class DutyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DutyError";
  }
}

/** Long invocations run outside tick; reservations prevent repeated launches on each poll (§11.1). */
export class Duties {
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly attempts = new Map<string, ActiveAttempt>();
  private readonly reviewingSince = new Map<string, number>();
  private paused = false;
  constructor(private readonly deps: DutiesDependencies) {}
  heldLeases(): LeaseIdentity[] {
    return [...this.attempts.values()]
      .filter((attempt) => !attempt.stale)
      .map(({ input }) => ({ ...input.lease }));
  }
  setPaused(paused: boolean): void {
    this.paused = paused;
  }
  async settle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs.values()]);
  }
  async stop(): Promise<void> {
    this.paused = true;
    for (const controller of this.controllers.values()) controller.abort();
    for (const attempt of this.attempts.values())
      await this.deps.attempt(attempt.slot).interrupt({
        task: attempt.input.lease.task_id,
        item: attempt.input.lease.item,
        epoch: attempt.input.lease.epoch,
      });
    await this.settle();
  }
  async stopSlot(agent: string): Promise<void> {
    for (const [id, controller] of this.controllers)
      if (id.startsWith(`${agent}:`)) controller.abort();
    for (const attempt of this.attempts.values())
      if (attempt.slot.agent === agent)
        await this.deps.attempt(attempt.slot).interrupt({
          task: attempt.input.lease.task_id,
          item: attempt.input.lease.item,
          epoch: attempt.input.lease.epoch,
        });
    await Promise.all(
      [...this.jobs.entries()].filter(([id]) => id.startsWith(`${agent}:`)).map(([, job]) => job),
    );
  }
  async discardStale(state: State): Promise<void> {
    for (const attempt of this.attempts.values()) {
      const lease = attempt.input.lease;
      const task = state.tasks[lease.task_id];
      const item = task?.items[lease.item];
      // A successful delivery/failure clears its lease before the terminal journal fsync finishes.
      if (
        item?.delivered?.epoch === lease.epoch ||
        (item?.status === "failed" && task?.epochs[lease.item] === lease.epoch)
      )
        continue;
      // Barrier interruption belongs to SK-605; a parked attempt finishes its checkpoint first.
      if (
        task?.barrier &&
        task.items[lease.item]?.lease?.epoch === lease.epoch &&
        task.items[lease.item]?.lease?.holder === lease.holder
      )
        continue;
      if (isCurrentLease(state, lease) || attempt.stale) continue;
      await this.deps
        .attempt(attempt.slot)
        .interrupt({ task: lease.task_id, item: lease.item, epoch: lease.epoch });
      await this.deps.recordStale(attempt.slot, lease);
      attempt.stale = true;
    }
  }
  tick(state: State): void {
    for (const slot of this.deps.slots.list()) {
      if (!slot.enabled) continue;
      for (const task of Object.values(state.tasks).sort((a, b) =>
        a.task_id.localeCompare(b.task_id),
      )) {
        const context = {
          state,
          task,
          slot,
          nowMonoMs: this.deps.clock.monotonicMs(),
          publisher: this.deps.publisher,
        };
        if (task.barrier)
          this.launch(
            slot,
            `replan:${task.task_id}:${task.barrier.id}`,
            () =>
              (this.deps.replan ?? replanDuty)({ ...context, attempt: this.deps.attempt(slot) }),
            false,
          );
        // D15 may activate directly into delivered: route every task through the delivery hook.
        if (task.active_plan_version !== null)
          this.launch(
            slot,
            `delivery:${task.task_id}`,
            () => (this.deps.delivery ?? deliveryDuty)(context),
            false,
          );
        if (this.paused) continue;
        if (task.owner === slot.agent && ["planning", "replanning"].includes(task.status))
          this.plan(slot, task, state);
        if (task.owner === slot.agent && task.status === "reviewing")
          this.lockOrRevise(slot, task, state);
        if (
          task.owner === slot.agent &&
          task.status === "awaiting_approval" &&
          task.mode === "solo" &&
          task.plan_approval === "owner" &&
          !task.plans[String(task.current_plan_version)]?.plan.items.some(
            (item) => item.risk === "high",
          )
        )
          this.lock(slot, task);
      }
      if (this.paused) continue;
      for (const pending of pendingReviews(state, slot.agent)) {
        const task = state.tasks[pending.task_id];
        const record = task?.plans[String(pending.plan_version)];
        if (!task || !record) continue;
        this.launch(slot, `review:${task.task_id}:${record.version}`, async (signal) => {
          await this.deps.slots.probe(slot);
          if (signal.aborted) return;
          let review = ReviewSchema.parse(
            await this.deps.review(slot, record.plan, record.plan_hash, signal),
          );
          if (review.plan_version !== record.version || review.plan_hash !== record.plan_hash)
            throw new DutyError("Review output changed its plan binding");
          review = ReviewSchema.parse(await this.deps.verifyReview(review, task, slot));
          if (signal.aborted) return;
          const { schema: _schema, ...payload } = review;
          await this.deps.publisher.publish((latest) => {
            const current = latest.tasks[task.task_id];
            const plan = current?.plans[String(current.current_plan_version)];
            if (
              current?.status !== "reviewing" ||
              plan?.plan_hash !== record.plan_hash ||
              plan.reviews[slot.agent]
            )
              return null;
            return draft("review.submitted", task.task_id, slot.agent, payload, {
              task_rev: current.rev,
              plan_version: plan.version,
              plan_hash: plan.plan_hash,
            });
          });
        });
      }
      for (const candidate of claimCandidates(state, slot))
        this.claim(slot, candidate.task_id, candidate.item);
    }
  }
  private launch(
    slot: Slot,
    key: string,
    action: (signal: AbortSignal) => Promise<void>,
    reserve = true,
  ): void {
    const id = `${slot.agent}:${key}`;
    if (this.jobs.has(id) || (reserve && !this.deps.slots.reserve(slot, key))) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let failed = false;
    const job = Promise.resolve()
      .then(() => (controller.signal.aborted ? undefined : action(controller.signal)))
      .catch((error: unknown) => {
        failed = true;
        this.deps.onError(error);
      })
      .finally(() => {
        this.jobs.delete(id);
        this.controllers.delete(id);
        if (reserve) this.deps.slots.release(slot, key);
        if (reserve && !failed) this.deps.wake();
      });
    this.jobs.set(id, job);
  }
  private plan(slot: Slot, task: TaskState, state: State): void {
    this.launch(slot, `plan:${task.task_id}`, async (signal) => {
      await this.deps.slots.probe(slot);
      if (signal.aborted) return;
      const output = await this.deps.plan(slot, task, state, signal);
      if (signal.aborted) return;
      const { plan, reviewers, warnings } = await validatePlan(
        output,
        this.deps.validation(slot, state, task),
      );
      for (const warning of warnings) this.deps.onWarning?.(warning);
      const hash = contentHash(plan);
      await this.deps.publisher.publish((latest) => {
        const current = latest.tasks[task.task_id];
        if (
          !current ||
          current.owner !== slot.agent ||
          current.owner_gen !== task.owner_gen ||
          current.current_plan_version !== task.current_plan_version ||
          !["planning", "replanning", "reviewing"].includes(current.status)
        )
          return null;
        return draft(
          "plan.proposed",
          task.task_id,
          slot.agent,
          {
            version: plan.version,
            parent_version: plan.parent_version,
            plan,
            plan_hash: hash,
            base_commit: plan.base.commit,
            reviewers,
          },
          { task_rev: current.rev, owner_gen: current.owner_gen },
        );
      });
    });
  }
  private lockOrRevise(slot: Slot, task: TaskState, state: State): void {
    const record = task.plans[String(task.current_plan_version)];
    if (!record) return;
    const key = `${task.task_id}:${task.owner_gen}:${record.version}`;
    if (!this.reviewingSince.has(key)) this.reviewingSince.set(key, this.deps.clock.monotonicMs());
    const missing = record.reviewers.filter((reviewer) => !record.reviews[reviewer]);
    if (
      missing.length > 0 &&
      this.deps.clock.monotonicMs() - (this.reviewingSince.get(key) ?? 0) <
        (this.deps.reviewTimeoutMs ?? 15 * 60_000)
    )
      return;
    if (Object.values(record.reviews).some((review) => review.verdict === "block"))
      this.plan(slot, task, state);
    else this.lock(slot, task);
  }
  private lock(slot: Slot, task: TaskState): void {
    const record = task.plans[String(task.current_plan_version)];
    if (!record) return;
    this.launch(slot, `lock:${task.task_id}:${record.version}`, async () => {
      await this.deps.publisher.publish((latest) => {
        const current = latest.tasks[task.task_id];
        const plan = current?.plans[String(current.current_plan_version)];
        if (
          !current ||
          current.owner !== slot.agent ||
          current.owner_gen !== task.owner_gen ||
          plan?.plan_hash !== record.plan_hash ||
          !["reviewing", "awaiting_approval"].includes(current.status)
        )
          return null;
        return draft(
          "plan.locked",
          task.task_id,
          slot.agent,
          {
            plan_version: plan.version,
            plan_hash: plan.plan_hash,
            overrides: [],
            missing_reviews: plan.reviewers.filter((reviewer) => !plan.reviews[reviewer]),
          },
          {
            task_rev: current.rev,
            owner_gen: current.owner_gen,
            plan_version: plan.version,
            plan_hash: plan.plan_hash,
          },
        );
      });
    });
  }
  private claim(slot: Slot, taskId: string, itemId: string): void {
    const key = `attempt:${taskId}:${itemId}`;
    this.launch(slot, key, async (signal) => {
      await this.deps.slots.probe(slot);
      if (signal.aborted || this.paused) return;
      const attemptId = newAttemptId(this.deps.random);
      const result: PublishResult = await this.deps.publisher.publish(
        claimIntent({ task_id: taskId, item: itemId, actor: slot.agent, attempt_id: attemptId }),
      );
      if (result.status !== "accepted") return;
      const task = this.deps.current().tasks[taskId];
      const item = task?.items[itemId];
      const lease = item?.lease;
      if (
        !task ||
        !lease ||
        lease.attempt_id !== attemptId ||
        lease.holder !== slot.agent ||
        lease.interrupt !== null
      )
        return;
      if (signal.aborted || this.paused || !slot.enabled) {
        await this.deps.publisher.publish(
          releaseIntent({
            task_id: taskId,
            item: itemId,
            actor: slot.agent,
            epoch: lease.epoch,
            reason: "Slot stopped or paused before invocation",
          }),
        );
        return;
      }
      const plan = PlanSchema.parse(task.plans[String(task.active_plan_version)]?.plan);
      const predecessor = item.depends_on[0] ? task.items[item.depends_on[0]] : null;
      const input: AttemptInput = {
        lease: { task_id: taskId, item: itemId, epoch: lease.epoch, holder: slot.agent },
        attemptId,
        plan,
        baseSha: predecessor?.delivered?.head_sha ?? plan.base.commit,
        prBase:
          predecessor?.status === "merged"
            ? task.base_branch
            : (predecessor?.delivered?.branch ?? plan.base.branch),
        agentInstructions: slot.policy.body,
        repoContext: "",
        timeoutMs: slot.policy.frontMatter.budgets.max_invocation_minutes * 60_000,
        cliVersion: slot.policy.frontMatter.cli_version,
      };
      const id = `${slot.agent}:${key}`;
      const active: ActiveAttempt = { slot, key, input, done: Promise.resolve(), stale: false };
      this.attempts.set(id, active);
      try {
        const runner = this.deps.attempt(slot);
        active.done = (
          runner.runWithReplan
            ? runner.runWithReplan(input, attemptReplanHandler(this.deps, slot, task, itemId))
            : runner.run(input)
        ).then(() => undefined);
        await active.done;
      } finally {
        this.attempts.delete(id);
      }
    });
  }
}

/** Share the report path with simulation; accepted requests use the same duty as tick (§9.7). */
export function attemptReplanHandler(
  deps: Pick<DutiesDependencies, "publisher" | "current" | "clock" | "replan" | "wake" | "attempt">,
  slot: Slot,
  task: TaskState,
  item: string,
): AttemptReplanHandler {
  return async ({ report, evidenceKey, eventId, verifier }) => {
    const outcome = await publishReplanRequest(
      { task, actor: slot.agent, item, report, evidenceKey, eventId },
      { verifier, publisher: deps.publisher },
    );
    if (outcome.status === "accepted") {
      const state = deps.current();
      const current = state.tasks[task.task_id];
      if (current)
        await (deps.replan ?? replanDuty)({
          state,
          task: current,
          slot,
          nowMonoMs: deps.clock.monotonicMs(),
          publisher: deps.publisher,
          attempt: deps.attempt(slot),
        });
      deps.wake();
    }
    return outcome;
  };
}
