import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FakeAdapter } from "../../adapter/fake.js";
import { LivenessTracker } from "../../blackboard/liveness.js";
import { FakeCodeHost } from "../../codehost/fake.js";
import { contentHash } from "../../core/canonical.js";
import { draft } from "../../core/intents.js";
import { DEFAULT_BUDGETS } from "../../core/schemas/common.js";
import { PlanSchema } from "../../core/schemas/plan.js";
import { Daemon } from "../../daemon/daemon.js";
import { Duties } from "../../daemon/duties.js";
import { SlotRegistry } from "../../daemon/slots.js";
import { AttemptRunner } from "../../exec/attempt.js";
import { ChecksRunner } from "../../exec/checks.js";
import { Journal } from "../../exec/journal.js";
import { Redactor } from "../../exec/redact.js";
import { CodeMirror } from "../../exec/worktree.js";
import { writeSignedCommit } from "../../git/commit.js";
import type { GitRunner } from "../../git/runner.js";
import { SshKeySigner } from "../../git/signer.js";
import { reverify } from "../../lease/reverify.js";
import { SuspendDetector } from "../../lease/suspend.js";
import { rngRandomSource } from "../rng.js";
import { type SimWorld, SimWorldError } from "../world.js";
import type { Scenario } from "./index.js";

const TASK = "T-20261005-0601";
const REPO = "https://example.invalid/code.git";

