import { z } from "zod";
import {
  AgentIdSchema,
  EpochSchema,
  ItemIdSchema,
  NonNegIntSchema,
  ShaSchema,
  TaskIdSchema,
  TimestampSchema,
} from "./common.js";

/**
 * `skep.hb/v1` — content of `hb.json` in the single orphan commit on `refs/heads/hb/<agent>`
 * (PRD §10.4). Never on `main`. `sent_at` is display-only; observers judge liveness on their own
 * monotonic clock (PRD §10.5).
 */
export const HeartbeatSchema = z.strictObject({
  schema: z.literal("skep.hb/v1"),
  agent: AgentIdSchema,
  boot_id: z.string().regex(/^b_[0-9a-f]{4,32}$/),
  /** Monotonic counter per boot. */
  n: NonNegIntSchema,
  state: z.enum(["idle", "running", "paused", "stopping"]),
  task_id: TaskIdSchema.nullable(),
  item: ItemIdSchema.nullable(),
  epoch: EpochSchema.nullable(),
  observed_main: ShaSchema.nullable(),
  runtime: z.enum(["native", "herdr"]),
  sent_at: TimestampSchema,
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
