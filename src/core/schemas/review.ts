import { z } from "zod";
import { PositiveIntSchema, Sha256TaggedSchema, ShortTextSchema } from "./common.js";
import { EvidenceSchema } from "./evidence.js";

export const BlockerSchema = z.strictObject({
  id: z.string().regex(/^B\d{1,3}$/, "invalid blocker id"),
  claim: z.string().min(1).max(2000),
  /** e.g. `W2.acceptance[0]` */
  acceptance_gap: z.string().max(200).optional(),
  evidence: z.array(EvidenceSchema).max(8),
});
export type Blocker = z.infer<typeof BlockerSchema>;

/** Review body shared by the model output and the `review.submitted` payload. */
export const ReviewBodySchema = z.strictObject({
  plan_version: PositiveIntSchema,
  plan_hash: Sha256TaggedSchema,
  verdict: z.enum(["approve", "block", "comment"]),
  blockers: z.array(BlockerSchema).max(16),
  suggestions: z.array(ShortTextSchema).max(16),
});

/**
 * Structural rule (PRD §9.3): `block` requires ≥ 1 blocker with ≥ 1 evidence item. The daemon
 * verifies evidence before publishing and downgrades unverifiable blocks to `comment`.
 */
function blockHasEvidence(r: z.infer<typeof ReviewBodySchema>): boolean {
  return r.verdict !== "block" || r.blockers.some((b) => b.evidence.length > 0);
}

/** `skep.review/v1` — model output for a plan review. */
export const ReviewSchema = ReviewBodySchema.extend({ schema: z.literal("skep.review/v1") }).refine(
  blockHasEvidence,
  { message: "block verdict requires at least one blocker with evidence" },
);
export type Review = z.infer<typeof ReviewSchema>;

export const ReviewPayloadSchema = ReviewBodySchema.refine(blockHasEvidence, {
  message: "block verdict requires at least one blocker with evidence",
});
