import { claimIntent, deliverIntent, draft, revokeIntent } from "../../core/intents.js";
import { type LeaseIdentity, reverify } from "../../lease/reverify.js";
import { SuspendDetector } from "../../lease/suspend.js";
import {
  approvePlan,
  deliveryDuties,
  ITEM,
  prepareTask,
  publishHuman,
  pushCode,
  requireDelivery,
  requireScenario,
  TASK,
} from "./claim-race.js";
import type { Scenario } from "./index.js";

export const sleepWakeRevoke: Scenario = {
  name: "sleep-wake-revoke",
  devices: ["mac", "vps"],
  steps: 8,
  async setup(world) {
    const code = await prepareTask(world, "mac.coding", "vps.coding");
    const oldHolder = world.node("mac");
    const newHolder = world.node("vps");
    const detector = new SuspendDetector(oldHolder.clock, 20_000);
    const identity: LeaseIdentity = {
      task_id: TASK,
      item: ITEM,
      holder: oldHolder.agent,
      epoch: 1,
    };
    let staleDelivery: ReturnType<typeof deliverIntent> | undefined;
    let sleepingTip = "";
    let sleepingMono = 0;
    oldHolder.duties = () => [
      claimIntent({ task_id: TASK, actor: oldHolder.agent, item: ITEM, attempt_id: "att_sleep" }),
    ];
    world.scheduler.schedule(world.time.now, "claim-and-suspend", async () => {
      await oldHolder.tick();
      const branch = oldHolder.state.tasks[TASK]?.items[ITEM]?.lease?.branch;
      requireScenario(world, branch, "Sleeping holder did not acquire epoch 1");
      const head = await pushCode(world, code, oldHolder, branch);
      staleDelivery = deliverIntent({
        task_id: TASK,
        actor: oldHolder.agent,
        item: ITEM,
        epoch: 1,
        head_sha: head,
        submit: {
          method: "pr",
          state: "opened",
          pr_url: "https://example.invalid/pull/1",
          pr_number: 1,
        },
        check_runs: [],
      });
      requireScenario(
        world,
        staleDelivery(oldHolder.state) !== null,
        "Old delivery was never valid",
      );
      detector.setHeldLeases([identity]);
      sleepingTip = oldHolder.state.tip;
      sleepingMono = oldHolder.clock.monotonicMs();
      oldHolder.clock.suspend();
    });
    world.scheduler.schedule(world.time.now + 60_000, "human-revoke-and-reassign", async () => {
      requireScenario(world, oldHolder.clock.suspended, "Holder must sleep through revocation");
      await publishHuman(
        world,
        revokeIntent({
          task_id: TASK,
          item: ITEM,
          epoch: 1,
          reason: "Holder is suspended; move the work to vps.",
        }),
      );
      // §6.1 only permits the approved assignee to claim. Reassignment therefore needs a new
      // human-approved plan, while the item's epoch counter survives activation (§5.5).
      await publishHuman(world, (state) => {
        const task = state.tasks[TASK];
        return task
          ? draft(
              "replan.requested",
              TASK,
              "human",
              { summary: "Move the revoked item to vps.", evidence: [], item: ITEM },
              { task_rev: task.rev },
            )
          : null;
      });
      await approvePlan(world, code, newHolder.agent);
      newHolder.duties = deliveryDuties(world, code, newHolder.agent);
      await newHolder.tick();
      requireScenario(
        world,
        newHolder.state.tasks[TASK]?.items[ITEM]?.lease?.epoch === 2,
        "Replacement must claim epoch 2",
      );
      requireScenario(
        world,
        oldHolder.state.tip === sleepingTip &&
          oldHolder.state.tasks[TASK]?.items[ITEM]?.lease?.epoch === 1,
        "Suspended holder's observation must remain stale",
      );
      requireScenario(
        world,
        oldHolder.clock.monotonicMs() === sleepingMono,
        "Suspend advanced the holder's monotonic clock",
      );
    });
    world.scheduler.schedule(
      world.time.now + 3 * 60 * 60_000,
      "wake-reverify-and-deliver-current-epoch",
      async () => {
        oldHolder.clock.resume();
        requireScenario(
          world,
          detector.tick() && detector.paused && !detector.isVerified(identity),
          "Wake did not invalidate the old lease",
        );
        requireScenario(
          world,
          (await reverify(oldHolder.sync, identity)) === "stale",
          "Epoch 1 reverify must fail",
        );
        requireScenario(
          world,
          !(await detector.verifyHeld(oldHolder.sync)) && detector.paused,
          "Stale holder must remain paused",
        );
        requireScenario(
          world,
          staleDelivery && staleDelivery(oldHolder.state) === null,
          "Stale delivery intent must be invalidated",
        );
        oldHolder.duties = () => (staleDelivery ? [staleDelivery] : []);
        await oldHolder.tick();
        requireScenario(
          world,
          oldHolder.publications.at(-1)?.status === "dropped" && code.host.list().length === 0,
          "Stale holder published a delivery or opened a PR",
        );
        await newHolder.tick();
        await requireDelivery(world, 2, newHolder.agent);
        requireScenario(
          world,
          (await code.host.remoteBranchSha(
            "https://example.invalid/code.git",
            branchForEpochOne(),
          )) !== null,
          "Keep the stale epoch branch for forensics",
        );
      },
    );
  },
};

function branchForEpochOne(): string {
  return `skep/${TASK}/${ITEM}/e1`;
}
