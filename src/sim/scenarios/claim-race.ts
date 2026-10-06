import { join } from "node:path";
import { FakeCodeHost } from "../../codehost/fake.js";
import { canonicalJson, contentHash } from "../../core/canonical.js";
import { claimIntent, deliverIntent, draft, type Intent } from "../../core/intents.js";
import type { State } from "../../core/reducer/state.js";
import { DEFAULT_BUDGETS, ShaSchema } from "../../core/schemas/common.js";
import { PlanSchema } from "../../core/schemas/plan.js";
import { writeSignedCommit } from "../../git/commit.js";
import { SshKeySigner } from "../../git/signer.js";
import { reverify } from "../../lease/reverify.js";
import { type SimDuties, type SimNode, type SimWorld, SimWorldError } from "../world.js";
import type { Scenario } from "./index.js";

export const TASK = "T-20261005-0404";
export const ITEM = "W1";
export const REPO = "https://example.invalid/code.git";

// Shared scenario scripts live in an owned scenario file to keep SK-401's harness unchanged.
export function requireScenario(
  world: SimWorld,
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new SimWorldError(
      `Protocol scenario failed (seed ${world.seed}, step ${world.scheduler.steps}): ${message}`,
    );
  }
}

export async function converge(world: SimWorld): Promise<State> {
  const awake = world.nodes.filter((node) => !node.clock.suspended);
  for (const node of awake) await node.sync.observeNow();
  const state = awake[0]?.state;
  requireScenario(world, state, "Missing observation node");
  requireScenario(
    world,
    awake.every((node) => canonicalJson(node.state) === canonicalJson(state)),
    "Nodes did not converge",
  );
  return state;
}

export async function publish(world: SimWorld, node: SimNode, intent: Intent): Promise<void> {
  const result = await world.scheduler.execute(() => node.publisher.publish(intent));
  requireScenario(
    world,
    result.status === "accepted",
    `Expected accepted publication, received ${result.status}: ${result.reason ?? "no reason"}`,
  );
}

export async function publishHuman(world: SimWorld, intent: Intent): Promise<void> {
  const result = await world.publishHuman(
    intent,
    world.nodes.find((node) => !node.clock.suspended)?.agent,
  );
  requireScenario(
    world,
    result.status === "accepted",
    `Expected accepted human publication, received ${result.status}: ${result.reason ?? "no reason"}`,
  );
}

export interface ScenarioCode {
  base: string;
  host: FakeCodeHost;
}

async function codeCommit(
  world: SimWorld,
  node: SimNode,
  parents: string[],
  text: string,
): Promise<string> {
  const cwd = node.clone.dir;
  const blob = ShaSchema.parse(
    (
      await world.git.run(["hash-object", "-t", "blob", "-w", "--stdin"], { cwd, input: text })
    ).stdout.trim(),
  );
  const tree = ShaSchema.parse(
    (
      await world.git.run(["mktree"], { cwd, input: `100644 blob ${blob}\texample.txt\n` })
    ).stdout.trim(),
  );
  const ident = {
    name: "Skep Example",
    email: "skep@example.invalid",
    timestampSec: Math.floor(node.clock.nowMs() / 1_000),
    tz: "+0000",
  };
  return writeSignedCommit(world.git, cwd, {
    tree,
    parents,
    author: ident,
    committer: ident,
    message: "Scripted example change\n",
    signer: new SshKeySigner({
      principal: `daemon:${node.device}`,
      keyPath: join(world.root, "keys", node.device),
    }),
  });
}

export async function pushCode(
  world: SimWorld,
  code: ScenarioCode,
  node: SimNode,
  branch: string,
): Promise<string> {
  await world.git.run(["fetch", world.codeRemote, "refs/heads/main"], { cwd: node.clone.dir });
  const sha = await codeCommit(world, node, [code.base], `Example change for ${branch}\n`);
  await world.git.run(["push", world.codeRemote, `${sha}:refs/heads/${branch}`], {
    cwd: node.clone.dir,
  });
  return sha;
}

