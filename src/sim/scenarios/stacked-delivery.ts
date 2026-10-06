import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FakeAdapter } from "../../adapter/fake.js";
import { FakeCodeHost } from "../../codehost/fake.js";
import { contentHash } from "../../core/canonical.js";
import { intentFromSpec } from "../../core/intent-spec.js";
import { draft } from "../../core/intents.js";
import { DEFAULT_BUDGETS } from "../../core/schemas/common.js";
import { EventSchema } from "../../core/schemas/events.js";
import { PlanSchema } from "../../core/schemas/plan.js";
import { createDeliveryDuty } from "../../daemon/delivery.js";
import { Duties } from "../../daemon/duties.js";
import { registrationIntent, SlotRegistry } from "../../daemon/slots.js";
import { AttemptRunner } from "../../exec/attempt.js";
import { ChecksRunner } from "../../exec/checks.js";
import { Journal } from "../../exec/journal.js";
import { Redactor } from "../../exec/redact.js";
import { CodeMirror } from "../../exec/worktree.js";
import { writeSignedCommit } from "../../git/commit.js";
import { readLog } from "../../git/log-reader.js";
import type { GitRunner } from "../../git/runner.js";
import { SshKeySigner } from "../../git/signer.js";
import { reverify } from "../../lease/reverify.js";
import { NativeRuntime } from "../../runtime/native.js";
import { FakeClock } from "../fake-clock.js";
import { rngRandomSource } from "../rng.js";
import type { SimWorld } from "../world.js";
import { converge, publish, publishHuman, requireScenario } from "./claim-race.js";
import type { Scenario } from "./index.js";

export const STACKED_TASK = "T-20261005-0606";
const REPO = "https://example.invalid/code.git";

export interface StackedDeliveryOutcome {
  statuses: string[];
  notifications: string[];
  verificationExits: number[][];
  mergeShas: string[];
  secondBase: string;
}
const outcomes = new WeakMap<SimWorld, StackedDeliveryOutcome>();
export function stackedDeliveryOutcome(world: SimWorld): StackedDeliveryOutcome | undefined {
  return outcomes.get(world);
}

