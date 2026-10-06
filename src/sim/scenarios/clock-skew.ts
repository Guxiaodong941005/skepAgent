import { readHeartbeats } from "../../blackboard/heartbeat.js";
import { LivenessTracker } from "../../blackboard/liveness.js";
import { canonicalJson } from "../../core/canonical.js";
import { replay } from "../../core/reducer/replay.js";
import { parseEventFile, serializeEvent } from "../../core/schemas/events.js";
import { readLog } from "../../git/log-reader.js";
import { reverify } from "../../lease/reverify.js";
import { SuspendDetector } from "../../lease/suspend.js";
import { FakeClock } from "../fake-clock.js";
import {
  deliveryDuties,
  ITEM,
  prepareTask,
  requireDelivery,
  requireScenario,
  TASK,
} from "./claim-race.js";
import type { Scenario } from "./index.js";

export const clockSkew: Scenario = {
  name: "clock-skew",
  devices: [
    { device: "mac", skewMs: 24 * 60 * 60_000 },
    { device: "vps", skewMs: -24 * 60 * 60_000 },
  ],
  steps: 8,
  async setup(world) {
    const code = await prepareTask(world);
    const holder = world.node("mac");
    const observer = world.node("vps");
    const controlClock = new FakeClock(world.time);
    const trackers = [new LivenessTracker(observer.clock), new LivenessTracker(controlClock)];
    const detectors = [
      new SuspendDetector(holder.clock, 20_000),
      new SuspendDetector(controlClock, 20_000),
    ];
    holder.duties = deliveryDuties(world, code, holder.agent);
    world.scheduler.schedule(world.time.now, "skewed-claim", async () => {
      await holder.tick();
      const heartbeat = (
        await readHeartbeats(world.git, world.blackboardRemote, world.trustPath, {
          [holder.agent]: holder.device,
        })
      )[holder.agent];
      requireScenario(world, heartbeat?.hb, "Skewed holder heartbeat is missing");
      for (const tracker of trackers) {
        tracker.observe(holder.agent, heartbeat.oid, heartbeat.hb);
        tracker.observe(holder.agent, heartbeat.oid, heartbeat.hb);
        requireScenario(
          world,
          tracker.classify(holder.agent).cls === "live",
          "Sender wall skew changed live classification",
        );
      }
    });
    world.scheduler.schedule(
      world.time.now + 3 * 60 * 60_000,
      "skewed-lease-does-not-expire",
      async () => {
        requireScenario(
          world,
          canonicalJson(trackers[0]?.classify(holder.agent)) ===
            canonicalJson(trackers[1]?.classify(holder.agent)) &&
            trackers[0]?.classify(holder.agent).cls === "lost",
          "Skew changed observer-relative liveness",
        );
        requireScenario(
          world,
          detectors.every((detector) => !detector.tick() && !detector.paused),
          "Constant wall skew was mistaken for suspend",
        );
        requireScenario(
          world,
          (await reverify(holder.sync, {
            task_id: TASK,
            item: ITEM,
            holder: holder.agent,
            epoch: 1,
          })) === "ok",
          "Wall time or lost liveness expired a lease without a human revoke",
        );
        await holder.tick();
        await requireDelivery(world, 1, holder.agent);
        const entries = await readLog(world.git, world.blackboardRemote, world.trustPath);
        const changedDates = entries.map((entry) => ({
          ...entry,
          added: Object.fromEntries(
            Object.entries(entry.added).map(([path, content]) => {
              if (content === null) return [path, content];
              const event = parseEventFile(content);
              return [
                path,
                event.ok
                  ? serializeEvent({ ...event.event, created_at: "2000-01-01T00:00:00Z" })
                  : content,
              ];
            }),
          ),
        }));
        requireScenario(
          world,
          canonicalJson(replay(entries)) === canonicalJson(replay(changedDates)),
          "Event wall timestamps changed reducer decisions",
        );
      },
    );
  },
};
