import { readdir, rm } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/canonical.js";
import { replay } from "../../../src/core/reducer/replay.js";
import { parseEventFile } from "../../../src/core/schemas/events.js";
import { readLog } from "../../../src/git/log-reader.js";
import { runScenario } from "../../../src/sim/runner.js";
import { ITEM, TASK } from "../../../src/sim/scenarios/claim-race.js";
import { getScenario } from "../../../src/sim/scenarios/index.js";
import { SimWorld } from "../../../src/sim/world.js";
import { tempDir } from "../../helpers/git-fixture.js";

const names = [
  "claim-race",
  "lost-ack",
  "fetch-flaky",
  "forged-commits",
  "sleep-wake-revoke",
  "duplicate-boot",
  "clock-skew",
] as const;
const seeds = Array.from({ length: 50 }, (_, index) => index);
let root: string;

beforeAll(async () => {
  root = await tempDir("sim-protocol-");
});
afterAll(async () => {
  try {
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe.each(names)("%s protocol scenario", (name) => {
  it.concurrent.each(seeds)("passes with zero violations for seed %i", async (seed) => {
    const result = await runScenario(name, seed, { root });
    expect(result.violations).toEqual([]);
    expect(result.finalTip).toMatch(/^[a-f0-9]{40}$/);
    expect(result.steps).toBeGreaterThan(0);
  });

  it("exercises its fault and leaves the required protocol outcome", async () => {
    const scenario = getScenario(name);
    const world = await SimWorld.create({ seed: 42, devices: scenario.devices, root });
    try {
      await world.scheduler.execute(() => scenario.setup(world));
      await world.run(scenario.steps);
      await world.check();
      expect(world.violations).toEqual([]);
      const entries = await readLog(world.git, world.blackboardRemote, world.trustPath);
      const state = replay(entries);
      const accepted = entries.flatMap((entry) => {
        if (state.outcomes[entry.seq - 1]?.outcome !== "accepted") return [];
        return Object.values(entry.added).flatMap((content) => {
          const event = content === null ? null : parseEventFile(content);
          return event?.ok ? [event.event] : [];
        });
      });
      const deliveries = accepted.filter((event) => event.type === "work.delivered");
      const claims = accepted.filter((event) => event.type === "lease.claimed");
      const faults = world.nodes.flatMap((node) => node.git.history);
      if (name === "duplicate-boot") {
        expect(entries).toHaveLength(1);
        expect(world.node("mac").alarms).toHaveLength(1);
        expect(world.scheduler.trace.map((step) => step.label)).toContain(
          "superseded-boot-returns",
        );
        return;
      }
      expect(deliveries).toHaveLength(1);
      const delivery = deliveries[0];
      expect(delivery?.type).toBe("work.delivered");
      if (delivery?.type !== "work.delivered") throw new Error("Missing delivery event");
      expect(
        await world.codeHost?.remoteBranchSha(
          state.tasks[TASK]?.repo ?? "",
          delivery.payload.branch,
        ),
      ).toBe(delivery.payload.head_sha);
      expect(await world.codeHost?.pullRequests()).toEqual([
        { repo: state.tasks[TASK]?.repo, head: delivery.payload.branch },
      ]);
      expect(world.nodes.every((node) => canonicalJson(node.state) === canonicalJson(state))).toBe(
        true,
      );
      switch (name) {
        case "claim-race":
          expect(world.nodes).toHaveLength(8);
          expect(faults.filter((fault) => fault.kind === "competing-push")).toHaveLength(7);
          expect(
            world.nodes
              .flatMap((node) => node.publications)
              .filter((result) => result.status === "dropped"),
          ).toHaveLength(7);
          expect(claims).toHaveLength(1);
          expect(state.tasks[TASK]?.epochs[ITEM]).toBe(1);
          break;
        case "lost-ack":
          expect(faults.filter((fault) => fault.kind === "lost-ack")).toHaveLength(2);
          expect(claims).toHaveLength(1);
          expect(world.node("mac").publications).toHaveLength(2);
          expect(state.outcomes.every((outcome) => outcome.outcome === "accepted")).toBe(true);
          break;
        case "fetch-flaky":
          expect(
            faults.filter((fault) => fault.kind === "failed-fetch").length,
          ).toBeGreaterThanOrEqual(3);
          expect(faults.some((fault) => fault.kind === "delay")).toBe(true);
          expect(faults.some((fault) => fault.kind === "partition")).toBe(true);
          expect(claims).toHaveLength(1);
          expect(world.time.now).toBeGreaterThan(world.scheduler.trace[0]?.at ?? 0);
          break;
        case "forged-commits":
          expect(
            state.outcomes
              .filter((outcome) => outcome.outcome !== "accepted")
              .map((outcome) => outcome.reason),
          ).toEqual(["unsigned", "unauthorized", "unauthorized", "not_linear"]);
          expect(
            entries.some(
              (entry) =>
                entry.signature.status === "good" && entry.signature.principal === "daemon:vps",
            ),
          ).toBe(true);
          expect(entries.filter((entry) => entry.parents.length === 2)).toHaveLength(1);
          expect(Object.keys(state.tasks)).toEqual([TASK]);
          expect(world.nodes.map((node) => node.sync.current().invalidCount)).toEqual([2, 2]);
          break;
        case "sleep-wake-revoke":
          expect(claims.map((event) => event.payload.branch)).toEqual([
            `skep/${TASK}/${ITEM}/e1`,
            `skep/${TASK}/${ITEM}/e2`,
          ]);
          expect(delivery).toMatchObject({
            actor: "vps.coding",
            payload: { epoch: 2, branch: `skep/${TASK}/${ITEM}/e2` },
          });
          expect(world.node("mac").publications.map((result) => result.status)).toEqual([
            "accepted",
            "dropped",
          ]);
          expect(accepted.filter((event) => event.type === "lease.revoked")).toHaveLength(1);
          expect(state.tasks[TASK]?.active_plan_version).toBe(2);
          expect(
            await world.codeHost?.remoteBranchSha(
              state.tasks[TASK]?.repo ?? "",
              `skep/${TASK}/${ITEM}/e1`,
            ),
          ).not.toBeNull();
          break;
        case "clock-skew":
          expect(world.node("mac").clock.nowMs() - world.node("vps").clock.nowMs()).toBe(
            2 * 24 * 60 * 60_000,
          );
          expect(world.node("mac").clock.monotonicMs()).toBe(world.node("vps").clock.monotonicMs());
          expect(claims).toHaveLength(1);
          expect(delivery.payload.epoch).toBe(1);
          expect(accepted.some((event) => event.type === "lease.revoked")).toBe(false);
          break;
      }
    } finally {
      await world.close();
    }
  });
});
