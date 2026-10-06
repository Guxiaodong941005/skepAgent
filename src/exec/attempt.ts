import { lstat, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { buildFixupPrompt, buildWorkPrompt } from "../adapter/prompts.js";
import { runStructured } from "../adapter/structured.js";
import type { AdapterInvocation, AdapterResult, AgentAdapter } from "../adapter/types.js";
import type { Publisher, PublishResult } from "../blackboard/publisher.js";
import type { CodeHost, PrInfo } from "../codehost/types.js";
import { workBranch } from "../core/ids.js";
import { checkpointIntent, deliverIntent, failIntent, type Intent } from "../core/intents.js";
import {
  AgentIdSchema,
  AttemptIdSchema,
  BarrierIdSchema,
  CheckRunSchema,
  EpochSchema,
  EventIdSchema,
  ItemIdSchema,
  ShaSchema,
  TaskIdSchema,
} from "../core/schemas/common.js";
import { EVENT_SCHEMAS, type PayloadOf, WorkFailureClassSchema } from "../core/schemas/events.js";
import { type Plan, PlanSchema } from "../core/schemas/plan.js";
import { type InvocationState, type Snapshot, SnapshotSchema } from "../core/schemas/snapshot.js";
import { type WorkReport, WorkReportSchema } from "../core/schemas/work-report.js";
import type { ReplanRequestResult } from "../daemon/replan.js";
import { type Ident, writeSignedCommit } from "../git/commit.js";
import type { GitRunner, GitRunOptions } from "../git/runner.js";
import type { Signer } from "../git/signer.js";
import type { LeaseIdentity } from "../lease/reverify.js";
import { NativeRuntime } from "../runtime/native.js";
import type { ProcessHandle, RuntimeBackend } from "../runtime/types.js";
import type { Clock } from "../util/clock.js";
import { safeJoin } from "../util/fs.js";
import { cryptoRandom, newEventId, type RandomSource } from "../util/random.js";
import type { ChecksRunner } from "./checks.js";
import { EvidenceVerifier } from "./evidence.js";
import { runInterruptLadder } from "./interrupt.js";
import type { AttemptKey, Journal, JournalRecord } from "./journal.js";
import { findSecrets, type Redactor } from "./redact.js";
import { type AgentEnvOptions, agentEnv } from "./sandbox-env.js";
import { scanSecrets } from "./secret-scan.js";
import { buildSnapshot } from "./snapshot.js";
import type { AttemptWorktree, CodeMirror } from "./worktree.js";

/** Completion records are durable crash points consumed by SK-505 (§9.7, §11.4). */
export const ATTEMPT_STEPS = [
  "claimed",
  "worktree_created",
  "preflight_ok",
  "invocation_started",
  "invoked",
  "invocation_done",
  "committed",
  "checks",
  "fixup",
  "secret_scan_ok",
  "pushed",
  "reverified",
  "pr",
  "publish_pending",
  "delivered_published",
  "failed",
  "checkpointed",
  "stale",
] as const;

const SECRET_FAILURE_DETAIL = "Secret scan blocked publication; see the local journal";

const InputSchema = z.strictObject({
  lease: z.strictObject({
    task_id: TaskIdSchema,
    item: ItemIdSchema,
    epoch: EpochSchema,
    holder: AgentIdSchema,
  }),
  attemptId: AttemptIdSchema,
  plan: PlanSchema,
  baseSha: ShaSchema,
  prBase: z.string().min(1).max(255),
  agentInstructions: z.string(),
  repoContext: z.string(),
  timeoutMs: z.number().finite().positive(),
  cliVersion: z.string().min(1).optional(),
});
export type AttemptInput = z.infer<typeof InputSchema>;
export type FailureClass = z.infer<typeof WorkFailureClassSchema>;

export const AttemptPublicationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("work.delivered"),
    event_id: EventIdSchema,
    payload: EVENT_SCHEMAS["work.delivered"].shape.payload,
  }),
  z.strictObject({
    type: z.literal("work.failed"),
    event_id: EventIdSchema,
    payload: EVENT_SCHEMAS["work.failed"].shape.payload,
  }),
  z.strictObject({
    type: z.literal("checkpoint.recorded"),
    event_id: EventIdSchema,
    payload: EVENT_SCHEMAS["checkpoint.recorded"].shape.payload,
  }),
]);
export type AttemptPublication = z.infer<typeof AttemptPublicationSchema>;

export type AttemptResult =
  | { status: "delivered"; publication: PublishResult }
  | { status: "failed"; class: FailureClass; publication?: PublishResult }
  | { status: "checkpointed"; snapshot: Snapshot; publication: PublishResult }
  | { status: "stale" }
  | { status: "pending"; publication: PublishResult };

export class AttemptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttemptError";
  }
}

/** Bind real adapters to this runtime so launch identity is fsynced before invoke continues. */
export type AttemptAdapterFactory = (
  runtime: RuntimeBackend,
  interrupt: typeof runInterruptLadder,
) => AgentAdapter;

export type AttemptReplanHandler = (request: {
  report: WorkReport;
  evidenceKey: AttemptKey;
  eventId: string;
  verifier: Pick<EvidenceVerifier, "verifyAll">;
}) => Promise<ReplanRequestResult>;

