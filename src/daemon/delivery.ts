import { z } from "zod";
import type { CodeHost } from "../codehost/types.js";
import { workBranch } from "../core/ids.js";
import { draft, type Intent } from "../core/intents.js";
import type { State, TaskState } from "../core/reducer/state.js";
import { CheckRunSchema, ShaSchema } from "../core/schemas/common.js";
import { type PayloadOf, TaskVerifiedPayload } from "../core/schemas/events.js";
import type { ChecksRunner } from "../exec/checks.js";
import { verificationKey } from "../exec/journal.js";
import { findSecrets } from "../exec/redact.js";
import type { CodeMirror } from "../exec/worktree.js";
import type { GitRunner } from "../git/runner.js";
import type { Clock } from "../util/clock.js";
import type { Slot } from "./slots.js";

export interface DeliveryDutyDependencies {
  clock: Clock;
  git: GitRunner;
  mirror(slot: Slot): CodeMirror;
  checks(slot: Slot): ChecksRunner;
  codeHost(slot: Slot): CodeHost;
  notify(message: string): Promise<void>;
}

/** Publication re-evaluates intents against a fresh blackboard observation (§7.2). */
export interface DeliveryDutyContext {
  state: State;
  task: TaskState;
  slot: Slot;
  nowMonoMs: number;
  publisher: { publish(intent: Intent): Promise<unknown> };
}
export type DeliveryDuty = (context: DeliveryDutyContext) => Promise<void>;
/** Dependency-free fallback for callers without code-repository services. */
export const deliveryDuty: DeliveryDuty = async () => {};

export class DeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeliveryError";
  }
}

const PrStateSchema = z.strictObject({
  state: z.enum(["open", "closed", "merged"]),
  mergeSha: ShaSchema.nullable(),
});
const AcceptedSchema = z.object({
  status: z.literal("accepted"),
  seq: z.number().int().optional(),
});

// A resume re-activates the same hash, so the hash alone cannot identify a verification (D15).
function activationKey(state: State, task: TaskState): string {
  const activation = state.outcomes.findLast(
    (outcome) =>
      outcome.task_id === task.task_id &&
      outcome.outcome === "accepted" &&
      ["plan.approved", "plan.locked", "human.decided"].includes(outcome.type ?? ""),
  );
  return `${task.owner_gen}:${task.plans[String(task.active_plan_version)]?.plan_hash}:${activation?.seq ?? task.created_seq}`;
}

function samePlan(current: TaskState | undefined, task: TaskState): current is TaskState {
  return (
    current !== undefined &&
    current.owner_gen === task.owner_gen &&
    current.active_plan_version === task.active_plan_version &&
    current.plans[String(current.active_plan_version)]?.plan_hash ===
      task.plans[String(task.active_plan_version)]?.plan_hash
  );
}

function epochKey(task: TaskState, item: string, epoch: number): string {
  return `${task.task_id}:${item}:${epoch}`;
}

function preservedBranches(task: TaskState, id: string): string[] {
  if (task.status === "cancelled") return [];
  const item = task.items[id];
  return [...new Set([item?.lease?.branch, item?.delivered?.branch])]
    .filter((branch): branch is string => branch !== undefined)
    .sort();
}

function staleEpochsKey(task: TaskState): string {
  // Cancellation, lease release and removal can make an epoch stale without incrementing its
  // counter. Include authority over its branches, but ignore unrelated task revisions (D7).
  return JSON.stringify(
    Object.keys(task.epochs)
      .sort()
      .map((id) => [id, task.epochs[id], preservedBranches(task, id)]),
  );
}

