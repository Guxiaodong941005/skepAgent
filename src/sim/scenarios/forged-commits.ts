import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../../core/canonical.js";
import { eventPath } from "../../core/ids.js";
import { claimIntent, draft, type EventDraft, finalizeEvent } from "../../core/intents.js";
import { DEFAULT_BUDGETS, ShaSchema } from "../../core/schemas/common.js";
import { serializeEvent } from "../../core/schemas/events.js";
import { buildCommitText, writeSignedCommit, writeTreeFromIndex } from "../../git/commit.js";
import { SshKeySigner } from "../../git/signer.js";
import { isoUtc } from "../../util/clock.js";
import { newEventId } from "../../util/random.js";
import { rngRandomSource } from "../rng.js";
import type { SimWorld } from "../world.js";
import {
  converge,
  deliveryDuties,
  ITEM,
  prepareTask,
  REPO,
  requireDelivery,
  requireScenario,
  TASK,
} from "./claim-race.js";
import type { Scenario } from "./index.js";

type Attack = "unsigned" | "wrong-principal" | "daemon-task" | "merge";

async function forge(world: SimWorld, attack: Attack): Promise<void> {
  const node = world.node("mac");
  await node.clone.fetch();
  const tip = await node.clone.resetToRemoteMain();
  const state = await node.sync.replayTo(tip);
  const claim = claimIntent({
    task_id: TASK,
    actor: node.agent,
    item: ITEM,
    attempt_id: "att_forged",
  })(state);
  const eventDraft: EventDraft | null =
    attack === "daemon-task"
      ? draft(
          "task.created",
          "T-20261005-ffff",
          node.agent,
          {
            title: "Unauthorized example task",
            body: "A daemon cannot create a task.",
            repo: REPO,
            base_branch: "main",
            mode: "solo",
            owner: node.agent,
            budgets: { ...DEFAULT_BUDGETS },
            plan_approval: "human",
          },
          {},
        )
      : claim;
  requireScenario(world, eventDraft, "Forged event must be structurally valid before the attack");
  const event = finalizeEvent(eventDraft, {
    event_id: newEventId(rngRandomSource(world.rng.fork(`forged:${attack}`))),
    observed_tip: tip,
    created_at: isoUtc(node.clock.nowMs()),
  });
  const path = eventPath(event.task_id, event.event_id);
  const file = join(node.clone.dir, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeEvent(event), { flag: "wx" });
  await world.git.run(["add", "--", path], { cwd: node.clone.dir });
  const ident = {
    name: "Skep Example",
    email: "skep@example.invalid",
    timestampSec: Math.floor(node.clock.nowMs() / 1_000),
    tz: "+0000",
  };
  const fields = {
    tree: await writeTreeFromIndex(world.git, node.clone.dir),
    parents: attack === "merge" ? [tip, state.genesis_sha] : [tip],
    author: ident,
    committer: ident,
    message: `Forged example: ${attack}\n`,
  };
  const device = attack === "wrong-principal" ? "vps" : "mac";
  const sha =
    attack === "unsigned"
      ? ShaSchema.parse(
          (
            await world.git.run(["hash-object", "-t", "commit", "-w", "--stdin"], {
              cwd: node.clone.dir,
              input: buildCommitText(fields),
            })
          ).stdout.trim(),
        )
      : await writeSignedCommit(world.git, node.clone.dir, {
          ...fields,
          signer: new SshKeySigner({
            principal: `daemon:${device}`,
            keyPath: join(world.root, "keys", device),
          }),
        });
  // Deliberately bypass Publisher to model an attacker writing the hosted remote (§13.3).
  await world.git.run(["push", "origin", `${sha}:refs/heads/main`], { cwd: node.clone.dir });
}

export const forgedCommits: Scenario = {
  name: "forged-commits",
  devices: ["mac", "vps"],
  steps: 8,
  async setup(world) {
    const code = await prepareTask(world);
    const before = world.node("mac").state;
    const alarms: string[] = [];
    world.node("vps").sync.onAlarm((alarm) => {
      if (alarm.kind === "invalid_commit") alarms.push(alarm.outcome.reason ?? "missing reason");
    });
    const attacks: readonly [Attack, string][] = [
      ["unsigned", "unsigned"],
      ["wrong-principal", "unauthorized"],
      ["daemon-task", "unauthorized"],
      ["merge", "not_linear"],
    ];
    for (const [index, [attack, reason]] of attacks.entries()) {
      world.scheduler.schedule(world.time.now + index * 1_000, `forge:${attack}`, async () => {
        await forge(world, attack);
        const state = await converge(world);
        const outcome = state.outcomes.at(-1);
        requireScenario(
          world,
          outcome?.reason === reason &&
            outcome.outcome === (reason === "unauthorized" ? "rejected" : "invalid"),
          `Wrong audit outcome for ${attack}`,
        );
        requireScenario(
          world,
          canonicalJson(state.tasks) === canonicalJson(before.tasks) &&
            canonicalJson(state.agents) === canonicalJson(before.agents) &&
            canonicalJson(state.seen_event_ids) === canonicalJson(before.seen_event_ids),
          "Forged commit changed protocol state or reserved an event ID",
        );
        if (index === attacks.length - 1) {
          requireScenario(
            world,
            canonicalJson(alarms) === canonicalJson(["unsigned", "not_linear"]),
            "Sync did not alarm on both structurally invalid commits",
          );
          const holder = world.node("mac");
          holder.duties = deliveryDuties(world, code, holder.agent);
          await holder.tick();
          await holder.tick();
          await requireDelivery(world, 1, holder.agent);
        }
      });
    }
  },
};