export interface AttemptRunnerDependencies {
  mirror: Pick<CodeMirror, "fetch" | "createWorktree" | "mirrorPath" | "worktreeRoot">;
  git: GitRunner;
  signer: Signer;
  ident: Omit<Ident, "timestampSec">;
  /** Explicit daemon environment; never agentEnv or provider variables. */
  gitEnv?: Record<string, string>;
  agentEnv: AgentEnvOptions;
  /** Direct adapters are for process-free fakes; real adapters must use the runtime factory. */
  adapter: AgentAdapter | AttemptAdapterFactory;
  runtime?: RuntimeBackend;
  structured?: typeof runStructured;
  checks: Pick<ChecksRunner, "load" | "run">;
  scanSecrets?: typeof scanSecrets;
  redactor: Pick<Redactor, "redact" | "createStream">;
  codeHost: CodeHost;
  reverify: (lease: LeaseIdentity) => Promise<"ok" | "stale">;
  publisher: Pick<Publisher, "publish">;
  journal: Pick<Journal, "append" | "read" | "path">;
  clock: Clock;
  random?: RandomSource;
  /** Daemon-owned directory outside all worktrees. */
  scratchDir: string;
  /** Maximum additional time for adapter interruption, including a stuck SIGKILL wait (F18). */
  shutdownMs?: number;
  preflight?: (worktree: AttemptWorktree, input: AttemptInput) => Promise<void>;
}

interface RunningAttempt {
  input: AttemptInput;
  key: AttemptKey;
  records: JournalRecord[];
  abort: AbortController;
  barrierId: string | null;
  worktree?: AttemptWorktree;
  secretHit: boolean;
  journalTail: Promise<void>;
}

const PrSchema = z.strictObject({
  number: z.number().int().positive(),
  url: z.url().max(512),
  head: z.string().min(1),
  base: z.string().min(1),
  title: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  mergeSha: ShaSchema.nullable(),
});
const RunsSchema = z.array(CheckRunSchema).max(32);
const PublishOutcomeSchema = z.strictObject({
  status: z.enum(["accepted", "rejected", "dropped", "failed"]),
  eventId: EventIdSchema,
  seq: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
});
const ResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("delivered"), publication: PublishOutcomeSchema }),
  z.strictObject({
    status: z.literal("failed"),
    class: WorkFailureClassSchema,
    publication: PublishOutcomeSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("checkpointed"),
    snapshot: SnapshotSchema,
    publication: PublishOutcomeSchema,
  }),
  z.strictObject({ status: z.literal("stale") }),
  z.strictObject({ status: z.literal("pending"), publication: PublishOutcomeSchema }),
]);

/** Code first, then record; model reports cannot authorize delivery (PRD §9.6). */
export class AttemptRunner {
  private readonly active = new Map<string, RunningAttempt>();
  private readonly reserved = new Set<string>();
  private readonly shutdownMs: number;

  constructor(private readonly deps: AttemptRunnerDependencies) {
    this.shutdownMs = deps.shutdownMs ?? 180_000;
    if (!Number.isFinite(this.shutdownMs) || this.shutdownMs <= 0) {
      throw new AttemptError("shutdownMs must be a positive finite delay");
    }
  }

  /** A barrier can arrive after launch; the daemon passes its id rather than mutating input. */
  async interrupt(key: AttemptKey, barrierId: string | null = null): Promise<boolean> {
    if (barrierId !== null && !BarrierIdSchema.safeParse(barrierId).success) {
      throw new AttemptError("Cannot interrupt with an invalid barrier id");
    }
    const running = this.active.get(keyName(key));
    if (!running) return false;
    await this.record(running, { step: "interrupt_requested", barrier_id: barrierId });
    running.barrierId = barrierId;
    running.abort.abort();
    return true;
  }

