import { z } from "zod";

export const SKILL_TEXT_MAX = 16_000;
export const CONTRACT_MAX = 3_000;
export const SkillIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
const RoleIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const VersionSchema = z
  .string()
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  .refine((version) => {
    const prerelease = version.split("+")[0]?.split("-").slice(1).join("-");
    return !prerelease || prerelease.split(".").every((part) => !/^0\d+$/.test(part));
  }, "use semantic versioning");
export const SkillPathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").some((part) => part === ".." || part === "." || part === ""),
    "use a relative path inside the skill directory (no ..)",
  );
export const SkillRoleSchema = z.strictObject({
  id: RoleIdSchema,
  label: z.string().min(1).max(100),
  required: z.boolean().default(false),
  guidance: SkillPathSchema,
  match: z
    .strictObject({
      roles: z.array(z.string().min(1).max(64)).max(32).default([]),
      repos: z.array(z.string().min(1).max(200)).max(32).default([]),
    })
    .default({ roles: [], repos: [] }),
});
export const SkillStageSchema = z.strictObject({
  id: RoleIdSchema,
  roles: z.array(RoleIdSchema).max(16).default([]),
  after: z.array(RoleIdSchema).max(32).default([]),
});
export const SkillManifestSchema = z
  .strictObject({
    schema: z.literal("skep.skill/v1"),
    id: SkillIdSchema,
    name: z.string().min(1).max(120),
    version: VersionSchema,
    description: z.string().min(1).max(500),
    tags: z.array(z.string().min(1).max(40)).max(16).default([]),
    min_skep: VersionSchema.optional(),
    mode_hint: z.enum(["auto", "confirm"]).optional(),
    master: z.strictObject({
      guidance: SkillPathSchema,
      contract: SkillPathSchema.optional(),
      synthesis: SkillPathSchema,
    }),
    roles: z.array(SkillRoleSchema).max(16).default([]),
    stages: z.array(SkillStageSchema).max(32).default([]),
    artifacts: z
      .strictObject({
        contract: z
          .strictObject({
            max_chars: z.number().int().positive().max(CONTRACT_MAX).default(CONTRACT_MAX),
            repo_copy: SkillPathSchema.optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine((manifest, ctx) => {
    const problem = (message: string) => ctx.addIssue({ code: "custom", message });
    const roles = new Set(manifest.roles.map((role) => role.id));
    const stages = new Set(manifest.stages.map((stage) => stage.id));
    if (roles.size !== manifest.roles.length) problem("role ids must be unique");
    if (stages.size !== manifest.stages.length) problem("stage ids must be unique");
    const assigned = new Set<string>();
    for (const stage of manifest.stages) {
      for (const role of stage.roles) {
        if (!roles.has(role)) problem(`stage ${stage.id}: undeclared role ${role}`);
        if (assigned.has(role)) problem(`role ${role} must occur in only one stage`);
        assigned.add(role);
      }
      for (const dep of stage.after) {
        if (!stages.has(dep)) problem(`stage ${stage.id}: unknown after ${dep}`);
      }
    }
    const remaining = new Set(stages);
    while (remaining.size > 0) {
      const ready = manifest.stages.filter(
        (s) => remaining.has(s.id) && s.after.every((dep) => !remaining.has(dep)),
      );
      if (ready.length === 0) {
        problem("stage after dependencies must form a DAG (cycle)");
        break;
      }
      for (const stage of ready) remaining.delete(stage.id);
    }
  });

export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export type SkillRole = z.infer<typeof SkillRoleSchema>;
export type SkillStage = z.infer<typeof SkillStageSchema>;
export type SkillScope = "packaged" | "user" | "project";
export interface SkillSource {
  manifest: unknown;
  files: Record<string, string>;
}
export interface Skill {
  manifest: SkillManifest;
  files: Record<string, string>;
  scope: SkillScope;
  digest: string;
}
export const SkillIdentitySchema = z.strictObject({
  skillId: SkillIdSchema,
  version: VersionSchema,
  scope: z.enum(["packaged", "user", "project"]),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});

export interface SkillIdentity {
  skillId: string;
  version: string;
  scope: SkillScope;
  digest: string;
}

export class SkillError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SkillError";
  }
}

export function skillReferences(manifest: SkillManifest): { path: string; max: number }[] {
  return [
    { path: manifest.master.guidance, max: 6_000 },
    { path: manifest.master.synthesis, max: 3_000 },
    ...(manifest.master.contract ? [{ path: manifest.master.contract, max: CONTRACT_MAX }] : []),
    ...manifest.roles.map((role) => ({ path: role.guidance, max: 1_500 })),
  ];
}

/** D36: the same pure validation applies to packaged modules and disk sources. */
export function validateSkill(source: SkillSource): {
  manifest: SkillManifest;
  files: Record<string, string>;
} {
  const parsed = SkillManifestSchema.safeParse(source.manifest);
  if (!parsed.success)
    throw new SkillError(parsed.error.issues.map((issue) => issue.message).join("; "));
  const manifest = parsed.data;
  const files: Record<string, string> = {};
  for (const ref of skillReferences(manifest)) {
    const text = source.files[ref.path];
    if (typeof text !== "string") throw new SkillError(`missing text file ${ref.path}`);
    if (text.length > ref.max) throw new SkillError(`${ref.path} exceeds ${ref.max} characters`);
    files[ref.path] = text;
  }
  const refine =
    (files[manifest.master.guidance]?.length ?? 0) +
    (files[manifest.master.contract ?? ""]?.length ?? 0) +
    manifest.roles.reduce((sum, role) => sum + (files[role.guidance]?.length ?? 0), 0);
  if (refine > SKILL_TEXT_MAX)
    throw new SkillError(`skill refine text exceeds ${SKILL_TEXT_MAX} characters`);
  return { manifest, files };
}
