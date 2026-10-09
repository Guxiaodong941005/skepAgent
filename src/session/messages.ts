import { z } from "zod";
import { RepoRefSchema, ShaSchema } from "../core/schemas/common.js";

export const DATALIST_CAP = 32_768;
export const DeviceSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const TokenSchema = z.string().regex(/^[0-9a-f]{32}$/);
const IdSchema = z.string().min(1).max(128);
const ItemIdSchema = z.string().regex(/^I-\d+$/);
const EpochSchema = z.number().int().min(1);
const RoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const TextSchema = z.string().min(1).max(4000);

function base64(bytes: number) {
  // Node's decoder accepts noncanonical encodings; the wire contract does not.
  return z.string().refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === bytes && decoded.toString("base64") === value;
  }, `Expected canonical base64 encoding of ${bytes} bytes`);
}

export const IntentInputSchema = z.strictObject({
  text: TextSchema,
  repos: z.array(RepoRefSchema).min(1).max(16).optional(),
});
const ControlStatusSchema = z.strictObject({
  type: z.literal("control"),
  v: z.literal(1),
  token: TokenSchema,
  op: z.literal("status"),
});
const ControlIntentSchema = z.strictObject({
  type: z.literal("control"),
  v: z.literal(1),
  token: TokenSchema,
  op: z.literal("intent"),
  ...IntentInputSchema.shape,
});
export const JoinSchema = z.strictObject({
  type: z.literal("join"),
  v: z.literal(1),
  device: DeviceSchema,
  pub: base64(32),
  nonce: base64(16),
});
export const FirstFrameSchema = z.union([ControlStatusSchema, ControlIntentSchema, JoinSchema]);
export type FirstFrame = z.infer<typeof FirstFrameSchema>;

export const JoinRejectReasonSchema = z.enum([
  "no_code",
  "bad_code",
  "expired",
  "declined",
  "busy",
]);
export type JoinRejectReason = z.infer<typeof JoinRejectReasonSchema>;
export const HandshakeMsgSchema = z.discriminatedUnion("type", [
  JoinSchema,
  z.strictObject({
    type: z.literal("join-challenge"),
    v: z.literal(1),
    pub: base64(32),
    nonce: base64(16),
  }),
  z.strictObject({ type: z.literal("join-confirm"), mac: base64(32) }),
  z.strictObject({ type: z.literal("join-accept"), mac: base64(32) }),
  z.strictObject({ type: z.literal("join-reject"), reason: JoinRejectReasonSchema }),
]);
export type HandshakeMsg = z.infer<typeof HandshakeMsgSchema>;

export const DatalistEntrySchema = z.strictObject({
  kind: z.enum(["path", "schema", "signature"]),
  path: z.string().min(1).max(1024),
  detail: z.string().max(1024).optional(),
});
export type DatalistEntry = z.infer<typeof DatalistEntrySchema>;
export const DatalistEntriesSchema = z
  .array(DatalistEntrySchema)
  .max(2000)
  .refine(
    (entries) => Buffer.byteLength(JSON.stringify(entries), "utf8") <= DATALIST_CAP,
    `Serialized datalist entries must fit in ${DATALIST_CAP} bytes`,
  );
