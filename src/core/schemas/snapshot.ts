import { z } from "zod";
import {
  AttemptIdSchema,
  CheckRunSchema,
  EpochSchema,
  ItemIdSchema,
  NonNegIntSchema,
  RelPathSchema,
  ShaSchema,
} from "./common.js";

export const InvocationStateSchema = z.enum(["completed", "interrupted", "killed", "unknown"]);
export type InvocationState = z.infer<typeof InvocationStateSchema>;

/**
 * `skep.snapshot/v1` — mechanical checkpoint produced by the daemon from facts it can verify
 * (PRD §10.7). The model may add a short advisory `agent_note`.
 */
export const SnapshotSchema = z.strictObject({
  schema: z.literal("skep.snapshot/v1"),
  item: ItemIdSchema,
  epoch: EpochSchema,
  attempt_id: AttemptIdSchema,
  branch: z.string().min(1).max(255),
  base_sha: ShaSchema,
  /** null when nothing was committed or the outcome is unknown. */
  head_sha: ShaSchema.nullable(),
  pushed: z.boolean(),
  invocation_state: InvocationStateSchema,
  diffstat: z.strictObject({
    files: NonNegIntSchema,
    insertions: NonNegIntSchema,
    deletions: NonNegIntSchema,
  }),
  files_changed: z.array(RelPathSchema).max(500),
  check_runs: z.array(CheckRunSchema).max(32),
  agent_note: z.string().max(1000).nullable(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