async function runStack(world: SimWorld): Promise<void> {
  const owner = world.node("mac");
  const cwd = owner.clone.dir;
  // The first item's check passes alone and fails when both items are combined. The simulated
  // runtime clears that flaky condition only after the human resumes, without changing the SHA.
  const checksSource = `schema = "skep.checks/v1"
[checks.unit]
argv = ["node", "-e", "const fs = require('node:fs'); process.exit(fs.existsSync('two.txt') && !process.env.EXAMPLE_RESUMED ? 1 : 0)"]
[checks.integration]
argv = ["node", "-e", "const fs = require('node:fs'); process.exit(fs.existsSync('one.txt') && fs.existsSync('two.txt') ? 0 : 1)"]
`;
  const blob = (
    await world.git.run(["hash-object", "-w", "--stdin"], {
      cwd,
      input: checksSource,
    })
  ).stdout.trim();
  const checksTree = (
    await world.git.run(["mktree"], {
      cwd,
      input: `100644 blob ${blob}\tchecks.toml\n`,
    })
  ).stdout.trim();
  const tree = (
    await world.git.run(["mktree"], {
      cwd,
      input: `040000 tree ${checksTree}\t.skep\n`,
    })
  ).stdout.trim();
  const signer = new SshKeySigner({
    principal: "daemon:mac",
    keyPath: join(world.root, "keys/mac"),
  });
  const identity = {
    name: "Skep Example",
    email: "skep@example.invalid",
    timestampSec: Math.floor(world.clock.nowMs() / 1_000),
    tz: "+0000",
  };
  const base = await writeSignedCommit(world.git, cwd, {
    tree,
    parents: [],
    author: identity,
    committer: identity,
    message: "Example trusted checks\n",
    signer,
  });
  await world.git.run(["push", world.codeRemote, `${base}:refs/heads/main`], { cwd });
  const host = new FakeCodeHost({ git: world.git, repoDir: world.codeRemote, repo: REPO });
  world.codeHost = host;
  const plan = PlanSchema.parse({
    schema: "skep.plan/v1",
    task_id: STACKED_TASK,
    version: 1,
    parent_version: null,
    base: { repo: REPO, branch: "main", commit: base },
    mode: "team",
    summary: "Deliver and verify the combined example stack.",
    changes_from_parent: null,
    items: [
      {
        id: "W1",
        title: "First example",
        role: "coding",
        assignee: "mac.coding",
        depends_on: [],
        touches: ["one.txt"],
        risk: "normal",
        acceptance: [{ kind: "check", name: "unit" }],
      },
      {
        id: "W2",
        title: "Second example",
        role: "coding",
        assignee: "vps.coding",
        depends_on: ["W1"],
        touches: ["two.txt"],
        risk: "normal",
        acceptance: [{ kind: "check", name: "integration" }],
      },
    ],
    stack_order: ["W1", "W2"],
  });
  const outcome: StackedDeliveryOutcome = {
    statuses: [],
    notifications: [],
    verificationExits: [],
    mergeShas: [],
    secondBase: "",
  };
  outcomes.set(world, outcome);
  let resumed = false;
  const controllers: Duties[] = [];
  for (const node of world.nodes) {
    // Supervision timers must not make live filesystem/process I/O look quiescent to the
    // scheduler. This shares virtual time, like the crash-every-step scenario's attempt clock.
    const serviceClock = new FakeClock(world.time);
    const roleDir = join(world.root, "roles", node.agent);
    const agentHome = join(world.root, "agents", node.agent);
    const scratchDir = join(world.root, "scratch", node.agent);
    for (const dir of [roleDir, agentHome, scratchDir]) await mkdir(dir, { recursive: true });
    const adapter = new FakeAdapter({
      clock: serviceClock,
      seed: world.seed,
      version: "0.0.0-test",
      scripts: {
        work: {
          kind: "success",
          files: [
            {
              path: node.device === "mac" ? "one.txt" : "two.txt",
              content: "Example change\n",
            },
          ],
        },
      },
    });
    const slots = new SlotRegistry({
      device: node.device,
      adapter: () => adapter,
      resolveUser: async () => ({}),
      loadPolicy: async () => ({
        file: join(roleDir, "AGENT.md"),
        body: "Implement the assigned example item.",
        frontMatter: {
          schema: "skep.agent/v1",
          role: "coding",
          agent_cli: "codex",
          cli_version: "0.0.0-test",
          repos: [REPO],
          capabilities: [],
          requires_local: [],
          max_parallel_items: 1,
          budgets: { max_invocation_minutes: 1 },
        },
      }),
    });
    const slot = await slots.start({
      roleDir,
      home: agentHome,
      user: "skep",
      path: process.env.PATH ?? "",
    });
    await publish(world, node, registrationIntent(slot));
    const codeGit: GitRunner = {
      run: (args, opts) =>
        world.git.run(
          args.map((arg) => (arg === REPO ? world.codeRemote : arg)),
          opts,
        ),
    };
    const mirror = new CodeMirror({
      git: codeGit,
      home: join(world.root, "code", node.agent),
      repos: [{ name: "code", url: REPO }],
      worktreeRoot: join(roleDir, ".skep/worktrees"),
    });
    const redactor = new Redactor();
    const journal = new Journal({ roleDir, clock: serviceClock, redactor });
    const native = new NativeRuntime({ clock: serviceClock });
    const checks = new ChecksRunner({
      git: codeGit,
      mirror,
      journal,
      clock: serviceClock,
      env: slot.envOptions,
      random: rngRandomSource(world.rng.fork(`checks:${node.agent}`)),
      runtime: {
        name: "native",
        isAlive: native.isAlive.bind(native),
        spawn: (opts) =>
          native.spawn({
            ...opts,
            env: { ...opts.env, ...(resumed ? { EXAMPLE_RESUMED: "1" } : {}) },
          }),
      },
    });
    const attempt = new AttemptRunner({
      mirror,
      git: codeGit,
      signer: new SshKeySigner({
        principal: `daemon:${node.device}`,
        keyPath: join(world.root, "keys", node.device),
      }),
      ident: { name: "Skep Example", email: "skep@example.invalid", tz: "+0000" },
      agentEnv: slot.envOptions,
      adapter,
      checks,
      scanSecrets: async () => ({ status: "clean" }),
      redactor,
      codeHost: host,
      reverify: (lease) => reverify(node.sync, lease),
      publisher: node.publisher,
      journal,
      clock: serviceClock,
      random: rngRandomSource(world.rng.fork(`attempt:${node.agent}`)),
      scratchDir,
    });
    const duties = new Duties({
      slots,
      clock: node.clock,
      random: rngRandomSource(world.rng.fork(`duties:${node.agent}`)),
      publisher: node.publisher,
      current: () => node.state,
      plan: async () => {
        throw new Error("The scenario starts with an approved plan");
      },
      review: async () => {
        throw new Error("The scenario starts with completed reviews");
      },
      verifyReview: async (review) => review,
      validation: () => {
        throw new Error("The scenario starts with a validated plan");
      },
      attempt: () => attempt,
      wake: () => {},
      onError: (cause) => {
        throw cause;
      },
      recordStale: (_slot, lease) =>
        journal.append(
          { task: lease.task_id, item: lease.item, epoch: lease.epoch },
          { step: "stale" },
        ),
      delivery: createDeliveryDuty({
        clock: serviceClock,
        git: codeGit,
        mirror: () => mirror,
        checks: () => checks,
        codeHost: () => host,
        notify: async (message) => {
          outcome.notifications.push(message);
        },
      }),
    });
    controllers.push(duties);
  }
  await publishHuman(world, () =>
    draft(
      "task.created",
      STACKED_TASK,
      "human",
      {
        title: "Stacked example",
        body: "Verify the combined stack and observe human merges.",
        repo: REPO,
        base_branch: "main",
        mode: "team",
        owner: owner.agent,
        budgets: { ...DEFAULT_BUDGETS },
        plan_approval: "human",
      },
      {},
    ),
  );
  await publish(world, owner, (state) =>
    draft(
      "plan.proposed",
      STACKED_TASK,
      owner.agent,
      {
        version: 1,
        parent_version: null,
        plan,
        plan_hash: contentHash(plan),
        base_commit: base,
        reviewers: ["vps.coding"],
      },
      { task_rev: state.tasks[STACKED_TASK]?.rev, owner_gen: 1 },
    ),
  );
  await publish(world, owner, (state) =>
    draft(
      "plan.locked",
      STACKED_TASK,
      owner.agent,
      {
        plan_version: 1,
        plan_hash: contentHash(plan),
        overrides: [],
        missing_reviews: ["vps.coding"],
      },
      {
        task_rev: state.tasks[STACKED_TASK]?.rev,
        owner_gen: 1,
        plan_version: 1,
        plan_hash: contentHash(plan),
      },
    ),
  );
  const humanIntent = (spec: unknown) => {
    const intent = intentFromSpec(spec, {
      rng: rngRandomSource(world.rng),
      nowMs: world.clock.nowMs(),
    });
    requireScenario(world, intent, "Invalid human intent specification");
    return intent;
  };
  await publishHuman(world, humanIntent({ kind: "plan.approve", task: STACKED_TASK }));
  const tick = async (index: number) => {
    const node = world.nodes[index];
    const duties = controllers[index];
    requireScenario(world, node && duties, "Missing daemon duties");
    await node.sync.observeNow();
    duties.tick(node.state);
    await duties.settle();
    await world.check();
  };
  await tick(0);
  await tick(1);
  const delivered = (await converge(world)).tasks[STACKED_TASK];
  requireScenario(world, delivered?.status === "delivered", "Both items must be delivered");
  outcome.statuses.push(delivered.status);
  const first = delivered.items.W1?.delivered;
  const second = delivered.items.W2?.delivered;
  requireScenario(world, first && second, "Missing stack deliveries");
  const parent = (
    await world.git.run(["rev-parse", `${second.head_sha}^`], { cwd: world.codeRemote })
  ).stdout.trim();
  const secondPr = await host.findPr(REPO, second.branch);
  requireScenario(
    world,
    parent === first.head_sha && secondPr?.base === first.branch,
    "W2 must start from W1's delivered SHA and its PR must target W1's branch",
  );
  outcome.secondBase = secondPr.base;
  await tick(0);
  const failed = (await converge(world)).tasks[STACKED_TASK];
  requireScenario(
    world,
    failed?.status === "escalated" && failed.escalation?.reason === "verification_failed",
    "Failed combined verification must escalate",
  );
  outcome.statuses.push(failed.status);
  requireScenario(
    world,
    outcome.notifications.length === 1,
    "Verification failure must notify the human once",
  );
  await tick(0);
  requireScenario(
    world,
    owner.state.tasks[STACKED_TASK]?.verified?.seq === failed.verified?.seq,
    "Verification must not retry automatically",
  );
  // This is the same strict intent spec sent by `skep decide <task> --resume`.
  await publishHuman(
    world,
    humanIntent({ kind: "decide", task: STACKED_TASK, decision: "resume_with_plan" }),
  );
  resumed = true;
  const resumedTask = (await converge(world)).tasks[STACKED_TASK];
  requireScenario(
    world,
    resumedTask?.status === "delivered" && resumedTask.verified === null,
    "D15 resume must carry over the deliveries and permit verification again",
  );
  outcome.statuses.push(resumedTask.status);
  await tick(0);
  requireScenario(
    world,
    owner.state.tasks[STACKED_TASK]?.verified?.passed,
    "Resumed verification must pass",
  );
  outcome.mergeShas.push(await host.merge(first.pr_number));
  await tick(0);
  requireScenario(
    world,
    (await host.findPr(REPO, second.branch))?.base === "main",
    "The daemon must retarget the next PR after observing the lower merge",
  );
  outcome.mergeShas.push(await host.merge(second.pr_number));
  await tick(0);
  const done = (await converge(world)).tasks[STACKED_TASK];
  requireScenario(world, done?.status === "done", "Human merges must complete the task");
  outcome.statuses.push(done.status);
  for (const node of world.nodes) await node.sync.observeNow();
  const events = await readLog(world.git, owner.clone.dir, owner.trustPath);
  for (const entry of events) {
    if (entry.seq === 0) continue;
    for (const raw of Object.values(entry.added)) {
      requireScenario(world, typeof raw === "string", "Missing event content");
      const event = EventSchema.parse(JSON.parse(raw));
      if (event.type === "task.verified")
        outcome.verificationExits.push(event.payload.check_runs.map((run) => run.exit));
      requireScenario(
        world,
        event.type !== "work.failed",
        "Combined verification must never emit work.failed",
      );
    }
  }
  await world.check();
}

export const stackedDelivery: Scenario = {
  name: "stacked-delivery",
  devices: ["mac", "vps"],
  steps: 0,
  setup: runStack,
};