export async function approvePlan(
  world: SimWorld,
  code: ScenarioCode,
  assignee: string,
): Promise<void> {
  const owner = world.node("mac").state.tasks[TASK]?.owner;
  requireScenario(world, owner, "Task has no owner");
  await publish(world, world.node(owner), (state) => {
    const task = state.tasks[TASK];
    if (!task) return null;
    const version = (task.current_plan_version ?? 0) + 1;
    const plan = PlanSchema.parse({
      schema: "skep.plan/v1",
      task_id: TASK,
      version,
      parent_version: task.current_plan_version,
      base: { repo: REPO, branch: "main", commit: code.base },
      mode: "solo",
      summary: "Publish one example change.",
      items: [
        {
          id: ITEM,
          title: "Example change",
          role: "coding",
          assignee,
          depends_on: [],
          touches: ["example.txt"],
          risk: "normal",
          acceptance: [{ kind: "manual", text: "Inspect the example change." }],
        },
      ],
      stack_order: [ITEM],
      changes_from_parent: version === 1 ? null : "Move the example work to an available assignee.",
    });
    return draft(
      "plan.proposed",
      TASK,
      owner,
      {
        version,
        parent_version: task.current_plan_version,
        plan,
        plan_hash: contentHash(plan),
        base_commit: code.base,
        reviewers: [],
      },
      { task_rev: task.rev, owner_gen: task.owner_gen },
    );
  });
  await publishHuman(world, (state) => {
    const task = state.tasks[TASK];
    const plan = task?.plans[String(task.current_plan_version)];
    return task && plan
      ? draft(
          "plan.approved",
          TASK,
          "human",
          { plan_version: plan.version, plan_hash: plan.plan_hash },
          { task_rev: task.rev, plan_version: plan.version, plan_hash: plan.plan_hash },
        )
      : null;
  });
  await converge(world);
}

