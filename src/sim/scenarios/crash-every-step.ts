import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeAdapter } from "../../adapter/fake.js";
import { FakeCodeHost } from "../../codehost/fake.js";
import { contentHash } from "../../core/canonical.js";
import { claimIntent, draft } from "../../core/intents.js";
import { DEFAULT_BUDGETS, ShaSchema } from "../../core/schemas/common.js";
import { PlanSchema } from "../../core/schemas/plan.js";
import {
  type AttemptInput,
  AttemptRunner,
  type AttemptRunnerDependencies,
} from "../../exec/attempt.js";
import { ChecksRunner } from "../../exec/checks.js";
import { type AttemptKey, Journal } from "../../exec/journal.js";
import { AttemptReconciler } from "../../exec/reconcile.js";
import { Redactor } from "../../exec/redact.js";
import { CodeMirror } from "../../exec/worktree.js";
import { writeSignedCommit } from "../../git/commit.js";
import type { GitRunner, GitRunOptions } from "../../git/runner.js";
import { SshKeySigner } from "../../git/signer.js";
import { reverify } from "../../lease/reverify.js";
import type { RuntimeBackend } from "../../runtime/types.js";
import { FakeClock } from "../fake-clock.js";
import { rngRandomSource } from "../rng.js";
import type { SimWorld } from "../world.js";
import { converge, publish, publishHuman, requireScenario } from "./claim-race.js";
import type { Scenario } from "./index.js";

type Mode = "work" | "fixup" | "failure" | "checkpoint" | "stale" | "secret" | "lost-ack";
const REPO = "app";
export interface CrashCase {
  step: string;
  mode?: Mode;
  phase?: string;
}

/** Includes every §9.7 step, plus the records on either side of external side effects. */
export const CRASH_CASES: readonly CrashCase[] = [
  ...[
    "claimed",
    "worktree_created",
    "preflight_ok",
    "invocation_started",
    "invoked",
    "invocation_done",
    "commit_prepared",
    "committed",
    "checks_started",
    "check_started",
    "check_run",
    "checks",
    "secret_scan_ok",
    "pushed",
    "reverified",
    "pr",
    "publish_pending",
    "delivered_published",
  ].map((step) => ({ step })),
  { step: "checks", phase: "work" },
  { step: "reverified", phase: "work.delivered" },
  { step: "fixup", mode: "fixup" },
  { step: "invoked", mode: "fixup", phase: "fixup" },
  { step: "fixup_done", mode: "fixup" },
  { step: "commit_prepared", mode: "fixup", phase: "fixup" },
  { step: "committed", mode: "fixup", phase: "fixup" },
  { step: "checks", mode: "fixup", phase: "fixup" },
  { step: "failed", mode: "failure" },
  { step: "checkpointed", mode: "checkpoint" },
  { step: "stale", mode: "stale" },
  { step: "secret_detected", mode: "secret" },
  { step: "publish_failed", mode: "lost-ack" },
  { step: "push_effect" },
  { step: "pr_effect" },
  { step: "publish_effect" },
];

export class SimCrash extends Error {
  constructor(readonly point: string) {
    super(`Simulated daemon crash at ${point}`);
    this.name = "SimCrash";
  }
}

export interface CrashOutcome {
  point: string;
  task: string;
  status: string;
  invocations: Record<string, number>;
  pushes: number;
  prs: number;
}

const outcomes = new WeakMap<SimWorld, CrashOutcome[]>();
export function crashOutcomes(world: SimWorld): readonly CrashOutcome[] {
  return outcomes.get(world) ?? [];
}

export function crashEveryStepScenario(cases: readonly CrashCase[] = CRASH_CASES): Scenario {
  return {
    name: "crash-every-step",
    devices: ["mac"],
    steps: 1,
    async setup(world) {
      const node = world.node("mac");
      await publish(world, node, () =>
        draft(
          "agent.registered",
          null,
          node.agent,
          {
            role: "coding",
            agent_cli: "codex",
            cli_version: "0.0.0-test",
            capabilities: [],
            requires_local: [],
            max_parallel_items: 1,
          },
          {},
        ),
      );
      const base = await codeBase(world);
      const host = new FakeCodeHost({ git: world.git, repo: REPO, repoDir: world.codeRemote });
      world.codeHost = {
        remoteBranchSha: host.remoteBranchSha.bind(host),
        pullRequests: () => host.list().map((pr) => ({ repo: REPO, head: pr.head })),
      };
      const results: CrashOutcome[] = [];
      outcomes.set(world, results);
      for (const [index, point] of cases.entries()) {
        results.push(await exerciseCrash(world, host, base, index, point));
        await world.check();
      }
    },
  };
}

