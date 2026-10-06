import { z } from "zod";
import { LongTextSchema, NonNegIntSchema, RelPathSchema, ShortTextSchema } from "./common.js";
import { EvidenceSchema } from "./evidence.js";

/**
 * `skep.work_report/v1` — the model's final JSON message after a coding invocation (PRD §9.6 step
 * 4). Advisory only: it cannot declare success. Success is decided by daemon-captured checks.
 */
export const WorkReportSchema = z.strictObject({
  schema: z.literal("skep.work_report/v1"),
  summary: LongTextSchema,
  files_intended: z.array(RelPathSchema).max(500),
  concerns: z.array(ShortTextSchema).max(32),
  /** Set when the plan is wrong; the daemon verifies evidence before emitting replan.requested. */
  replan_request: z
    .strictObject({
      summary: z.string().min(1).max(4000),
      evidence: z.array(EvidenceSchema).min(1).max(8),
    })
    .nullable(),
});
export type WorkReport = z.infer<typeof WorkReportSchema>;

/** Usage numbers reported by an adapter, when the CLI exposes them. Never on the blackboard. */
export const UsageSchema = z.strictObject({
  input_tokens: NonNegIntSchema.optional(),
  output_tokens: NonNegIntSchema.optional(),
  cost_usd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;
