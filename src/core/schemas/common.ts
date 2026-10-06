import { z } from "zod";
import {
  AGENT_ID_RE,
  ATTEMPT_ID_RE,
  BARRIER_ID_RE,
  EVENT_ID_RE,
  ITEM_ID_RE,
  ROLE_RE,
  SHA_RE,
  SHA256_HEX_RE,
  SHA256_TAGGED_RE,
  TASK_ID_RE,
} from "../ids.js";

/**
 * Shared primitive schemas. Every object schema in the protocol is strict (unknown keys are
 * rejected, PRD §8.4) — use `z.strictObject` everywhere.
 */

export const TaskIdSchema = z.string().regex(TASK_ID_RE, "invalid task id");
export const EventIdSchema = z.string().regex(EVENT_ID_RE, "invalid event id");
export const AgentIdSchema = z.string().regex(AGENT_ID_RE, "invalid agent id");
export const ItemIdSchema = z.string().regex(ITEM_ID_RE, "invalid item id");
export const AttemptIdSchema = z.string().regex(ATTEMPT_ID_RE, "invalid attempt id");
export const BarrierIdSchema = z.string().regex(BARRIER_ID_RE, "invalid barrier id");
export const RoleSchema = z.string().regex(ROLE_RE, "invalid role");
export const ShaSchema = z.string().regex(SHA_RE, "invalid git sha");
export const Sha256TaggedSchema = z.string().regex(SHA256_TAGGED_RE, "invalid sha256: hash");
export const Sha256HexSchema = z.string().regex(SHA256_HEX_RE, "invalid sha256 hex");

/** `human` or an agent ID. */
export const ActorSchema = z.union([z.literal("human"), AgentIdSchema]);

/** ISO-8601 UTC timestamp. Display/diagnostics only — never used for ordering (PRD §8.3). */
export const TimestampSchema = z.iso.datetime({ offset: false });

export const PositiveIntSchema = z.number().int().positive();
export const NonNegIntSchema = z.number().int().nonnegative();
export const EpochSchema = PositiveIntSchema;

/** Short English free text (titles, reasons). */
export const ShortTextSchema = z.string().min(1).max(500);
/** Longer English free text (bodies, summaries, details). */
export const LongTextSchema = z.string().min(1).max(16_000);

/**
 * Repo-relative path: no absolute paths, no `..` segments, no backslashes, no NUL
 * (PRD §11.5 parser hardening). Trailing `/` allowed for directories.
 */
export const RelPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.includes("\0") &&
      !p.split("/").some((seg) => seg === ".." || seg === "."),
    "path must be repo-relative without '.' or '..' segments",
  );

/** Repo URL or allowlisted repo name. Never used as a destination unless allowlisted locally. */
export const RepoRefSchema = z.string().min(1).max(512);

export const AgentCliSchema = z.enum(["codex", "claude", "pi"]);

/** Daemon-captured result of running a trusted named check (PRD §9.6 step 5). */
export const CheckRunSchema = z.strictObject({
  run_id: z.string().min(1).max(64),
  check: z.string().min(1).max(64),
  sha: ShaSchema,
  exit: z.number().int(),
  duration_ms: NonNegIntSchema,
  passed: NonNegIntSchema.optional(),
  failed: NonNegIntSchema.optional(),
  log_sha256: Sha256HexSchema,
});
export type CheckRun = z.infer<typeof CheckRunSchema>;

export const BudgetsSchema = z.strictObject({
  /** Max agent invocations for the task (PRD §9.9; default 12). */
  max_invocations: PositiveIntSchema,
  /** Max wall-clock hours for the task (default 6). */
  max_wall_hours: z
    .number()
    .positive()
    .max(24 * 14),
  /** Replan budget (default 2); the 3rd request escalates. */
  replans: NonNegIntSchema,
  /** Blocked/rejected plan versions before lock ⇒ escalate (default 2). */
  review_rounds: NonNegIntSchema,
  /** Re-attempts per item per plan version (default 1). */
  item_retries: NonNegIntSchema,
});
export type Budgets = z.infer<typeof BudgetsSchema>;

export const DEFAULT_BUDGETS: Budgets = {
  max_invocations: 12,
  max_wall_hours: 6,
  replans: 2,
  review_rounds: 2,
  item_retries: 1,
};

/** Max serialized size of one event file (PRD §8.4). */
export const MAX_EVENT_BYTES = 64 * 1024;