export const crashEveryStep = crashEveryStepScenario();

async function codeBase(world: SimWorld): Promise<string> {
  const node = world.node("mac");
  const cwd = node.clone.dir;
  const blob = async (text: string) =>
    ShaSchema.parse(
      (await world.git.run(["hash-object", "-w", "--stdin"], { cwd, input: text })).stdout.trim(),
    );
  const tree = async (text: string) =>
    ShaSchema.parse((await world.git.run(["mktree"], { cwd, input: text })).stdout.trim());
  const checks = await blob(
    'schema = "skep.checks/v1"\n[checks.unit]\nargv = ["example-check"]\nparser = "tap"\n',
  );
  const skep = await tree(`100644 blob ${checks}\tchecks.toml\n`);
  const example = await blob("Example base\n");
  const root = await tree(`040000 tree ${skep}\t.skep\n100644 blob ${example}\texample.txt\n`);
  const ident = {
    name: "Skep Example",
    email: "skep@example.invalid",
    timestampSec: Math.floor(node.clock.nowMs() / 1000),
    tz: "+0000",
  };
  const sha = await writeSignedCommit(world.git, cwd, {
    tree: root,
    parents: [],
    author: ident,
    committer: ident,
    message: "Example trusted checks\n",
    signer: new SshKeySigner({ principal: "daemon:mac", keyPath: join(world.root, "keys", "mac") }),
  });
  await world.git.run(["push", world.codeRemote, `${sha}:refs/heads/main`], { cwd });
  return sha;
}