export async function prepareTask(
  world: SimWorld,
  assignee = "mac.coding",
  owner = "mac.coding",
): Promise<ScenarioCode> {
  // Only the assignee and owner need registry entries; extra race nodes are independent writers.
  for (const agent of new Set([assignee, owner])) {
    await publish(world, world.node(agent), () =>
      draft(
        "agent.registered",
        null,
        agent,
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
  }
  const node = world.node("mac");
  const base = await codeCommit(world, node, [], "Example base\n");
  await world.git.run(["push", world.codeRemote, `${base}:refs/heads/main`], {
    cwd: node.clone.dir,
  });
  const host = new FakeCodeHost({ git: world.git, repo: REPO, repoDir: world.codeRemote });
  const code: ScenarioCode = {
    base,
    host,
  };
  world.codeHost = {
    remoteBranchSha: host.remoteBranchSha.bind(host),
    pullRequests: () => host.list().map((pr) => ({ repo: REPO, head: pr.head })),
  };
  await publishHuman(world, () =>
    draft(
      "task.created",
      TASK,
      "human",
      {
        title: "Protocol example",
        body: "Publish one example change safely.",
        repo: REPO,
        base_branch: "main",
        mode: "solo",
        owner,
        budgets: { ...DEFAULT_BUDGETS },
        plan_approval: "human",
      },
      {},
    ),
  );
  await converge(world);
  await approvePlan(world, code, assignee);
  return code;
}

export function deliveryDuties(world: SimWorld, code: ScenarioCode, actor: string): SimDuties {
  return async (node, state) => {
    const item = state.tasks[TASK]?.items[ITEM];
    if (item?.status === "ready")
      return [claimIntent({ task_id: TASK, actor, item: ITEM, attempt_id: "att_example" })];
    const lease = item?.lease;
    if (!lease || lease.holder !== actor) return [];
    const identity = { task_id: TASK, item: ITEM, holder: actor, epoch: lease.epoch };
    requireScenario(
      world,
      (await reverify(node.sync, identity)) === "ok",
      "Current holder failed reverify before pushing code",
    );
    // ARCHITECTURE §7.5/§6.3: code first, then a freshly authorized PR and delivery record.
    const head = await pushCode(world, code, node, lease.branch);
    const found = await code.host.findPr(REPO, lease.branch);
    requireScenario(
      world,
      (await reverify(node.sync, identity)) === "ok",
      "Holder became stale before opening a PR",
    );
    const pr =
      found ??
      (await code.host.createPr(REPO, {
        head: lease.branch,
        base: "main",
        title: "Example change",
        body: "Publish the example change after re-verifying its lease.",
      }));
    requireScenario(
      world,
      (await reverify(node.sync, identity)) === "ok",
      "Holder became stale before recording delivery",
    );
    return [
      deliverIntent({
        task_id: TASK,
        actor,
        item: ITEM,
        epoch: lease.epoch,
        head_sha: head,
        pr_url: pr.url,
        pr_number: pr.number,
        check_runs: [],
      }),
    ];
  };
}

export async function requireDelivery(
  world: SimWorld,
  epoch: number,
  actor: string,
): Promise<void> {
  const state = await converge(world);
  const deliveries = state.outcomes.filter(
    (outcome) => outcome.type === "work.delivered" && outcome.outcome === "accepted",
  );
  requireScenario(
    world,
    deliveries.length === 1 && deliveries[0]?.actor === actor,
    "Expected exactly one delivery by the current holder",
  );
  requireScenario(
    world,
    state.tasks[TASK]?.items[ITEM]?.delivered?.epoch === epoch &&
      state.tasks[TASK]?.status === "delivered",
    "Wrong delivered epoch or task status",
  );
  requireScenario(
    world,
    (await world.codeHost?.pullRequests())?.length === 1,
    "Expected one fake code-host PR",
  );
}

export const claimRace: Scenario = {
  name: "claim-race",
  devices: Array.from({ length: 8 }, (_, i) => ({
    device: "mac",
    agent: i === 0 ? "mac.coding" : `mac.coding.${i}`,
  })),
  steps: 16,
  async setup(world) {
    const code = await prepareTask(world);
    const racers = world.rng.fork("claim-race").shuffle(world.nodes);
    const claims: { tip: string; epoch: number | undefined }[] = [];
    for (const [index, node] of racers.entries()) {
      const claim = claimIntent({
        task_id: TASK,
        actor: "mac.coding",
        item: ITEM,
        attempt_id: `att_race${index}`,
      });
      node.duties = () => [
        (state) => {
          const event = claim(state);
          if (event) claims.push({ tip: state.tip, epoch: event.pre.expected_epoch });
          return event;
        },
      ];
      const rival = racers[index + 1];
      if (rival)
        node.git.inject({
          fault: {
            kind: "competing-push",
            push: async () => {
              await world.scheduler.execute(() => rival.tick());
            },
          },
        });
    }
    world.scheduler.schedule(world.time.now, "eight-way-claim-race", async () => {
      const first = racers[0];
      requireScenario(world, first, "Missing race participant");
      await first.tick();
      const results = racers.flatMap((node) => node.publications);
      requireScenario(
        world,
        claims.length === 8 &&
          new Set(claims.map((claim) => claim.tip)).size === 1 &&
          claims.every((claim) => claim.epoch === 0),
        "All eight writers must contend from the same tip and epoch",
      );
      requireScenario(
        world,
        results.filter((result) => result.status === "accepted").length === 1 &&
          results.filter((result) => result.status === "dropped").length === 7,
        "Race must accept one claim and drop seven stale intents",
      );
      const state = await converge(world);
      requireScenario(
        world,
        state.tasks[TASK]?.epochs[ITEM] === 1,
        "Race advanced the epoch more than once",
      );
      const holder = world.node("mac.coding");
      holder.duties = deliveryDuties(world, code, holder.agent);
      await holder.tick();
      await requireDelivery(world, 1, holder.agent);
    });
  },
};
