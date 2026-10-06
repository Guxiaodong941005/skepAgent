import { describe, expect, it, vi } from "vitest";
import {
  agentRegistered,
  LogBuilder,
  MAC,
  planProposed,
  samplePlan,
  T1,
  taskCreated,
  VPS,
} from "../../test/helpers/log-builder.js";
import type { AgentAdapter } from "../adapter/types.js";
import type { AgentMd } from "../config/agent-md.js";
import { replay } from "../core/reducer/replay.js";
import { claimCandidates, SlotRegistry } from "./slots.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture value");
  return value;
}

function registry(version = "test-version", ok = true) {
  const adapter: AgentAdapter = {
    cli: "codex",
    probe: vi.fn(async () => ({ ok, version, detail: "Test probe" })),
    invoke: vi.fn(),
  };
  const policy: AgentMd = {
    file: "AGENT.md",
    body: "Implement assigned work.",
    frontMatter: {
      schema: "skep.agent/v1",
      role: "coding",
      agent_cli: "codex",
      cli_version: "test-version",
      repos: ["https://example.invalid/code.git"],
      capabilities: ["typescript"],
      requires_local: [],
      max_parallel_items: 1,
      budgets: { max_invocation_minutes: 1 },
    },
  };
  const resolveUser = vi.fn(
    async (
      _user?: string,
      _deps?: Parameters<typeof import("../exec/sandbox-env.js").resolveAgentUser>[1],
    ) => ({ uid: 1000, gid: 1000 }),
  );
  const slots = new SlotRegistry({
    device: "vps",
    loadPolicy: async () => policy,
    resolveUser,
    adapter: () => adapter,
  });
  const config = {
    roleDir: ".skep-sim/role",
    user: "skep",
    home: process.cwd(),
    path: "agent-bin",
  };
  return { adapter, policy, slots, config, resolveUser };
}
function state() {
  const log = new LogBuilder();
  for (const actor of [MAC, VPS])
    log.append({ type: "agent.registered", actor, payload: agentRegistered() });
  log.append({ type: "task.created", actor: "human", payload: taskCreated() });
  const plan = samplePlan();
  const proposal = planProposed(plan);
  log.append({
    type: "plan.proposed",
    actor: VPS,
    payload: proposal,
    pre: { task_rev: 1, owner_gen: 1 },
  });
  log.append({
    type: "plan.approved",
    actor: "human",
    payload: { plan_version: 1, plan_hash: proposal.plan_hash },
    pre: { task_rev: 2, plan_version: 1, plan_hash: proposal.plan_hash },
  });
  return replay(log.entries);
}
describe("slot registry", () => {
  it("binds policy, adapter, OS identity and the agent's explicit PATH (G12/F14)", async () => {
    const f = registry();
    const slot = await f.slots.start(f.config);
    expect(slot.agent).toBe(VPS);
    expect(slot.env.PATH).toBe("agent-bin");
    expect(slot.env).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(slot.env).not.toHaveProperty("GH_TOKEN");
    expect(slot.identity).toEqual({ uid: 1000, gid: 1000 });
    expect(f.resolveUser).toHaveBeenCalledWith("skep");
    await expect(f.slots.start(f.config)).rejects.toThrow("already exists");
  });
  it.each([
    ["other-version", true],
    ["test-version", false],
  ])("blocks a failed/mismatched probe", async (version, ok) => {
    const f = registry(version as string, ok as boolean);
    await expect(f.slots.start(f.config)).rejects.toThrow("expected CLI");
    expect(f.slots.list()).toEqual([]);
  });
  it("claims only free slots and ignores parked leases (D16/F15)", async () => {
    const f = registry();
    const slot = await f.slots.start(f.config);
    const s = state();
    expect(claimCandidates(s, slot)).toHaveLength(1);
    expect(f.slots.reserve(slot, "plan")).toBe(true);
    expect(claimCandidates(s, slot)).toEqual([]);
    f.slots.release(slot, "plan");
    const parked = structuredClone(required(s.tasks[T1]));
    parked.task_id = "T-20261005-0000";
    parked.status = "escalated";
    required(parked.items.W1).status = "interrupted";
    required(parked.items.W1).lease = {
      holder: VPS,
      epoch: 1,
      branch: "skep/example",
      attempt_id: "att_test",
      interrupt: "B8",
      plan_hash: required(parked.plans["1"]).plan_hash,
      plan_version: 1,
      granted_at_seq: 1,
    };
    s.tasks[parked.task_id] = parked;
    expect(claimCandidates(s, slot)).toHaveLength(1);
    required(parked.items.W1).status = "leased";
    expect(claimCandidates(s, slot)).toEqual([]);
    f.slots.stop(VPS);
    expect(claimCandidates(state(), slot)).toEqual([]);
  });
  it("polls fast only for local unfinished work (F11)", async () => {
    const f = registry();
    await f.slots.start(f.config);
    const s = state();
    required(s.tasks[T1]).owner = MAC;
    required(required(s.tasks[T1]).items.W1).assignee = MAC;
    expect(f.slots.isActive(s)).toBe(false);
    required(required(s.tasks[T1]).items.W1).assignee = VPS;
    expect(f.slots.isActive(s)).toBe(true);
    required(s.tasks[T1]).status = "done";
    expect(f.slots.isActive(s)).toBe(false);
  });
});