  /** Resume durable steps with the same input; unknown invocations are never replayed (§11.4). */
  async run(
    input: AttemptInput,
    signal?: AbortSignal,
    onReplan?: AttemptReplanHandler,
  ): Promise<AttemptResult> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) throw new AttemptError("Attempt requires a valid lease and approved plan");
    const lease = parsed.data.lease;
    const name = keyName({ task: lease.task_id, item: lease.item, epoch: lease.epoch });
    if (this.reserved.has(name)) throw new AttemptError("This attempt is already running");
    // Reserve before the first journal read so two slots cannot both start the same attempt.
    this.reserved.add(name);
    try {
      return await this.execute(parsed.data, signal, onReplan);
    } finally {
      this.reserved.delete(name);
    }
  }

  /** Daemon scheduling supplies the report consumer; process-free attempt fakes need only run. */
  async runWithReplan(input: AttemptInput, onReplan: AttemptReplanHandler): Promise<AttemptResult> {
    return this.run(input, undefined, onReplan);
  }

  private async execute(
    frozen: AttemptInput,
    signal?: AbortSignal,
    onReplan?: AttemptReplanHandler,
  ): Promise<AttemptResult> {
    const item = frozen.plan.items.find((entry) => entry.id === frozen.lease.item);
    if (frozen.plan.task_id !== frozen.lease.task_id || item?.assignee !== frozen.lease.holder) {
      throw new AttemptError("Attempt lease must match the approved item's task and assignee");
    }
    if (item.depends_on.length === 0 && frozen.baseSha !== frozen.plan.base.commit) {
      throw new AttemptError("First stack item must start at the approved plan base");
    }
    const key = { task: frozen.lease.task_id, item: frozen.lease.item, epoch: frozen.lease.epoch };
    const name = keyName(key);
    if (this.active.has(name)) throw new AttemptError("This attempt is already running");
    const context: RunningAttempt = {
      input: frozen,
      key,
      records: await this.deps.journal.read(key),
      abort: new AbortController(),
      barrierId: null,
      secretHit: false,
      journalTail: Promise.resolve(),
    };
    const interruption = last(context, "interrupt_requested");
    if (interruption) {
      context.barrierId = BarrierIdSchema.nullable().parse(interruption.barrier_id);
      context.abort.abort();
    }
    const claimed = last(context, "claimed");
    if (claimed && JSON.stringify(claimed.input) !== JSON.stringify(this.scrub(frozen))) {
      throw new AttemptError("Recovery input differs from the journaled attempt");
    }
    const terminal = context.records.at(-1);
    if (terminal?.result) return ResultSchema.parse(terminal.result);
    const abort = () => context.abort.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    this.active.set(name, context);
    try {
      if (!claimed) await this.record(context, { step: "claimed", input: frozen });
      const pending = last(context, "publish_pending");
      if (pending) {
        const publication = AttemptPublicationSchema.parse(pending.publication);
        const worktree = await this.worktree(context);
        context.worktree = worktree;
        return await this.publish(context, publication, true);
      }
      context.worktree = await this.worktree(context);
      const adapter = this.adapter();
      if (!last(context, "preflight_ok")) {
        try {
          // G14: trusted files are resolved only after the base is present in the mirror.
          await this.deps.mirror.fetch(frozen.plan.base.repo);
          const trusted = await this.deps.checks.load(
            frozen.plan.base.repo,
            frozen.plan.base.commit,
          );
          for (const name of checkNames(frozen.plan, key.item)) {
            if (!Object.hasOwn(trusted.checks, name)) {
              throw new AttemptError(`Acceptance check ${name} is absent from the trusted base`);
            }
          }
          const probe = await adapter.probe();
          if (!probe.ok || (frozen.cliVersion && probe.version !== frozen.cliVersion)) {
            throw new AttemptError("Agent CLI preflight failed; install the pinned local CLI");
          }
          await this.deps.preflight?.(context.worktree, frozen);
        } catch (error) {
          return await this.fail(context, "preflight", actionable(error));
        }
        await this.record(context, { step: "preflight_ok" });
      }
      let done = last(context, "invocation_done");
      if (!done) {
        if (last(context, "invoked") || last(context, "invocation_started")) {
          if (interruption) return await this.checkpoint(context, "unknown");
          return await this.fail(
            context,
            "crash",
            "Invocation outcome is unknown; do not rerun it",
          );
        }
        const result = await this.invoke(context, adapter, "work");
        done = await this.record(context, { step: "invocation_done", ...result });
      }
      if (context.secretHit || last(context, "secret_detected"))
        return await this.secretFailure(context);
      if (done.state === "unknown" || context.abort.signal.aborted || done.interrupted === true) {
        return await this.checkpoint(context, stateOf(done));
      }
      if (done.error !== null)
        return await this.fail(context, failureOf(done.error), String(done.error));
      const replan = await this.replan(context, done, "work", onReplan);
      if (replan) return replan;
      let head = await this.commit(context, "work", false);
      let runs = await this.checks(context, head, "work");
      if (runs.some((run) => run.exit !== 0)) {
        let fixup = last(context, "fixup_done");
        if (!fixup) {
          if (last(context, "fixup")) {
            if (interruption) return await this.checkpoint(context, "unknown");
            return await this.fail(context, "crash", "Fix-up outcome is unknown; do not rerun it");
          }
          await this.record(context, { step: "fixup" });
          const result = await this.invoke(context, adapter, "fixup", runs);
          fixup = await this.record(context, { step: "fixup_done", ...result });
        }
        if (context.secretHit || last(context, "secret_detected"))
          return await this.secretFailure(context);
        if (
          fixup.state === "unknown" ||
          context.abort.signal.aborted ||
          fixup.interrupted === true
        ) {
          return await this.checkpoint(context, stateOf(fixup));
        }
        if (fixup.error !== null)
          return await this.fail(context, failureOf(fixup.error), String(fixup.error));
        const replan = await this.replan(context, fixup, "fixup", onReplan);
        if (replan) return replan;
        head = await this.commit(context, "fixup", false);
        runs = await this.checks(context, head, "fixup");
        if (runs.some((run) => run.exit !== 0)) {
          return await this.fail(
            context,
            "checks_failed",
            "Trusted checks failed after one fix-up",
          );
        }
      }
      if (context.abort.signal.aborted) return await this.checkpoint(context, "completed");
      const title = `${key.task} ${key.item}: ${item.title}`;
      const report = WorkReportSchema.parse((last(context, "fixup_done") ?? done).report);
      const body = `${report.summary}\n\nTrusted checks: ${runs.map((run) => `${run.check} (${run.exit})`).join(", ")}`;
      if (!(await this.scan(context, head, [title, body])))
        return await this.secretFailure(context);
      await this.push(context, head);
      let pr: PrInfo;
      const savedPr = last(context, "pr");
      if (savedPr) pr = PrSchema.parse(savedPr.pr);
      else {
        const found = await this.deps.codeHost.findPr(frozen.plan.base.repo, branchOf(context));
        // A fresh observation is the last await before each visible delivery operation (§6.3).
        if (!(await this.reverify(context, "pr"))) return await this.stale(context);
        if (found) {
          pr = PrSchema.parse(found);
          if (pr.head !== branchOf(context) || pr.state !== "open") {
            throw new AttemptError("Existing attempt PR has the wrong head or is no longer open");
          }
          if (pr.base !== frozen.prBase) {
            await this.deps.codeHost.retargetPr(frozen.plan.base.repo, pr.number, frozen.prBase);
            pr = { ...pr, base: frozen.prBase };
          }
        } else {
          pr = PrSchema.parse(
            await this.deps.codeHost.createPr(frozen.plan.base.repo, {
              head: branchOf(context),
              base: frozen.prBase,
              title: this.deps.redactor.redact(title),
              body: this.deps.redactor.redact(body),
            }),
          );
        }
        await this.record(context, { step: "pr", pr, action: found ? "found" : "created" });
      }
      return await this.preparePublication(context, "work.delivered", {
        item: key.item,
        epoch: key.epoch,
        branch: branchOf(context),
        head_sha: head,
        pr_number: pr.number,
        pr_url: pr.url,
        check_runs: runs,
      });
    } finally {
      signal?.removeEventListener("abort", abort);
      this.active.delete(name);
    }
  }

  private scrub(value: unknown): unknown {
    if (typeof value === "string") return this.deps.redactor.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.scrub(entry));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([name, entry]) => [name, this.scrub(entry)]),
      );
    }
    return value;
  }

  private async replan(
    c: RunningAttempt,
    done: JournalRecord,
    phase: "work" | "fixup",
    handler?: AttemptReplanHandler,
  ): Promise<AttemptResult | null> {
    const report = WorkReportSchema.parse(done.report);
    if (!report.replan_request || last(c, "replan_ignored", phase)) return null;
    if (!handler) throw new AttemptError("Work report requests replanning; configure its handler");
    let pending = last(c, "replan_pending", phase);
    if (!pending)
      pending = await this.record(c, {
        step: "replan_pending",
        phase,
        event_id: newEventId(this.deps.random ?? cryptoRandom),
      });
    const outcome = await handler({
      report,
      evidenceKey: { ...c.key },
      eventId: EventIdSchema.parse(pending.event_id),
      verifier: new EvidenceVerifier({
        git: this.git(),
        mirror: this.deps.mirror,
        journal: this.deps.journal,
      }),
    });
    await this.record(c, { step: "replan_outcome", phase, outcome });
    if (outcome.status === "dropped" && outcome.reason === "no_verified_evidence") {
      await this.record(c, {
        step: "replan_ignored",
        phase,
        message: "replan request ignored",
        reason: outcome.reason,
      });
      return c.abort.signal.aborted ? this.checkpoint(c, stateOf(done)) : null;
    }
    if (outcome.status === "failed") return { status: "pending", publication: outcome };
    if (outcome.status !== "accepted") return this.stale(c);
    // The replan duty binds the barrier through interrupt(), using this single journal writer.
    // An accepted request must never fall through to checks, PR creation or delivery (§9.7).
    if (!c.barrierId || !c.abort.signal.aborted)
      throw new AttemptError("Accepted replan request has not been interrupted by its barrier");
    return this.checkpoint(c, stateOf(done));
  }

  private async record(c: RunningAttempt, record: { step: string; [key: string]: unknown }) {
    // Interrupt requests share the attempt's single journal writer (Journal's append contract).
    const pending = c.journalTail.then(async () => {
      const stored = await this.deps.journal.append(c.key, this.scrub(record) as typeof record);
      c.records.push(stored);
      return stored;
    });
    c.journalTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private git(): GitRunner {
    const env: Record<string, string> = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    for (const name of [
      "PATH",
      "HOME",
      "TMPDIR",
      "SSH_AUTH_SOCK",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
    ]) {
      const value = this.deps.gitEnv?.[name];
      if (value !== undefined) env[name] = value;
    }
    // Disable hooks and global configuration on every daemon code write; agent env never crosses.
    return {
      run: (args: string[], opts: GitRunOptions) =>
        this.deps.git.run(
          ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
          {
            ...opts,
            env,
          },
        ),
    };
  }

  private async worktree(c: RunningAttempt): Promise<AttemptWorktree> {
    const relative = `${c.key.task}/${c.key.item}-e${c.key.epoch}`;
    await mkdir(this.deps.mirror.worktreeRoot, { recursive: true, mode: 0o755 });
    const target = await safeJoin(this.deps.mirror.worktreeRoot, relative);
    let exists = false;
    try {
      exists = (await lstat(target)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let worktree: AttemptWorktree;
    if (exists) {
      const actual = await this.git().run(["symbolic-ref", "--short", "HEAD"], { cwd: target });
      if (actual.stdout.trim() !== branchOf(c))
        throw new AttemptError("Recovery checkout has the wrong branch");
      worktree = {
        repo: c.input.plan.base.repo,
        mirrorDir: await this.deps.mirror.mirrorPath(c.input.plan.base.repo),
        path: target,
        branch: branchOf(c),
        baseSha: c.input.baseSha,
      };
    } else {
      worktree = await this.deps.mirror.createWorktree({
        repo: c.input.plan.base.repo,
        baseSha: c.input.baseSha,
        branch: branchOf(c),
        path: relative,
      });
    }
    if (!last(c, "worktree_created"))
      await this.record(c, { step: "worktree_created", path: relative });
    return worktree;
  }

  private adapter(): AgentAdapter {
    const backend = this.deps.runtime ?? new NativeRuntime({ clock: this.deps.clock });
    return typeof this.deps.adapter === "function"
      ? this.deps.adapter(backend, runInterruptLadder)
      : this.deps.adapter;
  }

  private async invoke(
    c: RunningAttempt,
    adapter: AgentAdapter,
    kind: "work" | "fixup",
    runs: Snapshot["check_runs"] = [],
  ) {
    const worktree = requiredWorktree(c);
    await mkdir(this.deps.scratchDir, { recursive: true, mode: 0o700 });
    const scratch = await mkdtemp(join(this.deps.scratchDir, "attempt-"));
    const logs = join(dirname(this.deps.journal.path(c.key)), "adapter");
    await mkdir(logs, { recursive: true, mode: 0o700 });
    const context = {
      agentInstructions: c.input.agentInstructions,
      repoContext: c.input.repoContext,
      plan: c.input.plan,
      itemId: c.key.item,
      epoch: c.key.epoch,
      baseCommit: c.input.baseSha,
    };
    let prompt = buildWorkPrompt(context);
    if (kind === "fixup") {
      const diff = await this.git().run(["diff", "--no-ext-diff", c.input.baseSha, "HEAD", "--"], {
        cwd: worktree.path,
      });
      prompt = buildFixupPrompt({
        ...context,
        checkRuns: runs,
        logTail: await this.logTail(c, runs),
        previousReport: WorkReportSchema.parse(last(c, "invocation_done")?.report),
      });
      prompt += `\n\nRead-only diff supplied by the daemon:\n${this.deps.redactor.redact(diff.stdout)}`;
    }
    // G13: the daemon alone owns .git, signing, commits and pushes.
    prompt +=
      "\n\nThis worktree has no usable Git for the agent. Do not run git. The daemon commits and pushes your edits.";
    const handles: ProcessHandle[] = [];
    let killed = false;
    let interrupted = false;
    // The factory is rebound for each invocation, including structured-output repair.
    const backend = this.deps.runtime ?? new NativeRuntime({ clock: this.deps.clock });
    const runtime: RuntimeBackend = {
      name: backend.name,
      isAlive: backend.isAlive.bind(backend),
      spawn: async (options) => {
        const handle = await backend.spawn(options);
        handles.push(handle);
        try {
          await this.record(c, {
            step: "invoked",
            kind,
            pid: handle.pid,
            pgid: handle.pgid,
            start_token: handle.startToken,
          });
        } catch (error) {
          handle.signalGroup("SIGKILL");
          throw error;
        }
        return {
          pid: handle.pid,
          pgid: handle.pgid,
          startToken: handle.startToken,
          wait: handle.wait.bind(handle),
          signalGroup: (signal) => {
            interrupted = true;
            if (signal !== "SIGINT") killed = true;
            handle.signalGroup(signal);
          },
        };
      },
    };
    const bound =
      typeof this.deps.adapter === "function"
        ? this.deps.adapter(runtime, runInterruptLadder)
        : adapter;
    let counter = 0;
    const captures: AbortController[] = [];
    const capture: AgentAdapter = {
      cli: bound.cli,
      probe: bound.probe.bind(bound),
      invoke: async (inv) => {
        const id = `${kind}-${++counter}`;
        const raw = join(scratch, `${id}.raw`);
        // Keep pre-launch crash fencing without confusing intent with the factory's PID record.
        await this.record(c, {
          step: typeof this.deps.adapter === "function" ? "invocation_started" : "invoked",
          kind: inv.kind,
          pid: null,
          pgid: null,
          start_token: null,
        });
        const captureStop = new AbortController();
        captures.push(captureStop);
        const capturing = this.capture(raw, join(logs, `${id}.log`), captureStop.signal);
        let result: AdapterResult;
        try {
          result = await bound.invoke({
            ...inv,
            prompt: this.deps.redactor.redact(inv.prompt),
            logPath: raw,
            scratchDir: scratch,
          });
        } finally {
          captureStop.abort();
          await capturing;
        }
        if (result.finalMessage !== null && findSecrets(result.finalMessage).length > 0)
          c.secretHit = true;
        return {
          ...result,
          finalMessage:
            result.finalMessage === null ? null : this.deps.redactor.redact(result.finalMessage),
        };
      },
    };
    const timer = new AbortController();
    const invocationAbort = new AbortController();
    let deadlineExpired = false;
    let requestStop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      requestStop = resolve;
    });
    const externalAbort = () => {
      invocationAbort.abort();
      requestStop();
    };
    c.abort.signal.addEventListener("abort", externalAbort, { once: true });
    if (c.abort.signal.aborted) externalAbort();
    const invocation: AdapterInvocation = {
      kind,
      cwd: worktree.path,
      prompt: this.deps.redactor.redact(prompt),
      outputSchema: {},
      env: agentEnv(this.deps.agentEnv),
      timeoutMs: c.input.timeoutMs,
      logPath: join(scratch, "unused.raw"),
      scratchDir: scratch,
      signal: invocationAbort.signal,
    };
    let finished = false;
    const pending = (this.deps.structured ?? runStructured)(capture, invocation, WorkReportSchema);
    const deadline = this.deps.clock.sleep(c.input.timeoutMs, timer.signal).then(() => {
      deadlineExpired = true;
      invocationAbort.abort();
    });
    const timed = Promise.race([deadline, stopped]).then(async () => {
      await this.deps.clock.sleep(this.shutdownMs, timer.signal);
      for (const handle of handles) handle.signalGroup("SIGKILL");
      for (const stop of captures) stop.abort();
      return null;
    });
    try {
      const result = await Promise.race([pending, timed]);
      if (result === null) {
        // A never-exiting group cannot establish stable checkout facts (F18, PRD §10.7).
        return { state: "unknown", error: "timeout", report: null, interrupted: true };
      }
      finished = true;
      if (result.ok && hasSecrets(result.value)) c.secretHit = true;
      if (c.secretHit) await this.record(c, { step: "secret_detected" });
      const state: InvocationState =
        result.result.outcome === "unknown"
          ? "unknown"
          : killed
            ? "killed"
            : interrupted || result.result.outcome === "interrupted"
              ? "interrupted"
              : result.result.outcome === "killed" || result.result.outcome === "timeout"
                ? "killed"
                : "completed";
      return {
        state,
        error: deadlineExpired ? "timeout" : result.ok ? null : result.error,
        report: result.ok ? result.value : null,
        interrupted:
          !deadlineExpired &&
          (result.result.outcome === "interrupted" || result.result.outcome === "killed"),
        outcome: result.result.outcome,
        exit: result.result.exitCode,
      };
    } finally {
      timer.abort();
      c.abort.signal.removeEventListener("abort", externalAbort);
      // On unknown exit leave private scratch alone; the process may still be writing it.
      if (finished) await rm(scratch, { recursive: true, force: true });
    }
  }

  private async capture(raw: string, destination: string, signal: AbortSignal): Promise<void> {
    const stream = this.deps.redactor.createStream();
    const output = await open(destination, "w", 0o600);
    const decoder = new StringDecoder("utf8");
    let offset = 0;
    try {
      for (;;) {
        try {
          const input = await open(raw, "r");
          try {
            const buffer = Buffer.alloc(64 * 1024);
            for (;;) {
              const { bytesRead } = await input.read(buffer, 0, buffer.length, offset);
              if (bytesRead === 0) break;
              offset += bytesRead;
              const redacted = stream.push(decoder.write(buffer.subarray(0, bytesRead)));
              if (redacted !== "") await output.write(redacted);
            }
          } finally {
            await input.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (signal.aborted) break;
        try {
          await this.deps.clock.sleep(100, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
      await output.write(stream.push(decoder.end()));
      await output.write(stream.flush());
      await output.sync();
    } finally {
      await output.close();
    }
  }

  private async logTail(c: RunningAttempt, runs: Snapshot["check_runs"]): Promise<string> {
    const chunks: string[] = [];
    for (const run of runs) {
      const path = await safeJoin(
        dirname(this.deps.journal.path(c.key)),
        `checks/${run.run_id}.log`,
      );
      const text = await readFile(path, "utf8");
      chunks.push(`${run.check}:\n${this.deps.redactor.redact(text).slice(-8000)}`);
    }
    return chunks.join("\n");
  }

  private async commit(c: RunningAttempt, phase: string, wip: boolean): Promise<string> {
    const completed = last(c, "committed", phase);
    if (completed) return ShaSchema.parse(completed.sha);
    const cwd = requiredWorktree(c).path;
    const git = this.git();
    let prepared = last(c, "commit_prepared", phase);
    if (!prepared) {
      await git.run(["add", "--all", "--", "."], { cwd });
      const parent = ShaSchema.parse(
        (await git.run(["rev-parse", "HEAD^{commit}"], { cwd })).stdout.trim(),
      );
      const tree = ShaSchema.parse((await git.run(["write-tree"], { cwd })).stdout.trim());
      const ident = {
        ...this.deps.ident,
        timestampSec: Math.floor(this.deps.clock.nowMs() / 1000),
      };
      const message = this.deps.redactor.redact(
        `${wip ? "skep-wip:" : "skep:"} ${c.key.task} ${c.key.item} e${c.key.epoch} ${phase}`,
      );
      const sha = await writeSignedCommit(git, cwd, {
        tree,
        parents: [parent],
        author: ident,
        committer: ident,
        message,
        signer: this.deps.signer,
      });
      prepared = await this.record(c, { step: "commit_prepared", phase, sha, parent });
    }
    const sha = ShaSchema.parse(prepared.sha);
    const parent = ShaSchema.parse(prepared.parent);
    const actual = ShaSchema.parse((await git.run(["rev-parse", "HEAD"], { cwd })).stdout.trim());
    if (actual === parent)
      await git.run(["update-ref", `refs/heads/${branchOf(c)}`, sha, parent], { cwd });
    else if (actual !== sha) throw new AttemptError("Attempt HEAD changed during commit recovery");
    await this.record(c, { step: "committed", phase, sha });
    return sha;
  }

  private async checks(c: RunningAttempt, head: string, phase: string) {
    const saved = last(c, "checks", phase);
    if (saved) return RunsSchema.parse(saved.check_runs);
    if (last(c, "checks_started", phase))
      throw new AttemptError("Check outcome is unknown; reconcile before continuing");
    await this.deps.mirror.fetch(c.input.plan.base.repo);
    await this.record(c, { step: "checks_started", phase, sha: head });
    const runs = RunsSchema.parse(
      await this.deps.checks.run({
        repo: c.input.plan.base.repo,
        baseCommit: c.input.plan.base.commit,
        worktree: requiredWorktree(c).path,
        checks: checkNames(c.input.plan, c.key.item),
        attempt: c.key,
      }),
    );
    if (runs.some((run) => run.sha !== head))
      throw new AttemptError("Trusted checks tested another commit");
    await this.record(c, {
      step: "checks",
      phase,
      check_runs: runs,
      run_ids: runs.map((run) => run.run_id),
    });
    return runs;
  }

  private async scan(c: RunningAttempt, head: string, text: string[] = []): Promise<boolean> {
    if (
      c.secretHit ||
      last(c, "secret_detected") ||
      text.some((entry) => findSecrets(entry).length > 0)
    )
      return false;
    await this.deps.mirror.fetch(c.input.plan.base.repo);
    const diff = await this.git().run(["diff", "--no-ext-diff", c.input.baseSha, head, "--"], {
      cwd: requiredWorktree(c).path,
    });
    const result = await (this.deps.scanSecrets ?? scanSecrets)(
      {
        repo: c.input.plan.base.repo,
        cwd: requiredWorktree(c).path,
        baseSha: c.input.plan.base.commit,
        headSha: head,
        scratchDir: this.deps.scratchDir,
        env: { ...this.deps.agentEnv, agentCli: undefined, configDir: undefined },
      },
      { git: this.git(), mirror: this.deps.mirror },
    );
    if (result.status !== "clean" || findSecrets(diff.stdout).length > 0) return false;
    await this.record(c, { step: "secret_scan_ok", sha: head });
    return true;
  }

  private async push(c: RunningAttempt, head: string): Promise<void> {
    // A lost acknowledgement is resolved by observing the ref; never force an epoch branch.
    if ((await this.deps.codeHost.remoteBranchSha(c.input.plan.base.repo, branchOf(c))) !== head) {
      await this.git().run(["push", "origin", `${head}:refs/heads/${branchOf(c)}`], {
        cwd: requiredWorktree(c).mirrorDir,
      });
    }
    if ((await this.deps.codeHost.remoteBranchSha(c.input.plan.base.repo, branchOf(c))) !== head) {
      throw new AttemptError("Code remote did not confirm the committed attempt SHA");
    }
    if (last(c, "pushed")?.sha !== head) await this.record(c, { step: "pushed", sha: head });
  }

  private async reverify(c: RunningAttempt, before: string) {
    const result = await this.deps.reverify(c.input.lease);
    if (result === "ok") await this.record(c, { step: "reverified", before });
    return result === "ok";
  }

  private async stale(c: RunningAttempt): Promise<AttemptResult> {
    const result = { status: "stale" } as const;
    await this.record(c, { step: "stale", result });
    return result;
  }

  private async secretFailure(c: RunningAttempt): Promise<AttemptResult> {
    // D19 blocks code and PR content; a fixed failure event still ends the lease (§5.5).
    if (!last(c, "secret_detected")) await this.record(c, { step: "secret_detected" });
    return this.preparePublication(c, "work.failed", {
      item: c.key.item,
      epoch: c.key.epoch,
      class: "secret_detected",
      detail: SECRET_FAILURE_DETAIL,
    });
  }

  private async fail(c: RunningAttempt, failure: FailureClass, detail: string) {
    return this.preparePublication(c, "work.failed", {
      item: c.key.item,
      epoch: c.key.epoch,
      class: failure,
      detail:
        this.deps.redactor.redact(detail).slice(0, 4000) ||
        "Attempt failed; inspect the local journal",
    });
  }

  private async checkpoint(c: RunningAttempt, state: InvocationState) {
    const head = state === "unknown" ? null : await this.commit(c, "checkpoint", true);
    const runs = RunsSchema.parse(
      last(c, "checks", "fixup")?.check_runs ?? last(c, "checks", "work")?.check_runs ?? [],
    );
    if (head !== null) {
      if (!(await this.scan(c, head))) return this.secretFailure(c);
      await this.push(c, head);
    }
    const snapshot = await buildSnapshot(
      {
        task: c.key.task,
        item: c.key.item,
        epoch: c.key.epoch,
        attemptId: c.input.attemptId,
        repo: c.input.plan.base.repo,
        worktree: requiredWorktree(c).path,
        baseSha: c.input.baseSha,
        headSha: head,
        invocationState: state,
        checkRuns: runs,
      },
      { git: this.git(), codeHost: this.deps.codeHost },
    );
    return this.preparePublication(c, "checkpoint.recorded", {
      item: c.key.item,
      epoch: c.key.epoch,
      barrier_id: c.barrierId,
      snapshot,
    });
  }

  private async preparePublication<T extends AttemptPublication["type"]>(
    c: RunningAttempt,
    type: T,
    payload: PayloadOf<T>,
  ) {
    const publication = AttemptPublicationSchema.parse({
      type,
      payload,
      event_id: newEventId(this.deps.random ?? cryptoRandom),
    });
    // F17: fsync the id and payload before Publisher can make its first attempt.
    await this.record(c, { step: "publish_pending", publication });
    return this.publish(c, publication);
  }

  private async publish(
    c: RunningAttempt,
    publication: AttemptPublication,
    recovery = false,
  ): Promise<AttemptResult> {
    const head =
      publication.type === "work.delivered"
        ? publication.payload.head_sha
        : publication.type === "checkpoint.recorded"
          ? (publication.payload.snapshot.head_sha ?? c.input.baseSha)
          : ShaSchema.parse(last(c, "committed")?.sha ?? c.input.baseSha);
    const eventJson = JSON.stringify(publication);
    if (publication.type === "work.failed" && publication.payload.class === "secret_detected") {
      // B1: rescanning the rejected code would recurse and leave a barrier's lease held forever.
      if (findSecrets(eventJson).length > 0) {
        throw new AttemptError("Secret failure event contains unsafe metadata; repair the journal");
      }
    } else if (!(await this.scan(c, head, [eventJson]))) return this.secretFailure(c);
    let intent: Intent;
    const action = { task_id: c.key.task, actor: c.input.lease.holder };
    if (publication.type === "work.delivered") {
      if (
        (await this.deps.codeHost.remoteBranchSha(c.input.plan.base.repo, branchOf(c))) !== head
      ) {
        throw new AttemptError("Cannot deliver code whose remote SHA no longer matches");
      }
      const current = await this.reverify(c, "work.delivered");
      // A lost acknowledgement may have ended the lease. Publisher checks seen_event_ids before
      // running the fenced intent; the saved id can confirm that already-landed event (§7.2).
      if (!current && !recovery) return this.stale(c);
      intent = current ? deliverIntent({ ...action, ...publication.payload }) : () => null;
    } else if (publication.type === "checkpoint.recorded") {
      intent = checkpointIntent({ ...action, ...publication.payload });
    } else intent = failIntent({ ...action, ...publication.payload });
    const outcome = PublishOutcomeSchema.parse(
      await this.deps.publisher.publish(intent, { eventId: publication.event_id }),
    );
    if (outcome.status === "failed") {
      await this.record(c, { step: "publish_failed", publication: outcome });
      return { status: "pending", publication: outcome };
    }
    if (outcome.status !== "accepted") return this.stale(c);
    let result: AttemptResult;
    let step: string;
    if (publication.type === "work.delivered") {
      result = { status: "delivered", publication: outcome };
      step = "delivered_published";
    } else if (publication.type === "checkpoint.recorded") {
      result = {
        status: "checkpointed",
        snapshot: SnapshotSchema.parse(publication.payload.snapshot),
        publication: outcome,
      };
      step = "checkpointed";
    } else {
      result = { status: "failed", class: publication.payload.class, publication: outcome };
      step = "failed";
    }
    await this.record(c, {
      step,
      seq: outcome.seq,
      event_id: publication.event_id,
      result,
      ...(publication.type === "work.failed" ? { class: publication.payload.class } : {}),
    });
    return result;
  }
}

function last(c: RunningAttempt, step: string, phase?: string): JournalRecord | undefined {
  return c.records.findLast(
    (record) => record.step === step && (phase === undefined || record.phase === phase),
  );
}
function keyName(key: AttemptKey): string {
  return `${key.task}/${key.item}/e${key.epoch}`;
}
function branchOf(c: RunningAttempt): string {
  return workBranch(c.key.task, c.key.item, c.key.epoch);
}
function requiredWorktree(c: RunningAttempt): AttemptWorktree {
  if (!c.worktree) throw new AttemptError("Attempt worktree has not been created");
  return c.worktree;
}
function checkNames(plan: Plan, item: string): string[] {
  return [
    ...new Set(
      plan.items
        .find((entry) => entry.id === item)
        ?.acceptance.flatMap((entry) => (entry.kind === "check" ? [entry.name] : [])) ?? [],
    ),
  ];
}
function stateOf(record: JournalRecord): InvocationState {
  return record.state === "completed" || record.state === "interrupted" || record.state === "killed"
    ? record.state
    : "unknown";
}
function failureOf(value: unknown): FailureClass {
  const parsed = WorkFailureClassSchema.safeParse(value);
  return parsed.success ? parsed.data : "crash";
}
function actionable(error: unknown): string {
  return error instanceof Error ? error.message : "Preflight failed; inspect the local environment";
}

function hasSecrets(value: unknown): boolean {
  if (typeof value === "string") return findSecrets(value).length > 0;
  if (Array.isArray(value)) return value.some(hasSecrets);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([key, entry]) => hasSecrets(key) || hasSecrets(entry));
  }
  return false;
}