/** These scenarios exercise production duties and attempts; the human approval/merge gates are scripted. */
export async function daemonHappyScenario(world: SimWorld, team: boolean): Promise<void> {
  const owner = world.node("mac");
  const signer = new SshKeySigner({
    principal: "daemon:mac",
    keyPath: join(world.root, "keys/mac"),
  });
  const files: [string, string][] = [
    ["example.txt", "Example base\n"],
    [
      ".skep/checks.toml",
      'schema = "skep.checks/v1"\n[checks.unit]\nargv = ["node", "-e", "process.exit(0)"]\n',
    ],
  ];
  const blobs = [];
  for (const [path, content] of files) {
    const blob = (
      await world.git.run(["hash-object", "-w", "--stdin"], {
        cwd: owner.clone.dir,
        input: content,
      })
    ).stdout.trim();
    blobs.push({ path, blob });
  }
  const checksTree = (
    await world.git.run(["mktree"], {
      cwd: owner.clone.dir,
      input: `100644 blob ${blobs[1]?.blob}\tchecks.toml\n`,
    })
  ).stdout.trim();
  const tree = (
    await world.git.run(["mktree"], {
      cwd: owner.clone.dir,
      input: `040000 tree ${checksTree}\t.skep\n100644 blob ${blobs[0]?.blob}\texample.txt\n`,
    })
  ).stdout.trim();
  const ident = {
    name: "Skep Example",
    email: "skep@example.invalid",
    timestampSec: Math.floor(world.clock.nowMs() / 1_000),
    tz: "+0000",
  };
  const base = await writeSignedCommit(world.git, owner.clone.dir, {
    tree,
    parents: [],
    author: ident,
    committer: ident,
    message: "Example base\n",
    signer,
  });
  await world.git.run(["push", world.codeRemote, `${base}:refs/heads/main`], {
    cwd: owner.clone.dir,
  });
  const host = new FakeCodeHost({ git: world.git, repoDir: world.codeRemote, repo: REPO });
  const prs: { repo: string; head: string }[] = [];
  world.codeHost = { remoteBranchSha: host.remoteBranchSha.bind(host), pullRequests: () => prs };
  const plan = PlanSchema.parse({
    schema: "skep.plan/v1",
    task_id: TASK,
    version: 1,
    parent_version: null,
    base: { repo: REPO, branch: "main", commit: base },
    mode: team ? "team" : "solo",
    summary: "Publish example changes through production daemon duties.",
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
      ...(team
        ? [
            {
              id: "W2",
              title: "Second example",
              role: "coding",
              assignee: "vps.coding",
              depends_on: ["W1"],
              touches: ["two.txt"],
              risk: "normal",
              acceptance: [{ kind: "check", name: "unit" }],
            },
          ]
        : []),
    ],
    stack_order: team ? ["W1", "W2"] : ["W1"],
    changes_from_parent: null,
  });
  for (const node of world.nodes) {
    const roleDir = join(world.root, "roles", node.agent);
    const agentHome = join(world.root, "agents", node.agent);
    const scratch = join(world.root, "scratch", node.agent);
    await mkdir(roleDir, { recursive: true });
    await mkdir(agentHome, { recursive: true });
    await mkdir(scratch, { recursive: true });
    const adapter = new FakeAdapter({
      clock: node.clock,
      seed: world.seed,
      version: "0.0.0-test",
      scripts: {
        plan: { kind: "success", output: plan },
        review: {
          kind: "success",
          output: {
            schema: "skep.review/v1",
            plan_version: 1,
            plan_hash: contentHash(plan),
            verdict: "approve",
            blockers: [],
            suggestions: [],
          },
        },
        work: {
          kind: "success",
          files: [
            {
              path: node.device === "mac" ? "one.txt" : "two.txt",
              content: `Example work by ${node.agent}\n`,
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
    await node.publisher.publish(() =>
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
    const journal = new Journal({ roleDir, clock: node.clock, redactor });
    const checks = new ChecksRunner({
      git: codeGit,
      mirror,
      journal,
      clock: node.clock,
      env: slot.envOptions,
      random: rngRandomSource(world.rng.fork(`checks:${node.agent}`)),
    });
    const nodeSigner = new SshKeySigner({
      principal: `daemon:${node.device}`,
      keyPath: join(world.root, "keys", node.device),
    });
    const attempt = new AttemptRunner({
      mirror,
      git: codeGit,
      signer: nodeSigner,
      ident: { name: "Skep Daemon", email: "skepd@example.invalid", tz: "+0000" },
      agentEnv: slot.envOptions,
      adapter,
      checks,
      scanSecrets: async () => ({ status: "clean" }),
      redactor,
      codeHost: {
        remoteBranchSha: host.remoteBranchSha.bind(host),
        findPr: host.findPr.bind(host),
        createPr: async (repo, params) => {
          const pr = await host.createPr(repo, params);
          prs.push({ repo, head: pr.head });
          return pr;
        },
        closePr: host.closePr.bind(host),
        retargetPr: host.retargetPr.bind(host),
        prState: host.prState.bind(host),
      },
      reverify: (lease) => reverify(node.sync, lease),
      publisher: node.publisher,
      journal,
      clock: node.clock,
      random: rngRandomSource(world.rng.fork(`attempt:${node.agent}`)),
      scratchDir: scratch,
    });
    const duties = new Duties({
      slots,
      clock: node.clock,
      random: rngRandomSource(world.rng.fork(`duties:${node.agent}`)),
      publisher: node.publisher,
      current: () => node.state,
      plan: async () => {
        await mirror.fetch(REPO);
        const result = await adapter.invoke({
          kind: "plan",
          cwd: roleDir,
          prompt: "Draft the example plan.",
          outputSchema: {},
          timeoutMs: 60_000,
          env: slot.env,
          logPath: join(scratch, "plan.log"),
          scratchDir: scratch,
          signal: new AbortController().signal,
        });
        return JSON.parse(result.finalMessage ?? "null");
      },
      review: async () => {
        const result = await adapter.invoke({
          kind: "review",
          cwd: roleDir,
          prompt: "Review the example plan.",
          outputSchema: {},
          timeoutMs: 60_000,
          env: slot.env,
          logPath: join(scratch, "review.log"),
          scratchDir: scratch,
          signal: new AbortController().signal,
        });
        return JSON.parse(result.finalMessage ?? "null");
      },
      verifyReview: async (review) => review,
      validation: (_slot, state, task) => ({
        state,
        task,
        loadChecks: (repo, commit) => checks.load(repo, commit),
        pathExists: async (_repo, commit, path) =>
          path === "." ||
          (
            await codeGit.run(["cat-file", "-e", `${commit}:${path}`], {
              cwd: await mirror.mirrorPath(REPO),
              allowFailure: true,
            })
          ).code === 0,
      }),
      attempt: () => attempt,
      onError: (cause) => {
        throw new SimWorldError("Daemon happy scenario duty failed", { cause });
      },
      wake: () => {},
      recordStale: (_slot, lease) =>
        journal.append(
          { task: lease.task_id, item: lease.item, epoch: lease.epoch },
          { step: "stale" },
        ),
    });
    const daemon = new Daemon({
      sync: node.sync,
      publisher: node.publisher,
      slots,
      duties,
      suspend: new SuspendDetector(node.clock, 20_000),
      liveness: new LivenessTracker(node.clock),
      heartbeat: () => ({ beat: async () => {} }),
      clock: node.clock,
      random: rngRandomSource(world.rng.fork(`daemon:${node.agent}`)),
    });
    node.duties = async () => {
      await daemon.tick();
      await duties.settle();
      return [];
    };
  }
  await world.publishHuman(() =>
    draft(
      "task.created",
      TASK,
      "human",
      {
        title: "Daemon example",
        body: "Deliver the example stack.",
        repo: REPO,
        base_branch: "main",
        mode: team ? "team" : "solo",
        owner: "mac.coding",
        budgets: { ...DEFAULT_BUDGETS },
        submit: "device",
        plan_approval: "human",
      },
      {},
    ),
  );
  world.startTicks(20_000);
  let approved = false;
  const start = world.time.now;
  for (let round = 1; round <= 12; round++) {
    world.scheduler.schedule(start + round * 20_000 + 1_000, `human:${round}`, async () => {
      await owner.sync.observeNow();
      const task = owner.state.tasks[TASK];
      if (task?.status === "awaiting_approval" && !approved) {
        const record = task.plans[String(task.current_plan_version)];
        if (!record) throw new SimWorldError("Daemon did not propose a plan");
        const result = await world.publishHuman((state) => {
          const current = state.tasks[TASK];
          return current
            ? draft(
                "plan.approved",
                TASK,
                "human",
                { plan_version: record.version, plan_hash: record.plan_hash },
                {
                  task_rev: current.rev,
                  plan_version: record.version,
                  plan_hash: record.plan_hash,
                },
              )
            : null;
        });
        if (result.status !== "accepted") throw new SimWorldError("Human approval did not land");
        approved = true;
        return;
      }
      if (task?.status !== "delivered") return;
      if (team) {
        const first = task.items.W1?.delivered;
        const second = task.items.W2?.delivered;
        if (!first || !second) throw new SimWorldError("Team stack lacks deliveries");
        const parent = (
          await world.git.run(["rev-parse", `${second.head_sha}^`], { cwd: world.codeRemote })
        ).stdout.trim();
        const pr = await host.findPr(REPO, second.branch);
        if (parent !== first.head_sha || pr?.base !== first.branch)
          throw new SimWorldError("W2 must start from W1's delivered SHA and target W1's branch");
      }
      // SK-606 owns automatic verification/merge observation; script those gates after asserting delivery.
      for (const id of plan.stack_order) {
        const delivery = owner.state.tasks[TASK]?.items[id]?.delivered;
        if (!delivery) throw new SimWorldError("Missing delivered item before human merge");
        const prNumber = delivery.submit.pr_number;
        if (prNumber === undefined) throw new Error("Scenario delivery has no PR number");
        if (id !== "W1") await host.retargetPr(REPO, prNumber, "main");
        await host.merge(prNumber);
        await owner.publisher.publish((state) => {
          const current = state.tasks[TASK];
          return current
            ? draft(
                "item.merged",
                TASK,
                owner.agent,
                { item: id, pr_number: prNumber, merge_sha: delivery.head_sha },
                {
                  task_rev: current.rev,
                  item: id,
                  owner_gen: current.owner_gen,
                  plan_version: 1,
                  plan_hash: contentHash(plan),
                },
              )
            : null;
        });
      }
      if (owner.state.tasks[TASK]?.status !== "done")
        throw new SimWorldError("Happy scenario did not finish after human merges");
    });
  }
  world.scheduler.schedule(start + 260_000, "expect:done", async () => {
    await owner.sync.observeNow();
    if (owner.state.tasks[TASK]?.status !== "done")
      throw new SimWorldError("Happy scenario did not finish after human approval and merges");
  });
}

export const soloHappy: Scenario = {
  name: "solo-happy",
  devices: ["mac"],
  steps: 40,
  setup: (world) => daemonHappyScenario(world, false),
};
