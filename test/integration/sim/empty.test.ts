import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readHeartbeats } from "../../../src/blackboard/heartbeat.js";
import { canonicalJson } from "../../../src/core/canonical.js";
import { draft } from "../../../src/core/intents.js";
import { replay } from "../../../src/core/reducer/replay.js";
import { readLog } from "../../../src/git/log-reader.js";
import { SimInvariantError } from "../../../src/sim/invariants.js";
import { runScenario } from "../../../src/sim/runner.js";
import { getScenario, UnknownScenarioError } from "../../../src/sim/scenarios/index.js";
import { SimWorld } from "../../../src/sim/world.js";
import { tempDir } from "../../helpers/git-fixture.js";
import { agentRegistered, taskCreated } from "../../helpers/log-builder.js";

describe("empty simulation and production-backed world", () => {
  let root: string;
  beforeAll(async () => {
    root = await tempDir("sim-empty-");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([0, 42, "example-seed"])(
    "runs two idle nodes with zero violations for seed %s",
    async (seed) => {
      const result = await runScenario("empty", seed, { root });
      expect(result).toEqual({
        finalTip: expect.stringMatching(/^[a-f0-9]{40}$/),
        steps: 12,
        violations: [],
      });
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("reproduces the final tip in fresh directories and isolates seeded genesis identities", async () => {
    const first = await runScenario("empty", 42, { root, steps: 2 });
    const second = await runScenario("empty", 42, { root, steps: 2 });
    expect(second).toEqual(first);
    const other = await runScenario("empty", 43, { root, steps: 2 });
    expect(other.finalTip).not.toBe(first.finalTip);
  });

  it("keeps main at human-signed genesis and replaces each heartbeat with a single signed orphan", async () => {
    const world = await SimWorld.create({ seed: 42, devices: ["mac", "vps"], root });
    try {
      expect(world.nodes.map((node) => node.clone.dir)).toHaveLength(2);
      expect(new Set(world.nodes.map((node) => node.clone.dir)).size).toBe(2);
      for (const remote of [world.blackboardRemote, world.codeRemote]) {
        expect(
          (
            await world.git.run(["rev-parse", "--is-bare-repository"], { cwd: remote })
          ).stdout.trim(),
        ).toBe("true");
      }
      const originalTip = await world.finalTip();
      world.startTicks();
      await world.run(12);
      expect(await world.finalTip()).toBe(originalTip);
      const entries = await readLog(world.git, world.blackboardRemote, world.trustPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.signature).toEqual({ status: "good", principal: "human" });
      const heartbeats = await readHeartbeats(world.git, world.blackboardRemote, world.trustPath, {
        "mac.coding": "mac",
        "vps.coding": "vps",
      });
      expect(Object.keys(heartbeats).sort()).toEqual(["mac.coding", "vps.coding"]);
      for (const [agent, observation] of Object.entries(heartbeats)) {
        expect(observation.problem).toBeNull();
        expect(observation.hb).toMatchObject({
          agent,
          state: "idle",
          n: 2,
          observed_main: originalTip,
        });
        const count = await world.git.run(["rev-list", "--count", `refs/heads/hb/${agent}`], {
          cwd: world.blackboardRemote,
        });
        expect(count.stdout.trim()).toBe("1");
      }
      expect(world.violations).toEqual([]);
      expect(world.scheduler.trace).toHaveLength(12);
    } finally {
      await world.close();
    }
  });

  it("uses duties and the human signer to publish real events and agrees after incremental sync", async () => {
    async function run() {
      const world = await SimWorld.create({
        seed: 17,
        root,
        devices: [
          {
            device: "mac",
            duties: (node) => [
              (state) =>
                state.agents[node.agent]
                  ? null
                  : draft("agent.registered", null, node.agent, agentRegistered(), {}),
            ],
          },
          "vps",
        ],
      });
      try {
        world.scheduler.schedule(world.time.now, "register", () => world.node("mac").tick());
        await world.run(1);
        const result = await world.publishHuman(() =>
          draft(
            "task.created",
            "T-20261005-0001",
            "human",
            taskCreated({ repo: "https://example.invalid/code.git", owner: "mac.coding" }),
            {},
          ),
        );
        expect(result.status).toBe("accepted");
        for (const node of world.nodes) await node.sync.observeNow();
        await world.check();
        const entries = await readLog(world.git, world.blackboardRemote, world.trustPath);
        expect(entries).toHaveLength(3);
        expect(entries.map((entry) => entry.signature)).toEqual([
          { status: "good", principal: "human" },
          { status: "good", principal: "daemon:mac" },
          { status: "good", principal: "human" },
        ]);
        expect(world.nodes.map((node) => canonicalJson(node.state))).toEqual([
          canonicalJson(replay(entries)),
          canonicalJson(replay(entries)),
        ]);
        expect(
          await readFile(join(world.node("mac").clone.dir, "skep.json"), "utf8"),
        ).not.toContain(root);
        return { entries, tip: await world.finalTip() };
      } finally {
        await world.close();
      }
    }
    expect(await run()).toEqual(await run());
  });

  it("drives a delayed lost acknowledgement through the production publisher without duplicate events", async () => {
    const world = await SimWorld.create({ seed: 23, devices: ["mac", "vps"], root });
    try {
      const node = world.node("mac");
      node.git.inject({ command: "fetch", fault: { kind: "delay", ms: 100 } });
      node.git.inject({ fault: { kind: "lost-ack" } });
      const result = await world.scheduler.execute(() =>
        node.publisher.publish(() =>
          draft("agent.registered", null, node.agent, agentRegistered(), {}),
        ),
      );
      expect(result.status).toBe("accepted");
      const entries = await readLog(world.git, world.blackboardRemote, world.trustPath);
      expect(entries).toHaveLength(2);
      expect(node.state.outcomes).toHaveLength(1);
      expect(world.time.now).toBeGreaterThan(node.clock.nowMs() - node.clock.monotonicMs());
      expect(world.violations).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("checks invariant 7 after every step and reports seed, step and log on failure", async () => {
    const world = await SimWorld.create({ seed: 31, devices: ["mac", "vps"], root });
    try {
      await world.scheduler.execute(() => world.node("mac").tick());
      world.scheduler.schedule(world.time.now, "corrupt-heartbeat", async () => {
        await world.git.run(["update-ref", "refs/heads/hb/mac.coding", await world.finalTip()], {
          cwd: world.blackboardRemote,
        });
      });
      await expect(world.run(1)).rejects.toThrow(SimInvariantError);
      expect(world.violations[0]).toMatchObject({
        invariant: 7,
        seed: 31,
        step: 1,
        code: "invalid_heartbeat_ref",
        logDump: expect.stringContaining("genesis"),
      });
    } finally {
      await world.close();
    }
  });

  it("rejects unknown scenario names and invalid step limits before creating a world", async () => {
    expect(getScenario("empty").devices).toEqual(["mac", "vps"]);
    for (const name of ["unknown", "toString", "__proto__"]) {
      await expect(runScenario(name, 42, { root })).rejects.toThrow(UnknownScenarioError);
    }
    await expect(runScenario("empty", 42, { root, steps: -1 })).rejects.toThrow("steps");
    expect(await readdir(root)).toEqual([]);
  });

  it("returns invariant failures as result JSON and cleans up the failed run", async () => {
    const setup = vi.spyOn(getScenario("empty"), "setup").mockImplementation((world) => {
      world.scheduler.schedule(world.time.now, "corrupt-heartbeat", async () => {
        await world.git.run(["update-ref", "refs/heads/hb/mac.coding", await world.finalTip()], {
          cwd: world.blackboardRemote,
        });
      });
    });
    try {
      const result = await runScenario("empty", 42, { root, steps: 1 });
      expect(result.steps).toBe(1);
      expect(result.violations).toEqual([
        expect.objectContaining({ invariant: 7, seed: 42, step: 1 }),
      ]);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
      expect(await readdir(root)).toEqual([]);
    } finally {
      setup.mockRestore();
    }
  });
});
