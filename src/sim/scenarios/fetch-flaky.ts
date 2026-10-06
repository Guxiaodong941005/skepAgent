import { canonicalJson } from "../../core/canonical.js";
import { GitError } from "../../git/runner.js";
import { deliveryDuties, prepareTask, requireDelivery, requireScenario } from "./claim-race.js";
import type { Scenario } from "./index.js";

export const fetchFlaky: Scenario = {
  name: "fetch-flaky",
  devices: ["mac", "vps"],
  steps: 16,
  async setup(world) {
    const code = await prepareTask(world);
    const holder = world.node("mac");
    const duty = deliveryDuties(world, code, holder.agent);
    let armed = false;
    holder.duties = async (node, state) => {
      const intents = await duty(node, state);
      if (!armed) {
        armed = true;
        const rng = world.rng.fork("fetch-faults");
        for (let i = 0; i < rng.int(2, 4); i++)
          holder.git.inject({ fault: { kind: "failed-fetch" } });
        holder.git.inject({ command: "fetch", fault: { kind: "delay", ms: rng.int(10, 100) } });
        holder.git.inject({ command: "fetch", fault: { kind: "partition", ms: 100 } });
      }
      return intents;
    };
    world.scheduler.schedule(world.time.now, "flaky-observation-and-claim", async () => {
      const before = holder.sync.current();
      holder.git.inject({ fault: { kind: "failed-fetch" } });
      let failed = false;
      try {
        await holder.sync.observeNow();
      } catch (error) {
        if (!(error instanceof GitError)) throw error;
        failed = true;
      }
      requireScenario(world, failed, "Scripted observation did not fail");
      requireScenario(
        world,
        canonicalJson(holder.sync.current()) === canonicalJson(before),
        "Failed fetch changed cached state or freshness",
      );
      await holder.tick();
      requireScenario(
        world,
        holder.publications[0]?.status === "accepted",
        "Publisher did not recover from fetch failures",
      );
    });
    world.scheduler.schedule(world.time.now + 30_000, "deliver-after-fetch-recovery", async () => {
      await holder.tick();
      const kinds = new Set(holder.git.history.map((fault) => fault.kind));
      requireScenario(
        world,
        ["failed-fetch", "delay", "partition"].every((kind) =>
          kinds.has(kind as "failed-fetch" | "delay" | "partition"),
        ),
        "Fetch fault script was not fully exercised",
      );
      await requireDelivery(world, 1, holder.agent);
    });
  },
};
