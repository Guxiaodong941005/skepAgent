import { deliveryDuties, prepareTask, requireDelivery, requireScenario } from "./claim-race.js";
import type { Scenario } from "./index.js";

export const lostAck: Scenario = {
  name: "lost-ack",
  devices: ["mac", "vps"],
  steps: 8,
  async setup(world) {
    const code = await prepareTask(world);
    const holder = world.node("mac");
    holder.duties = deliveryDuties(world, code, holder.agent);
    world.scheduler.schedule(world.time.now, "lost-claim-ack", async () => {
      holder.git.inject({ fault: { kind: "lost-ack" } });
      await holder.tick();
      requireScenario(
        world,
        holder.publications[0]?.status === "accepted",
        "Lost claim ack was not reconciled",
      );
    });
    world.scheduler.schedule(world.time.now + 10_000, "lost-delivery-ack", async () => {
      holder.git.inject({ fault: { kind: "lost-ack" } });
      await holder.tick();
      requireScenario(
        world,
        holder.publications.length === 2 &&
          holder.publications.every((result) => result.status === "accepted"),
        "Lost ack retries did not recover the original results",
      );
      requireScenario(
        world,
        holder.git.history.filter((fault) => fault.kind === "lost-ack").length === 2,
        "Both acknowledgements must be lost",
      );
      requireScenario(
        world,
        new Set(holder.state.outcomes.map((outcome) => outcome.event_id)).size ===
          holder.state.outcomes.length,
        "Lost ack appended a duplicate event",
      );
      await requireDelivery(world, 1, holder.agent);
    });
  },
};
