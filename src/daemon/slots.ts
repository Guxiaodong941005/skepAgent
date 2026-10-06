import { resolve } from "node:path";
import { z } from "zod";
import type { AgentAdapter } from "../adapter/types.js";
import { type AgentMd, loadAgentMd } from "../config/agent-md.js";
import { parseAgentId } from "../core/ids.js";
import { draft, type Intent } from "../core/intents.js";
import { activeLeaseCount } from "../core/reducer/handlers/lease.js";
import type { State } from "../core/reducer/state.js";
import { type ClaimCandidate, claimableItems } from "../core/reducer/views.js";
import type { AgentUserIds } from "../exec/sandbox-env.js";
import { type AgentEnvOptions, agentEnv, resolveAgentUser } from "../exec/sandbox-env.js";
import { execFileChecked } from "../util/exec.js";

export const SlotConfigSchema = z.strictObject({
  roleDir: z.string().min(1),
  user: z.string().min(1),
  home: z.string().min(1),
  path: z.string().min(1),
  configDir: z.string().optional(),
  instance: z.number().int().min(1).max(9999).optional(),
});
export type SlotConfig = z.infer<typeof SlotConfigSchema>;
export interface Slot {
  agent: string;
  roleDir: string;
  policy: AgentMd;
  adapter: AgentAdapter;
  envOptions: AgentEnvOptions;
  env: Record<string, string>;
  identity: Partial<AgentUserIds>;
  enabled: boolean;
  busy: Set<string>;
  probeError: string | null;
}
export class SlotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SlotError";
  }
}
export interface SlotRegistryDependencies {
  device: string;
  adapter(
    policy: AgentMd,
    config: SlotConfig,
    identity: Partial<AgentUserIds>,
  ): AgentAdapter | Promise<AgentAdapter>;
  loadPolicy?: typeof loadAgentMd;
  resolveUser?: typeof resolveAgentUser;
}

export class SlotRegistry {
  private readonly slots = new Map<string, Slot>();
  private readonly starting = new Set<string>();
  constructor(private readonly deps: SlotRegistryDependencies) {}
  list(): Slot[] {
    return [...this.slots.values()].sort((a, b) => a.agent.localeCompare(b.agent));
  }
  get(agent: string): Slot | undefined {
    return this.slots.get(agent);
  }
  async start(input: SlotConfig): Promise<Slot> {
    const config = SlotConfigSchema.parse(input);
    const roleDir = resolve(config.roleDir);
    const policy = await (this.deps.loadPolicy ?? loadAgentMd)(roleDir);
    const agent = `${this.deps.device}.${policy.frontMatter.role}${config.instance ? `.${config.instance}` : ""}`;
    if (!parseAgentId(agent))
      throw new SlotError("Slot identity must match device.role[.instance]");
    const previous = this.slots.get(agent);
    if (previous && !previous.enabled && previous.busy.size === 0 && previous.roleDir === roleDir) {
      this.slots.delete(agent);
    }
    if (this.slots.has(agent) || this.starting.has(agent))
      throw new SlotError(`Slot ${agent} already exists`);
    this.starting.add(agent);
    try {
      // G12: keep the shared helper unchanged while resolving IDs through an absolute executable.
      const identity = await (this.deps.resolveUser ?? resolveAgentUser)(config.user, {
        exec: (file, args, options) =>
          execFileChecked(file === "id" ? "/usr/bin/id" : file, args, options),
      });
      const adapter = await this.deps.adapter(policy, config, identity);
      if (adapter.cli !== policy.frontMatter.agent_cli)
        throw new SlotError(`Slot ${agent}: adapter does not match AGENT.md agent_cli`);
      const envOptions: AgentEnvOptions = {
        source: { PATH: config.path, LANG: "C.UTF-8" },
        home: resolve(config.home),
        user: config.user,
        agentCli: adapter.cli,
        ...(config.configDir ? { configDir: resolve(config.configDir) } : {}),
      };
      const slot: Slot = {
        agent,
        roleDir,
        policy,
        adapter,
        envOptions,
        env: agentEnv(envOptions),
        identity,
        enabled: true,
        busy: new Set(),
        probeError: null,
      };
      await this.probe(slot);
      this.slots.set(agent, slot);
      return slot;
    } finally {
      this.starting.delete(agent);
    }
  }
  stop(agent: string): void {
    const slot = this.slots.get(agent);
    if (!slot) throw new SlotError(`No local slot ${agent}`);
    slot.enabled = false;
  }
  async probe(slot: Slot): Promise<void> {
    const probe = await slot.adapter.probe();
    if (!probe.ok || probe.version !== slot.policy.frontMatter.cli_version) {
      slot.probeError = `Slot ${slot.agent}: expected CLI ${slot.policy.frontMatter.cli_version}, got ${probe.version ?? "unavailable"}: ${probe.detail}`;
      throw new SlotError(slot.probeError);
    }
    slot.probeError = null;
  }
  reserve(slot: Slot, key: string): boolean {
    if (
      !slot.enabled ||
      slot.busy.has(key) ||
      slot.busy.size >= slot.policy.frontMatter.max_parallel_items
    )
      return false;
    slot.busy.add(key);
    return true;
  }
  release(slot: Slot, key: string): void {
    slot.busy.delete(key);
  }
  isActive(state: State): boolean {
    const local = new Set(
      this.list()
        .filter((slot) => slot.enabled || slot.busy.size > 0)
        .map((slot) => slot.agent),
    );
    return (
      this.list().some((slot) => slot.busy.size > 0) ||
      Object.values(state.tasks).some(
        (task) =>
          !["done", "cancelled", "escalated", "awaiting_approval"].includes(task.status) &&
          (local.has(task.owner) ||
            Object.values(task.items).some((item) => local.has(item.assignee)) ||
            task.plans[String(task.current_plan_version)]?.reviewers.some((reviewer) =>
              local.has(reviewer),
            )),
      )
    );
  }
}

export function registrationIntent(slot: Slot): Intent {
  const profile = slot.policy.frontMatter;
  return () =>
    draft(
      "agent.registered",
      null,
      slot.agent,
      {
        role: profile.role,
        agent_cli: profile.agent_cli,
        cli_version: profile.cli_version,
        capabilities: [...profile.capabilities],
        requires_local: [...profile.requires_local],
        max_parallel_items: profile.max_parallel_items,
      },
      {},
    );
}

/** F15/D16: reducer candidates plus local invocation capacity; parked leases consume neither. */
export function claimCandidates(state: State, slot: Slot): ClaimCandidate[] {
  if (!slot.enabled) return [];
  const free = Math.min(
    slot.policy.frontMatter.max_parallel_items - slot.busy.size,
    (state.agents[slot.agent]?.profile.max_parallel_items ?? 0) -
      activeLeaseCount(state, slot.agent),
  );
  return claimableItems(state, slot.agent).slice(0, Math.max(0, free));
}
