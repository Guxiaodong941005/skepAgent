import { readHeartbeats } from "../blackboard/heartbeat.js";
import { canonicalJson } from "../core/canonical.js";
import type { LogEntry } from "../core/log.js";
import { checkInvariants } from "../core/reducer/invariants.js";
import { replay } from "../core/reducer/replay.js";
import { parseEventFile } from "../core/schemas/events.js";
import { readLog } from "../git/log-reader.js";
import type { SimWorld } from "./world.js";

/** Inspection port until a code host is attached by execution scenarios (ARCHITECTURE §13.2). */
export interface SimCodeHost {
  remoteBranchSha(repo: string, branch: string): Promise<string | null>;
  pullRequests():
    | readonly { repo: string; head: string }[]
    | Promise<readonly { repo: string; head: string }[]>;
}

export interface SimViolation {
  invariant: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  seq: number | null;
  task_id: string | null;
  code: string;
  detail: string;
  node: string | null;
  seed: number | string;
  step: number;
  logDump: string;
}

export class SimInvariantError extends Error {
  constructor(readonly violations: readonly SimViolation[]) {
    const first = violations[0];
    super(
      first
        ? `Simulation invariant ${first.invariant} failed (seed ${first.seed}, step ${first.step}): ${first.detail}\n${first.logDump}`
        : "Simulation invariant failed",
    );
    this.name = "SimInvariantError";
  }
}

/** Uses the production predicates and replay; protocol rules are not reimplemented here. */
export async function checkWorldInvariants(world: SimWorld): Promise<SimViolation[]> {
  const snapshots = world.nodes.map((node) => ({ node, state: node.state }));
  const remoteEntries = await readLog(world.git, world.blackboardRemote, world.trustPath);
  const remoteState = replay(remoteEntries);
  const logs = new Map<string, readonly LogEntry[]>([[remoteState.tip, remoteEntries]]);
  const logDump = canonicalJson({
    entries: remoteEntries,
    nodes: snapshots.map(({ node, state }) => ({ agent: node.agent, state })),
    trace: world.scheduler.trace,
  });
  const violations: SimViolation[] = [];
  const add = (
    value: Pick<SimViolation, "invariant" | "code" | "detail"> &
      Partial<Pick<SimViolation, "node" | "seq" | "task_id">>,
  ) => {
    violations.push({
      seq: null,
      task_id: null,
      node: null,
      ...value,
      seed: world.seed,
      step: world.scheduler.steps,
      logDump,
    });
  };
  for (const violation of checkInvariants(remoteEntries, remoteState)) add(violation);

  const stateAtTip = new Map<string, string>();
  for (const { node, state } of snapshots) {
    let entries = logs.get(state.tip);
    if (!entries) {
      entries = await readLog(world.git, node.clone.dir, node.trustPath, { ref: state.tip });
      logs.set(state.tip, entries);
    }
    const canonical = canonicalJson(state);
    if (canonical !== canonicalJson(replay([...entries]))) {
      add({
        invariant: 1,
        node: node.agent,
        code: "incremental_replay_mismatch",
        detail: `${node.agent} incremental state differs from full replay at ${state.tip}`,
      });
    }
    const peer = stateAtTip.get(state.tip);
    if (peer !== undefined && peer !== canonical) {
      add({
        invariant: 1,
        node: node.agent,
        code: "same_tip_state_mismatch",
        detail: `${node.agent} disagrees with another node at tip ${state.tip}`,
      });
    }
    stateAtTip.set(state.tip, canonical);
    for (const violation of checkInvariants(entries, state))
      add({ ...violation, node: node.agent });
  }

  for (const entry of remoteEntries) {
    if (
      entry.changes.some((change) => change.path === "hb.json" || change.path.startsWith("hb/"))
    ) {
      add({
        invariant: 7,
        seq: entry.seq,
        code: "heartbeat_on_main",
        detail: `main commit ${entry.sha} changes heartbeat data`,
      });
    }
  }
  const devices = Object.fromEntries(world.nodes.map((node) => [node.agent, node.device]));
  for (const [agent, observation] of Object.entries(
    await readHeartbeats(world.git, world.blackboardRemote, world.trustPath, devices),
  )) {
    if (observation.hb === null) {
      add({
        invariant: 7,
        node: agent,
        code: "invalid_heartbeat_ref",
        detail: `hb/${agent} is not a valid signed single orphan: ${observation.problem}`,
      });
    }
  }

  if (world.codeHost) {
    const heads = new Set<string>();
    for (const pr of await world.codeHost.pullRequests()) {
      const key = `${pr.repo}\0${pr.head}`;
      if (heads.has(key))
        add({
          invariant: 5,
          code: "duplicate_pr",
          detail: `More than one PR for ${pr.repo} branch ${pr.head}`,
        });
      heads.add(key);
    }
    for (const entry of remoteEntries) {
      if (remoteState.outcomes[entry.seq - 1]?.outcome !== "accepted") continue;
      for (const content of Object.values(entry.added)) {
        if (content === null) continue;
        const parsed = parseEventFile(content);
        if (!parsed.ok || parsed.event.type !== "work.delivered") continue;
        const event = parsed.event;
        const task = event.task_id === null ? undefined : remoteState.tasks[event.task_id];
        if (!task) continue;
        const head = await world.codeHost.remoteBranchSha(task.repo, event.payload.branch);
        if (head !== event.payload.head_sha) {
          add({
            invariant: 5,
            seq: entry.seq,
            task_id: task.task_id,
            code: "delivery_head_missing",
            detail: `${task.task_id} ${event.payload.item} delivered ${event.payload.head_sha}, but ${event.payload.branch} on the code remote is ${head ?? "missing"}`,
          });
        }
      }
    }
  }
  return violations;
}