export const PlanItemSchema = z.strictObject({
  itemId: ItemIdSchema,
  repo: RepoRefSchema,
  assignee: IdSchema,
  epoch: EpochSchema,
  title: z.string().max(200),
  datalistEntries: z.number().int().nonnegative().max(2000),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;
export const SubmitMethodSchema = z.enum(["pr", "mr", "push", "none", "ask"]);
export type SubmitMethod = z.infer<typeof SubmitMethodSchema>;
export const SubmitStateSchema = z.enum([
  "opened",
  "pushed",
  "local",
  "pending",
  "skipped",
  "failed",
]);
export type SubmitState = z.infer<typeof SubmitStateSchema>;
/**
 * How the sub's own Skep (its device policy or the human at it) submitted the item's code. The
 * master only records it: it never pushes or talks to a code host on a sub's behalf.
 */
export const SubmitOutcomeSchema = z
  .strictObject({
    method: SubmitMethodSchema,
    state: SubmitStateSchema,
    url: z.string().url().max(512).optional(),
    number: z.number().int().positive().optional(),
    branch: z.string().min(1).max(255),
  })
  .refine(
    (value) =>
      value.state === "opened"
        ? value.url !== undefined
        : value.url === undefined && value.number === undefined,
    { message: "url is required when state is opened and only allowed then", path: ["url"] },
  );
export type SubmitOutcome = z.infer<typeof SubmitOutcomeSchema>;
export const SubResultSchema = z.strictObject({
  repo: RepoRefSchema,
  baseSha: ShaSchema,
  headSha: ShaSchema,
  checks: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(100),
        status: z.enum(["pass", "fail", "skip"]),
      }),
    )
    .max(64),
  summary: z.string().max(4000),
  // Optional so peers that predate structured submit outcomes still parse.
  submit: SubmitOutcomeSchema.optional(),
});
export type SubResult = z.infer<typeof SubResultSchema>;
export const ResultMsgSchema = z.strictObject({
  type: z.literal("result"),
  itemId: ItemIdSchema,
  epoch: EpochSchema,
  ...SubResultSchema.shape,
});
export type ResultMsg = z.infer<typeof ResultMsgSchema>;
export const ClaimRejectReasonSchema = z.enum([
  "not_assignee",
  "stale_epoch",
  "unknown_item",
  "already_claimed",
]);
// Unspecified result rejection reasons are closed to these concrete validation failures.
export const ResultRejectReasonSchema = z.enum([
  "not_assignee",
  "stale_epoch",
  "unknown_item",
  "not_claimed",
  "repo_mismatch",
]);
export const DescriptionSchema = z.strictObject({
  repo: RepoRefSchema,
  head: ShaSchema,
  role: RoleSchema,
});
export const SessionMsgSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("welcome"), sessionId: IdSchema, peerId: IdSchema }),
  z.strictObject({ type: z.literal("heartbeat"), seq: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("intent"), intentId: IdSchema, text: TextSchema }),
  z.strictObject({ type: z.literal("capability"), intentId: IdSchema, ...DescriptionSchema.shape }),
  z.strictObject({ type: z.literal("datalist-request"), intentId: IdSchema, requestId: IdSchema }),
  z.strictObject({
    type: z.literal("datalist"),
    intentId: IdSchema,
    requestId: IdSchema,
    truncated: z.boolean(),
    entries: DatalistEntriesSchema,
  }),
  z.strictObject({
    type: z.literal("plan"),
    planId: IdSchema,
    intentId: IdSchema,
    epoch: EpochSchema,
    items: z.array(PlanItemSchema).min(1).max(16),
  }),
  z.strictObject({ type: z.literal("claim"), itemId: ItemIdSchema, epoch: EpochSchema }),
  z.strictObject({ type: z.literal("claim-ack"), itemId: ItemIdSchema, epoch: EpochSchema }),
  z.strictObject({
    type: z.literal("claim-reject"),
    itemId: ItemIdSchema,
    reason: ClaimRejectReasonSchema,
  }),
  ResultMsgSchema,
  z.strictObject({ type: z.literal("result-ack"), itemId: ItemIdSchema }),
  z.strictObject({
    type: z.literal("result-reject"),
    itemId: ItemIdSchema,
    reason: ResultRejectReasonSchema,
  }),
  z.strictObject({ type: z.literal("bye"), reason: z.string().min(1).max(500) }),
]);
export type SessionMsg = z.infer<typeof SessionMsgSchema>;
export type ClaimMsg = Extract<SessionMsg, { type: "claim" }>;
export type DatalistMsg = Extract<SessionMsg, { type: "datalist" }>;

export const ItemStatusSchema = PlanItemSchema.extend({
  state: z.enum(["planned", "claimed", "done", "failed"]),
  result: ResultMsgSchema.omit({ type: true }).optional(),
});
export type ItemStatus = z.infer<typeof ItemStatusSchema>;
export const SessionStatusSchema = z.strictObject({
  sessionId: IdSchema,
  listen: z.string(),
  repo: RepoRefSchema,
  joinCode: z
    .string()
    .regex(/^\d{4}-\d{4}-\d{4}$/)
    .nullable(),
  joinCodeExpiresAtMs: z.number().finite().nullable(),
  peers: z.array(
    z.strictObject({
      peerId: IdSchema,
      device: DeviceSchema,
      address: z.string().min(1),
      family: z.enum(["IPv4", "IPv6"]),
      repo: RepoRefSchema.nullable(),
      head: ShaSchema.nullable(),
      role: RoleSchema.nullable(),
    }),
  ),
  intents: z.array(
    z.strictObject({
      intentId: IdSchema,
      text: TextSchema,
      state: z.enum(["open", "no_match", "planned"]),
      items: z.array(ItemStatusSchema),
    }),
  ),
});
export type SessionStatus = z.infer<typeof SessionStatusSchema>;
export const ControlResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    type: z.literal("control-result"),
    ok: z.literal(true),
    result: z.union([SessionStatusSchema, z.strictObject({ intentId: IdSchema })]),
  }),
  z.strictObject({
    type: z.literal("control-result"),
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(["bad_token", "bad_request", "no_match", "not_local"]),
      message: z.string().min(1).max(500),
    }),
  }),
]);
export type ControlResult = z.infer<typeof ControlResultSchema>;
