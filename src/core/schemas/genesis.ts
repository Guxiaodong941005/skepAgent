import { z } from "zod";
import { PositiveIntSchema, TimestampSchema } from "./common.js";

/**
 * `skep.json` at the root of the blackboard's genesis commit (seq 0), human-signed (PRD §8.2).
 * `reducer_version` selects the reducer used to replay the log (PRD §10.1).
 */
export const GenesisSchema = z.strictObject({
  schema: z.literal("skep.genesis/v1"),
  protocol_version: z.literal(1),
  reducer_version: PositiveIntSchema,
  blackboard_id: z.string().regex(/^bb_[0-9a-z]{4,40}$/),
  created_at: TimestampSchema,
});
export type Genesis = z.infer<typeof GenesisSchema>;

export const GENESIS_PATH = "skep.json";