export function createDeliveryDuty(deps: DeliveryDutyDependencies): DeliveryDuty {
  const verifications = new Map<
    string,
    { key: string; result: Promise<PayloadOf<"task.verified">>; published: boolean }
  >();
  const notified = new Set<string>();
  const terminalPrs = new Map<
    string,
    { number: number; observed: z.infer<typeof PrStateSchema> }
  >();
  const retargeted = new Set<string>();
  const settledEpochs = new Set<string>();
  const staleScans = new Map<string, string>();
  let checkout = 0;

  const notifyFailure = async (task: TaskState, seq: number) => {
    const key = `${task.task_id}:${task.owner_gen}:${seq}`;
    if (notified.has(key)) return;
    await deps.notify(
      `Task ${task.task_id} failed top-of-stack verification. Inspect task.verified check runs and choose resume, replan, or cancel.`,
    );
    notified.add(key);
  };

  const verify = async ({ state, task, slot, publisher }: DeliveryDutyContext) => {
    if (task.owner !== slot.agent || task.status !== "delivered" || task.verified !== null) return;
    const record = task.plans[String(task.active_plan_version)];
    const top = record?.plan.stack_order.at(-1);
    const delivery = top ? task.items[top]?.delivered : null;
    if (!record || !top || !delivery)
      throw new DeliveryError(`Task ${task.task_id} has no delivered top-of-stack SHA`);
    const key = activationKey(state, task);
    let cached = verifications.get(task.task_id);
    if (cached?.key !== key) {
      const result = (async () => {
        const mirror = deps.mirror(slot);
        const path = `verification/${task.task_id}/g${task.owner_gen}-p${record.version}-r${task.rev}-${Math.floor(deps.clock.monotonicMs())}-${checkout++}`;
        const branch = `skep/${path}`;
        // CodeMirror hands checkout content to the agent user; trusted checks keep agentEnv (D19).
        const worktree = await mirror.createWorktree({
          repo: task.repo,
          baseSha: delivery.head_sha,
          branch,
          path,
        });
        try {
          // PRD §9.8: the union includes checks of every item, including carried-over merged items.
          const names = [
            ...new Set(
              record.plan.items.flatMap((item) =>
                item.acceptance.flatMap((criterion) =>
                  criterion.kind === "check" ? [criterion.name] : [],
                ),
              ),
            ),
          ];
          const runs = [];
          const runner = deps.checks(slot);
          for (let offset = 0; offset < names.length; offset += 32) {
            const checks = names.slice(offset, offset + 32);
            const batch = z.array(CheckRunSchema).parse(
              await runner.run({
                repo: task.repo,
                baseCommit: record.base_commit,
                worktree: worktree.path,
                checks,
                attempt: verificationKey(task.task_id, key),
              }),
            );
            if (
              batch.length !== checks.length ||
              batch.some(
                (run, index) => run.sha !== delivery.head_sha || run.check !== checks[index],
              )
            )
              throw new DeliveryError(
                `Task ${task.task_id} checks lack evidence at the delivered SHA`,
              );
            runs.push(...batch);
          }
          const payload = TaskVerifiedPayload.parse({
            top_of_stack_sha: delivery.head_sha,
            check_runs: runs,
            passed: runs.every((run) => run.exit === 0 && (run.failed ?? 0) === 0),
          });
          if (findSecrets(JSON.stringify(payload)).length > 0)
            throw new DeliveryError(`Task ${task.task_id} verification contains a secret pattern`);
          return payload;
        } finally {
          await mirror.removeWorktree({ repo: task.repo, path, force: true });
          await deps.git.run(["-c", "core.hooksPath=/dev/null", "branch", "-D", "--", branch], {
            cwd: worktree.mirrorDir,
          });
        }
      })();
      cached = { key, result, published: false };
      verifications.set(task.task_id, cached);
    }
    if (cached.published) return;
    let payload: PayloadOf<"task.verified">;
    try {
      payload = await cached.result;
    } catch (error) {
      if (verifications.get(task.task_id) === cached) verifications.delete(task.task_id);
      throw error;
    }
    const result = AcceptedSchema.safeParse(
      await publisher.publish((latest) => {
        const current = latest.tasks[task.task_id];
        if (
          !samePlan(current, task) ||
          current.owner !== slot.agent ||
          current.status !== "delivered" ||
          current.verified !== null ||
          activationKey(latest, current) !== key ||
          current.items[top]?.delivered?.head_sha !== delivery.head_sha
        )
          return null;
        return draft("task.verified", task.task_id, slot.agent, payload, {
          task_rev: current.rev,
          owner_gen: current.owner_gen,
          plan_hash: record.plan_hash,
        });
      }),
    );
    if (result.success) {
      cached.published = true;
      if (!payload.passed && result.data.seq !== undefined)
        await notifyFailure(task, result.data.seq);
    }
  };

  const observeMerges = async ({ task, slot, publisher }: DeliveryDutyContext, host: CodeHost) => {
    if (!["executing", "delivered", "escalated"].includes(task.status)) return;
    const record = task.plans[String(task.active_plan_version)];
    if (!record) return;
    const merged = new Set(
      record.plan.stack_order.filter((id) => task.items[id]?.status === "merged"),
    );
    for (const [index, id] of record.plan.stack_order.entries()) {
      const item = task.items[id];
      const delivery = item?.delivered;
      if (item?.status !== "delivered" || !delivery || delivery.submit.pr_number === undefined)
        continue;
      const prNumber = delivery.submit.pr_number;
      const key = epochKey(task, id, delivery.epoch);
      const cached = terminalPrs.get(key);
      const observed =
        cached?.number === prNumber
          ? cached.observed
          : PrStateSchema.parse(await host.prState(task.repo, prNumber));
      // Retain terminal evidence even when publication fails; the fenced intent still retries.
      if (observed.state === "closed") terminalPrs.set(key, { number: prNumber, observed });
      if (observed.state === "merged") {
        if (!observed.mergeSha) throw new DeliveryError(`Merged PR #${prNumber} lacks a merge SHA`);
        terminalPrs.set(key, { number: prNumber, observed });
        const mergeSha = observed.mergeSha;
        const result = AcceptedSchema.safeParse(
          await publisher.publish((latest) => {
            const current = latest.tasks[task.task_id];
            const latestItem = current?.items[id];
            if (
              !samePlan(current, task) ||
              !["executing", "delivered", "escalated"].includes(current.status) ||
              latestItem?.status !== "delivered" ||
              latestItem.delivered?.submit.pr_number !== prNumber ||
              latestItem.delivered.epoch !== delivery.epoch ||
              latestItem.delivered.branch !== delivery.branch ||
              latestItem.delivered.head_sha !== delivery.head_sha
            )
              return null;
            return draft(
              "item.merged",
              task.task_id,
              slot.agent,
              {
                item: id,
                pr_number: prNumber,
                merge_sha: mergeSha,
              },
              {
                task_rev: current.rev,
                item: id,
                owner_gen: current.owner_gen,
                plan_hash: record.plan_hash,
              },
            );
          }),
        );
        if (result.success) merged.add(id);
      } else if (
        observed.state === "open" &&
        index > 0 &&
        merged.has(record.plan.stack_order[index - 1] ?? "")
      ) {
        // Reconcile already-recorded merges too: a crash may happen after item.merged (§11.4).
        const retargetKey = `${key}:${prNumber}:${record.plan.base.branch}`;
        if (!retargeted.has(retargetKey)) {
          const pr = await host.findPr(task.repo, delivery.branch);
          if (pr) {
            if (pr.base !== record.plan.base.branch)
              await host.retargetPr(task.repo, prNumber, record.plan.base.branch);
            retargeted.add(retargetKey);
          }
        }
      }
    }
  };

  const closeStale = async (task: TaskState, host: CodeHost) => {
    for (const id of Object.keys(task.epochs).sort()) {
      const delivery = task.items[id]?.delivered;
      if (!delivery || delivery.submit.pr_number === undefined) continue;
      const preserved = preservedBranches(task, id);
      for (let epoch = 1; epoch <= (task.epochs[id] ?? 0); epoch++) {
        const branch = workBranch(task.task_id, id, epoch);
        // D7 carry-over may preserve a delivery from an older epoch; it is still authoritative.
        if (preserved.includes(branch)) continue;
        const key = epochKey(task, id, epoch);
        if (settledEpochs.has(key) || terminalPrs.has(key)) continue;
        const pr = await host.findPr(task.repo, branch);
        if (pr)
          await host.closePr(
            task.repo,
            pr.number,
            `Stale attempt ${id} epoch ${epoch}; consult the current signed task state before merging.`,
          );
        settledEpochs.add(key);
      }
    }
  };

  return async (context) => {
    const { task, slot } = context;
    if (
      !slot.enabled ||
      task.active_plan_version === null ||
      (task.owner !== slot.agent &&
        !Object.values(task.items).some((item) => item.assignee === slot.agent))
    )
      return;
    try {
      if (
        task.owner === slot.agent &&
        task.escalation?.reason === "verification_failed" &&
        task.verified?.passed === false
      )
        await notifyFailure(task, task.verified.seq);
      await verify(context);
      if (
        Object.values(task.items).some((item) => item.delivered?.submit.pr_number !== undefined)
      ) {
        const host = deps.codeHost(slot);
        await observeMerges(context, host);
        const staleKey = staleEpochsKey(task);
        if (staleScans.get(task.task_id) !== staleKey) {
          await closeStale(task, host);
          staleScans.set(task.task_id, staleKey);
        }
      }
      if (["done", "cancelled"].includes(task.status)) verifications.delete(task.task_id);
    } catch (cause) {
      throw new DeliveryError(
        `Delivery duty for task ${task.task_id} failed; inspect verification and code-host evidence`,
        { cause },
      );
    }
  };
}
