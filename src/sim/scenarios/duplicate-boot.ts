import { join } from "node:path";
import {
  DuplicateDaemonError,
  type HeartbeatDraft,
  HeartbeatWriter,
  readHeartbeats,
} from "../../blackboard/heartbeat.js";
import { LivenessTracker } from "../../blackboard/liveness.js";
import { SshKeySigner } from "../../git/signer.js";
import { requireScenario } from "./claim-race.js";
import type { Scenario } from "./index.js";

export const duplicateBoot: Scenario = {
  name: "duplicate-boot",
  devices: ["mac", "vps"],
  steps: 8,
  async setup(world) {
    const node = world.node("mac");
    const observer = world.node("vps");
    const tracker = new LivenessTracker(observer.clock);
    const main = await world.finalTip();
    const beat: HeartbeatDraft = {
      state: "idle",
      task_id: null,
      item: null,
      epoch: null,
      observed_main: main,
      runtime: "native",
    };
    let originalBoot = "";
    const rivalBoot = `b_${Buffer.from(world.rng.fork("duplicate-boot").bytes(8)).toString("hex")}`;
    async function observe(): Promise<string> {
      await observer.sync.observeNow();
      const observation = (
        await readHeartbeats(world.git, observer.clone.dir, observer.trustPath, {
          [node.agent]: node.device,
        })
      )[node.agent];
      requireScenario(world, observation?.hb, "Observer must read a verified heartbeat");
      tracker.observe(node.agent, observation.oid, observation.hb);
      return observation.hb.boot_id;
    }
    function writer(bootId: string): HeartbeatWriter {
      return new HeartbeatWriter({
        git: world.git,
        repoDir: node.clone.dir,
        agent: node.agent,
        signer: new SshKeySigner({
          principal: "daemon:mac",
          keyPath: join(world.root, "keys/mac"),
        }),
        clock: node.clock,
        bootId,
        onAlarm: (alarm) => node.alarms.push(alarm),
      });
    }
    world.scheduler.schedule(world.time.now, "original-boot", async () => {
      await node.heartbeat.beat(beat);
      originalBoot = await observe();
      requireScenario(world, tracker.alarms().length === 0, "First boot must not alarm");
    });
    world.scheduler.schedule(world.time.now + 1_000, "replacement-boot", async () => {
      await writer(rivalBoot).beat(beat);
      requireScenario(
        world,
        (await observe()) === rivalBoot && tracker.alarms().length === 0,
        "One clean restart must not alarm",
      );
      let alarmed = false;
      try {
        await node.heartbeat.beat(beat);
      } catch (error) {
        if (!(error instanceof DuplicateDaemonError)) throw error;
        alarmed = true;
      }
      requireScenario(
        world,
        alarmed &&
          node.alarms.length === 1 &&
          node.alarms[0]?.expectedOid !== node.alarms[0]?.actualOid,
        "Old writer must alarm on the heartbeat lease conflict",
      );
    });
    world.scheduler.schedule(world.time.now + 2_000, "superseded-boot-returns", async () => {
      // A competing process that adopts the tip can still reuse an old boot ID; F10 requires
      // the observer to catch that even when this write passes force-with-lease (§8.1).
      await writer(originalBoot).beat(beat);
      await observe();
      const alarm = tracker.alarms()[0];
      requireScenario(
        world,
        tracker.alarms().length === 1 &&
          alarm?.bootId === originalBoot &&
          alarm.supersededBy === rivalBoot,
        "Observer missed a superseded boot ID returning",
      );
      tracker.resetAll();
      requireScenario(
        world,
        tracker.alarms().length === 1,
        "Wake timer reset must preserve duplicate-daemon evidence",
      );
      requireScenario(
        world,
        (await world.finalTip()) === main,
        "Duplicate heartbeats changed main",
      );
    });
  },
};
