import { z } from "zod";
import { SkillIdentitySchema } from "../skills/schemas.js";
import { RefineOutputSchema } from "./schemas.js";

const RoleBindingSchema = z.strictObject({
  role: z.string(),
  label: z.string(),
  required: z.boolean(),
  peerId: z.string().nullable(),
  device: z.string().nullable(),
  repo: z.string().nullable(),
  protocolVersion: z.number().nullable(),
  candidates: z.number().int().nonnegative(),
  source: z.enum(["manual", "role", "repo", "unbound"]),
});

/** Full validation of local ledger input; optional fields preserve pre-skill records. */
export const OrchestrationStateSchema = z.strictObject({
  id: z.string(),
  skill: SkillIdentitySchema.optional(),
  contract: z.string().max(3000).optional(),
  bindings: z.array(RoleBindingSchema).max(16).optional(),
  stages: z
    .array(z.strictObject({ id: z.string(), status: z.enum(["pending", "active", "settled"]) }))
    .max(33)
    .optional(),
  skippedRoles: z.array(z.string()).optional(),
  mode: z.enum(["auto", "confirm"]),
  phase: z.enum([
    "refining",
    "asking",
    "confirming",
    "dispatching",
    "awaiting",
    "awaiting-retry",
    "stalled",
    "synthesizing",
    "done",
    "failed",
    "cancelled",
  ]),
  userText: z.string(),
  answers: z.array(z.string()),
  questionRounds: z.number().int().nonnegative(),
  questions: z.array(z.string()),
  refine: RefineOutputSchema.nullable(),
  brief: z.strictObject({ title: z.string(), text: z.string() }).nullable(),
  groups: z.array(
    z.strictObject({
      peerIds: z.array(z.string()).min(1).max(16).optional(),
      stage: z.string().optional(),
      roles: z.array(z.string()).optional(),
      repo: z.string().nullable(),
      title: z.string().nullable(),
      brief: z.string().nullable(),
      intentId: z.string().nullable(),
      error: z.string().nullable(),
    }),
  ),
  intentIds: z.array(z.string()),
  items: z.array(
    z.strictObject({
      intentId: z.string(),
      itemId: z.string(),
      verdict: z.enum([
        "done",
        "failed",
        "lost",
        "submit-failed",
        "pending",
        "declined",
        "running",
      ]),
      repo: z.string(),
      device: z.string().optional(),
      peerId: z.string().optional(),
      role: z.string().optional(),
      summary: z.string().optional(),
      supersededBy: z.string().optional(),
      skipped: z.boolean().optional(),
      changed: z
        .strictObject({
          files: z.array(
            z.strictObject({
              path: z.string(),
              change: z.string(),
              added: z.number().int().nonnegative().nullable(),
              removed: z.number().int().nonnegative().nullable(),
            }),
          ),
          total: z.number().int().nonnegative(),
          partial: z.boolean(),
        })
        .optional(),
    }),
  ),
  synthesis: z.string().nullable(),
  raw: z.boolean(),
  failure: z
    .strictObject({ stage: z.enum(["refine", "dispatch", "synthesize"]), cause: z.string() })
    .nullable(),
});