async function exerciseCrash(
  world: SimWorld,
  host: FakeCodeHost,
  base: string,
  index: number,
  point: CrashCase,
): Promise<CrashOutcome> {
  const node = world.node("mac");
  const task = `T-20261006-${index.toString(16).padStart(4, "0")}`;
  const key: AttemptKey = { task, item: "W1", epoch: 1 };
  const plan = PlanSchema.parse({
    schema: "skep.plan/v1",
    task_id: task,
    version: 1,
    parent_version: null,
    base: { repo: REPO, branch: "main", commit: base },
    mode: "solo",
    summary: "Recover an example attempt.",
    items: [
      {
        id: "W1",
        title: "Example change",
        role: "coding",
        assignee: node.agent,
        depends_on: [],
        touches: ["example.txt"],
        risk: "normal",
        acceptance: [{ kind: "check", name: "unit" }],
      },
    ],
    stack_order: ["W1"],
    changes_from_parent: null,
  });
  await publishHuman(world, () =>
    draft(
      "task.created",
      task,
      "human",
      {
        title: "Example restart",
        body: "Recover the example attempt safely.",
        repo: REPO,
        base_branch: "main",
        mode: "solo",
        owner: node.agent,
        budgets: { ...DEFAULT_BUDGETS },
        plan_approval: "human",
      },
      {},
    ),
  );
  await publish(world, node, (state) =>
    draft(
      "plan.proposed",
      task,
      node.agent,
      {
        version: 1,
        parent_version: null,
        plan,
        plan_hash: contentHash(plan),
        base_commit: base,
        reviewers: [],
      },
      { task_rev: state.tasks[task]?.rev, owner_gen: 1 },
    ),
  );
  await publishHuman(world, (state) =>
    draft(
      "plan.approved",
      task,
      "human",
      { plan_version: 1, plan_hash: contentHash(plan) },
      { task_rev: state.tasks[task]?.rev, plan_version: 1, plan_hash: contentHash(plan) },
    ),
  );
  await publish(
    world,
    node,
    claimIntent({ task_id: task, item: "W1", actor: node.agent, attempt_id: `att_crash${index}` }),
  );
  const input: AttemptInput = {
    lease: { task_id: task, item: "W1", epoch: 1, holder: node.agent },
    attemptId: `att_crash${index}`,
    plan,
    baseSha: base,
    prBase: "main",
    agentInstructions: "Implement the example change.",
    repoContext: "Example repository.",
    timeoutMs: 10_000,
  };
  const roleDir = join(world.root, "attempts", task);
  // Attempt timers run concurrently with real file I/O. Do not let an unrelated timer make
  // the scheduler advance past that I/O; these cases inject crashes rather than timeouts.
  const attemptClock = new FakeClock(world.time);
  const redactor = new Redactor();
  const journal = new Journal({ roleDir, clock: attemptClock, redactor });
  let armed = true;
  let crashed = false;
  const crash = (step: string, phase?: unknown) => {
    if (armed && point.step === step && (point.phase === undefined || point.phase === phase)) {
      armed = false;
      crashed = true;
      throw new SimCrash(step);
    }
  };
  const crashingJournal: AttemptRunnerDependencies["journal"] = {
    path: journal.path.bind(journal),
    read: journal.read.bind(journal),
    async append(attempt, record) {
      const saved = await journal.append(attempt, record);
      crash(record.step, record.phase ?? record.kind ?? record.before);
      return saved;
    },
  };
  const mirror = new CodeMirror({
    git: world.git,
    home: roleDir,
    worktreeRoot: join(roleDir, "worktrees"),
    repos: [{ name: REPO, url: world.codeRemote }],
  });
  const invocations: Record<string, number> = {};
  const groups = new Map<number, string>();
  let nextPid = 1000;
  const runtime: RuntimeBackend = {
    name: "native",
    isAlive: async (pgid, token) => groups.get(pgid) === token,
    async spawn(options) {
      const pid = ++nextPid;
      const token = `start-${pid}`;
      groups.set(pid, token);
      let exit = 0;
      if (options.argv[0] === "example-check") {
        const text = await readFile(join(options.cwd, "example.txt"), "utf8");
        exit = text.startsWith("good") ? 0 : 1;
        await writeFile(options.logPath, exit === 0 ? "ok 1 - example\n" : "not ok 1 - example\n");
      }
      return {
        pid,
        pgid: pid,
        startToken: token,
        wait: async () => {
          groups.delete(pid);
          return { code: exit, signal: null };
        },
        signalGroup: () => {
          groups.delete(pid);
        },
      };
    },
  };
  const env = { home: join(roleDir, "home"), user: "agent", source: {} };
  const fake = new FakeAdapter({
    clock: attemptClock,
    seed: world.seed,
    scripts: {
      work:
        point.mode === "failure"
          ? { kind: "permissionPrompt" }
          : {
              kind: "success",
              files: [
                { path: "example.txt", content: point.mode === "fixup" ? "bad\n" : "good\n" },
              ],
            },
      fixup: { kind: "success", files: [{ path: "example.txt", content: "good\n" }] },
    },
  });
  let pushes = 0;
  const git: GitRunner = {
    async run(args: string[], options: GitRunOptions) {
      const pushing = args.includes("push");
      const result = await world.git.run(args, options);
      if (pushing) {
        pushes++;
        crash("push_effect");
      }
      return result;
    },
  };
  const codeHost: AttemptRunnerDependencies["codeHost"] = {
    remoteBranchSha: host.remoteBranchSha.bind(host),
    findPr: host.findPr.bind(host),
    prState: host.prState.bind(host),
    retargetPr: host.retargetPr.bind(host),
    closePr: host.closePr.bind(host),
    async createPr(repo, params) {
      const pr = await host.createPr(repo, params);
      crash("pr_effect");
      return pr;
    },
  };
  const attemptRandom = rngRandomSource(world.rng.fork(`attempt:${task}`));
  const checkRandom = rngRandomSource(world.rng.fork(`checks:${task}`));
  let initialRunner: AttemptRunner | undefined;
  const dependencies = (
    durable: AttemptRunnerDependencies["journal"],
  ): AttemptRunnerDependencies => ({
    git,
    mirror,
    journal: durable,
    clock: attemptClock,
    codeHost,
    runtime,
    agentEnv: env,
    redactor,
    signer: new SshKeySigner({ principal: "daemon:mac", keyPath: join(world.root, "keys", "mac") }),
    ident: { name: "Skep Daemon", email: "skepd@example.invalid", tz: "+0000" },
    scratchDir: join(roleDir, "scratch"),
    random: attemptRandom,
    checks: new ChecksRunner({
      git: world.git,
      mirror,
      journal: durable,
      clock: attemptClock,
      env,
      runtime,
      random: checkRandom,
    }),
    adapter: (backend) => ({
      cli: fake.cli,
      probe: fake.probe.bind(fake),
      async invoke(invocation) {
        const handle = await backend.spawn({
          argv: ["example-agent"],
          cwd: invocation.cwd,
          env: invocation.env,
          logPath: invocation.logPath,
        });
        invocations[invocation.kind] = (invocations[invocation.kind] ?? 0) + 1;
        const result = await fake.invoke(invocation);
        await handle.wait();
        return result;
      },
    }),
    scanSecrets: async () => ({ status: point.mode === "secret" ? "secrets_detected" : "clean" }),
    reverify: async (lease) => (point.mode === "stale" ? "stale" : reverify(node.sync, lease)),
    preflight:
      point.mode === "checkpoint"
        ? async () => {
            await publishHuman(world, (state) =>
              draft(
                "replan.requested",
                task,
                "human",
                { item: "W1", summary: "Checkpoint the example attempt.", evidence: [] },
                { task_rev: state.tasks[task]?.rev },
              ),
            );
            const state = await node.sync.observeNow();
            const barrier = state.tasks[task]?.barrier?.id;
            requireScenario(
              world,
              barrier && initialRunner,
              "Missing checkpoint barrier or runner",
            );
            await initialRunner.interrupt(key, barrier);
          }
        : undefined,
    publisher: {
      async publish(intent, options) {
        const result = await node.publisher.publish(intent, options);
        if (armed && point.mode === "lost-ack")
          return {
            status: "failed",
            eventId: result.eventId,
            reason: "Simulated lost acknowledgement",
          };
        crash("publish_effect");
        return result;
      },
    },
  });
  await mkdir(env.home, { recursive: true });
  try {
    initialRunner = new AttemptRunner(dependencies(crashingJournal));
    await initialRunner.run(input);
  } catch (error) {
    if (
      !(error instanceof SimCrash) &&
      !(error instanceof Error && error.cause instanceof SimCrash)
    ) {
      throw error;
    }
  }
  requireScenario(world, crashed, `Crash point ${point.step} was not exercised`);
  // Fresh runner/checks/journal over the same disk state; only fake external host state survives.
  const recoveredJournal = new Journal({ roleDir, clock: attemptClock, redactor });
  const recovered = dependencies(recoveredJournal);
  const reconciler = new AttemptReconciler({
    ...recovered,
    journal: recoveredJournal,
    observeNow: () => node.sync.observeNow(),
    processes: {
      startToken: async (pid) => groups.get(pid) ?? null,
      killGroup: async (pgid) => {
        groups.delete(pgid);
      },
    },
  });
  await reconciler.reconcile();
  requireScenario(
    world,
    (await reconciler.reconcile()).length === 0,
    "Recovery did not finish idempotently",
  );
  const records = await recoveredJournal.read(key);
  const final = records.at(-1);
  requireScenario(
    world,
    final && ["delivered_published", "failed", "checkpointed", "stale"].includes(final.step),
    "Missing terminal recovery record",
  );
  const state = await converge(world);
  const events = state.outcomes.filter(
    (entry) =>
      entry.task_id === task &&
      ["work.delivered", "work.failed", "checkpoint.recorded"].includes(entry.type ?? "") &&
      entry.outcome === "accepted",
  );
  requireScenario(
    world,
    events.length === (point.mode === "stale" ? 0 : 1) &&
      state.outcomes.every((entry) => entry.outcome === "accepted"),
    "Recovery omitted, duplicated or rejected an event",
  );
  requireScenario(
    world,
    Object.values(invocations).every((count) => count === 1),
    "Recovery executed an invocation twice",
  );
  const prs = host.list().filter((pr) => pr.head === `skep/${task}/W1/e1`).length;
  requireScenario(world, prs <= 1 && pushes <= 1, "Recovery duplicated a PR or code push");
  if (point.mode === "stale") {
    // Release the still-held lease so the next independent crash case can claim its slot.
    await publishHuman(world, (latest) =>
      draft(
        "lease.revoked",
        task,
        "human",
        { item: "W1", epoch: 1, reason: "End the example stale attempt.", observed_hb: null },
        { task_rev: latest.tasks[task]?.rev, item: "W1" },
      ),
    );
  }
  return { point: point.step, task, status: final.step, invocations, pushes, prs };
}
