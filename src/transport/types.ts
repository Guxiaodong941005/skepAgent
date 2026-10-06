import { z } from "zod";
import { DEVICE_RE } from "../core/ids.js";
import { AgentIdSchema, ShaSchema } from "../core/schemas/common.js";

/** ARCHITECTURE §17.3: the compact JSON representation is capped at 1 KiB. */
export const MAX_HINT_BYTES = 1024;

// Topics are non-secret relay identifiers (§17.3), never provider metadata or credentials (D19).
const TopicSchema = z.string().min(1).max(MAX_HINT_BYTES);
const HintRefSchema = z.union([z.literal("main"), z.templateLiteral(["hb/", AgentIdSchema])]);

/** Only wake-up metadata travels outside git; payloads and mailboxes are excluded (§17.2, D19). */
export const HintSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      v: z.literal(1),
      kind: z.literal("tip"),
      topic: TopicSchema,
      ref: HintRefSchema,
      sha: ShaSchema,
    }),
    z.strictObject({
      v: z.literal(1),
      kind: z.literal("wake"),
      topic: TopicSchema,
      device: z.string().regex(DEVICE_RE, "invalid device name"),
    }),
  ])
  .refine((hint) => Buffer.byteLength(JSON.stringify(hint), "utf8") <= MAX_HINT_BYTES, {
    message: `hint exceeds ${MAX_HINT_BYTES} bytes`,
  });

export type Hint = z.infer<typeof HintSchema>;

/** Best-effort wake-up hints; consumers must fetch and verify git before changing state (§17.2). */
export interface HintChannel {
  readonly name: string;
  start(onHint: (hint: Hint) => void): Promise<void>;
  /** Never rejects to callers: transport failures must not prevent git publication (§17.3). */
  publish(hint: Hint): Promise<void>;
  stop(): Promise<void>;
  health(): { connected: boolean; lastMessageMonoMs: number | null };
}
