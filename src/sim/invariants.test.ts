import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildScenarios } from "../../test/helpers/golden-scenarios.js";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  T1,
  taskCreated,
} from "../../test/helpers/log-builder.js";
import { readHeartbeats } from "../blackboard/heartbeat.js";
import type { LogEntry } from "../core/log.js";
import { replay } from "../core/reducer/replay.js";
import { readLog } from "../git/log-reader.js";
import { checkWorldInvariants, SimInvariantError } from "./invariants.js";
import type { SimWorld } from "./world.js";

vi.mock("../git/log-reader.js", () => ({ readLog: vi.fn() }));
vi.mock("../blackboard/heartbeat.js", () => ({ readHeartbeats: vi.fn() }));

function worldFor(entries: LogEntry[]): SimWorld {
  vi.mocked(readLog).mockResolvedValue(entries);
  const state = replay(entries);
  return {
    seed: 42,
    git: {},
    blackboardRemote: ".skep-sim/remote.git",
    trustPath: ".skep-sim/allowed_signers",
    scheduler: { steps: 7, trace: [] },
    nodes: ["mac", "vps"].map((device) => ({
      device,
      agent: `${device}.coding`,
      state: structuredClone(state),
      clone: { dir: `.skep-sim/${device}` },
      trustPath: `.skep-sim/${device}/allowed_signers`,
    })),
  } as unknown as SimWorld;
}

describe("cross-node invariants", () => {
  beforeEach(() => {
    vi.mocked(readLog).mockReset();
    vi.mocked(readHeartbeats).mockReset().mockResolvedValue({});
  });

  it("accepts legal logs for every existing protocol scenario using production predicates", async () => {
    for (const scenario of buildScenarios()) {
      expect(await checkWorldInvariants(worldFor(scenario.entries))).toEqual([]);
    }
  });

  it("compares incremental/full replay and all nodes sharing a tip", async () => {
    const world = worldFor(new LogBuilder().entries);
    const node = world.nodes[1];
    if (!node) throw new Error("Missing vps node");
    node.state.blackboard_id = "bb_changed0001";
    const violations = await checkWorldInvariants(world);
    expect(violations.map((violation) => violation.code)).toEqual([
      "incremental_replay_mismatch",
      "same_tip_state_mismatch",
    ]);
    expect(violations[0]).toMatchObject({
      invariant: 1,
      seed: 42,
      step: 7,
      node: "vps.coding",
      logDump: expect.stringContaining("bb_changed0001"),
    });
    expect(new SimInvariantError(violations).message).toContain("seed 42, step 7");
  });

  it("checks stale nodes against their own tip instead of requiring immediate convergence", async () => {
    const log = new LogBuilder();
    const genesis = log.entries[0];
    if (!genesis) throw new Error("Missing genesis");
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    const world = worldFor(log.entries);
    const node = world.nodes[1];
    if (!node) throw new Error("Missing vps node");
    Object.assign(node.state, replay([genesis]));
    vi.mocked(readLog).mockImplementation(async (_git, _dir, _trust, options) =>
      options?.ref === genesis.sha ? [genesis] : log.entries,
    );
    expect(await checkWorldInvariants(world)).toEqual([]);
  });

  it("reports production state predicates with the node and log context", async () => {
    const log = new LogBuilder();
    log.append({ type: "agent.registered", actor: MAC, payload: agentRegistered() });
    log.append({
      type: "task.created",
      actor: "human",
      task_id: T1,
      payload: taskCreated({ repo: "https://example.invalid/code.git", owner: MAC }),
    });
    const world = worldFor(log.entries);
    const task = world.nodes[0]?.state.tasks[T1];
    if (!task) throw new Error("Missing task");
    task.status = "executing";
    expect(await checkWorldInvariants(world)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant: 8,
          code: "executing_without_work",
          node: MAC,
          task_id: T1,
        }),
      ]),
    );
  });

  it("detects heartbeat changes on main and malformed or non-orphan heartbeat refs", async () => {
    const log = new LogBuilder();
    log.append(
      { type: "agent.registered", actor: MAC, payload: agentRegistered() },
      {
        mutate: (entry) => {
          entry.changes.push({ status: "A", path: "hb.json" });
        },
      },
    );
    vi.mocked(readHeartbeats).mockResolvedValue({
      [MAC]: { oid: log.tip, hb: null, problem: "Heartbeat commit must be an orphan" },
    });
    const violations = await checkWorldInvariants(worldFor(log.entries));
    expect(violations.map((violation) => violation.code)).toEqual([
      "heartbeat_on_main",
      "invalid_heartbeat_ref",
    ]);
  });

  it("checks duplicate PRs and delivery heads only when a code host is attached", async () => {
    const solo = buildScenarios().find((scenario) => scenario.name === "solo");
    if (!solo) throw new Error("Missing solo fixture");
    const world = worldFor(solo.entries);
    expect(await checkWorldInvariants(world)).toEqual([]);
    const remoteBranchSha = vi.fn().mockResolvedValue(null);
    world.codeHost = {
      remoteBranchSha,
      pullRequests: () => [
        { repo: "https://example.invalid/code.git", head: "skep/example/W1/e1" },
        { repo: "https://example.invalid/code.git", head: "skep/example/W1/e1" },
      ],
    };
    const violations = await checkWorldInvariants(world);
    expect(violations.map((violation) => violation.code)).toEqual([
      "duplicate_pr",
      "delivery_head_missing",
    ]);
    expect(remoteBranchSha).toHaveBeenCalledOnce();
    const delivery = Object.values(replay(solo.entries).tasks).flatMap((task) =>
      Object.values(task.items),
    )[0]?.delivered;
    remoteBranchSha.mockResolvedValue(delivery?.head_sha);
    world.codeHost.pullRequests = () => [];
    expect(await checkWorldInvariants(world)).toEqual([]);
  });
});
