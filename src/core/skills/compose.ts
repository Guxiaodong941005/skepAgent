import { canonicalJson } from "../canonical.js";
import type { OrchestrationGroup, SkillPlan, StageProgress } from "../orchestration/reducer.js";
import type { RefineOutput } from "../orchestration/schemas.js";
import type { Skill, SkillIdentity, SkillManifest, SkillRole, SkillStage } from "./schemas.js";
import { SKILL_TEXT_MAX, SkillError } from "./schemas.js";

export interface SkillPeer {
  peerId: string;
  device: string;
  repo?: string;
  role: string;
  protocolVersion?: number;
  joinedAtMs?: number;
}
export type ManualBindings = Record<string, string | null>;
export interface RoleBinding {
  role: string;
  label: string;
  required: boolean;
  peerId: string | null;
  device: string | null;
  repo: string | null;
  protocolVersion: number | null;
  candidates: number;
  source: "manual" | "role" | "repo" | "unbound";
}
export interface SkillContext {
  skill: Skill;
  bindings: RoleBinding[];
  manual?: ManualBindings;
  contract?: string;
}

/** Only content is hashed: scope and filesystem enumeration order do not change identity. */
export function digestInput(source: {
  manifest: SkillManifest;
  files: Record<string, string>;
}): string {
  return canonicalJson({ manifest: source.manifest, files: source.files });
}
export function skillIdentity(skill: Skill): SkillIdentity {
  return {
    skillId: skill.manifest.id,
    version: skill.manifest.version,
    scope: skill.scope,
    digest: skill.digest,
  };
}
function glob(pattern: string, value: string): boolean {
  const regex = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${regex}$`, "i").test(value);
}

/** Peers arrive in join order; explicit timestamps also support callers with sorted rosters. */
export function bind(
  roles: readonly SkillRole[],
  peers: readonly SkillPeer[],
  manual: ManualBindings = {},
): RoleBinding[] {
  const ordered = peers
    .map((peer, index) => ({ peer, index }))
    .sort(
      (a, b) =>
        (a.peer.joinedAtMs ?? a.index) - (b.peer.joinedAtMs ?? b.index) || a.index - b.index,
    )
    .map(({ peer }) => peer);
  return roles.map((role) => {
    let source: RoleBinding["source"] = "unbound";
    let candidates: SkillPeer[] = [];
    if (Object.hasOwn(manual, role.id)) {
      source = "manual";
      candidates = ordered.filter((p) => p.peerId === manual[role.id]);
      if (candidates.length === 0) candidates = ordered.filter((p) => p.repo === manual[role.id]);
    } else {
      const aliases = [role.id, ...role.match.roles].map((alias) => alias.toLowerCase());
      candidates = ordered.filter((p) => aliases.includes(p.role.toLowerCase()));
      if (candidates.length > 0) source = "role";
      else {
        candidates = ordered.filter((p) =>
          role.match.repos.some((g) => p.repo !== undefined && glob(g, p.repo)),
        );
        if (candidates.length > 0) source = "repo";
      }
    }
    const peer = candidates[0];
    return {
      role: role.id,
      label: role.label,
      required: role.required,
      peerId: peer?.peerId ?? null,
      device: peer?.device ?? null,
      repo: peer?.repo ?? null,
      protocolVersion: peer?.protocolVersion ?? null,
      candidates: candidates.length,
      source,
    };
  });
}

export function stageOrder(stages: readonly SkillStage[]): SkillStage[] {
  const ordered: SkillStage[] = [];
  const remaining = [...stages];
  while (remaining.length > 0) {
    const index = remaining.findIndex((s) =>
      s.after.every((dep) => ordered.some((prior) => prior.id === dep)),
    );
    if (index < 0) throw new SkillError("stage after dependencies must form a DAG");
    ordered.push(...remaining.splice(index, 1));
  }
  return ordered;
}

export function bindingTable(context: SkillContext): string {
  const { manifest } = context.skill;
  return [
    `skill ${manifest.id} ${manifest.version} (${context.skill.scope})`,
    "role | label | peer | device | repo | proto",
    ...context.bindings.map(
      (b) =>
        `${b.role} | ${b.label} | ${b.peerId ?? "(unbound)"} | ${b.device ?? "—"} | ${b.repo ?? "—"} | ${b.protocolVersion === null ? "?" : `v${b.protocolVersion}`}` +
        (b.candidates > 1 ? ` (${b.candidates} candidates)` : "") +
        (b.repo === null
          ? b.required
            ? " required — dispatch blocked"
            : " optional, skipped"
          : "") +
        (b.protocolVersion === 1 ? " — warning: brief cut at 4000" : ""),
    ),
  ].join("\n");
}

export function refineSkillSections(context: SkillContext): string {
  const { manifest: m, files } = context.skill;
  const text = [
    `ACTIVE SKILL: ${m.name} ${m.version} (${m.id})`,
    files[m.master.guidance],
    bindingTable(context),
    ...m.roles.map((r) => `ROLE ${r.id}: ${files[r.guidance]}`),
    ...(m.master.contract
      ? [
          "SHARED CONTRACT SKELETON: fill it once; Skep embeds it in every brief.",
          files[m.master.contract],
        ]
      : []),
    `Stages: ${stageOrder(m.stages)
      .map((s) => `${s.id} [${s.roles.join(", ")}] after [${s.after.join(", ")}]`)
      .join("; ")}`,
  ].join("\n\n");
  if (text.length > SKILL_TEXT_MAX)
    throw new SkillError(`composed skill text exceeds ${SKILL_TEXT_MAX} characters`);
  return text;
}

/** V030-4: merge roles only on the same peer; cross-stage merges wait for their latest stage. */
export function planSkill(context: SkillContext, output: RefineOutput): SkillPlan {
  const { manifest: m, files } = context.skill;
  for (const binding of context.bindings) {
    if (binding.required && binding.repo === null)
      throw new SkillError(
        `role ${binding.role} is unbound: /join with --role ${binding.role}, or /skill bind ${binding.role} <peer>`,
      );
  }
  if (
    m.master.contract &&
    (!output.contract || output.contract.length > (m.artifacts?.contract?.max_chars ?? 3000))
  )
    throw new SkillError(
      "a shared feature contract is required and must fit the skill's contract budget",
    );
  const targets: NonNullable<typeof output.targets> = output.targets?.length
    ? output.targets
    : context.bindings.filter((b) => b.repo !== null).map((b) => ({ role: b.role }));
  const order = stageOrder(m.stages);
  const groups: OrchestrationGroup[] = [];
  const skippedRoles = context.bindings
    .filter((b) => b.repo === null && !b.required)
    .map((b) => `${b.role} (unbound optional role)`);
  for (const target of targets) {
    const roleId = target.role;
    const role = m.roles.find((r) => r.id === roleId);
    if (roleId !== undefined && !role) throw new SkillError(`undeclared role target ${roleId}`);
    const binding = context.bindings.find((b) => b.role === roleId);
    const repo = roleId === undefined ? target.repo : binding?.repo;
    if (!repo) continue;
    const stage = roleId === undefined ? undefined : order.find((s) => s.roles.includes(roleId));
    const stageId = stage?.id ?? "__unassigned";
    const title = `[${m.id} · ${roleId ?? repo}] ${target.title ?? output.title}`;
    const section = role
      ? `YOUR ROLE: ${role.label} — repo ${repo}\n${target.brief ?? output.brief}\n\nDONE WHEN / ROLE GUIDANCE:\n${files[role.guidance]}\nREPORT: implemented contract fields, deviations, changed files and tests run.`
      : (target.brief ?? output.brief);
    const peerId = binding?.peerId;
    const existing = groups.find(
      (g) => g.repo === repo && g.peerIds?.[0] === (peerId ?? undefined),
    );
    if (existing) {
      if (roleId) existing.roles?.push(roleId);
      existing.title = `[${m.id} · ${existing.roles?.join("+") || repo}] ${output.title}`;
      existing.brief += `\n\n${section}`;
      if (
        existing.stage !== "__unassigned" &&
        (order.findIndex((s) => s.id === stageId) >
          order.findIndex((s) => s.id === existing.stage) ||
          stageId === "__unassigned")
      )
        existing.stage = stageId;
    } else {
      groups.push({
        repo,
        ...(peerId ? { peerIds: [peerId] } : {}),
        title,
        brief: section,
        intentId: null,
        error: null,
        roles: roleId ? [roleId] : [],
        ...(order.length ? { stage: stageId } : {}),
      });
    }
  }
  for (const role of m.roles) {
    if (
      !targets.some((t) => t.role === role.id) &&
      !skippedRoles.some((s) => s.startsWith(`${role.id} (`))
    )
      skippedRoles.push(`${role.id} (not targeted by refine)`);
  }
  if (groups.length === 0 && m.roles.length === 0 && targets.length === 0) {
    groups.push({
      repo: null,
      title: `[${m.id}] ${output.title}`,
      brief: output.brief,
      intentId: null,
      error: null,
      ...(order.length ? { stage: "__unassigned" } : {}),
    });
  }
  if (groups.length === 0)
    throw new SkillError("no bound skill targets to dispatch; join peers and /skill bind roles");
  for (const group of groups) {
    if (output.contract)
      group.brief = `FEATURE CONTRACT (shared by all roles; do not change it, report conflicts instead)\n${output.contract}\n\n${group.brief}`;
    if (
      (group.title?.length ?? 0) > 200 ||
      (group.title?.length ?? 0) + 2 + (group.brief?.length ?? 0) > 8000
    )
      throw new SkillError(
        `composed brief for ${group.repo} exceeds the intent budget; shorten the title/brief/contract`,
      );
  }
  const stages: StageProgress[] = order.map((s) => ({
    id: s.id,
    status: "pending",
  }));
  if (order.length && groups.some((g) => g.stage === "__unassigned"))
    stages.push({ id: "__unassigned", status: "pending" });
  let active = false;
  for (const stage of stages) {
    if (active) break;
    if (groups.some((g) => g.stage === stage.id)) {
      stage.status = "active";
      active = true;
    } else stage.status = "settled";
  }
  return { groups, stages, bindings: context.bindings, skippedRoles };
}
