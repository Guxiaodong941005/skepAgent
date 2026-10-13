import { z } from "zod";
import { RepoRefSchema, ShaSchema } from "../core/schemas/common.js";
import { PEER_PHASES, percentOf, SUMMARY_MAX } from "./progress.js";

export const DATALIST_CAP = 32_768;
export const DeviceSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
export const TokenSchema = z.string().regex(/^[0-9a-f]{32}$/);
const IdSchema = z.string().min(1).max(128);
const ItemIdSchema = z.string().regex(/^I-\d+$/);
const EpochSchema = z.number().int().min(1);
const RoleSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const TextSchema = z.string().min(1).max(4000);

/**
 * Session protocol versions (plan §3.6, ORCH-6). A v2 sub opens with `join{v:2}`; a v2 master
 * answers in the version it was asked for and only sends v2 frames to v2 peers. A v1 master
 * (≤0.1.13) rejects `v:2` as a bad first frame and the sub retries once with `v:1`.
 */
export const PROTOCOL_VERSIONS = [1, 2] as const;
export type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];
export const PROTOCOL_LATEST: ProtocolVersion = 2;
const ProtocolSchema = z.union([z.literal(1), z.literal(2)]);
/** A Skep release as a peer reports it (`0.2.0`, `0.2.0-rc.1+abc`); display only. */
export const VersionSchema = z.string().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/);
/** v2 intent text: a brief may exceed the v1 limit; still far inside one frame (D27). */
export const BRIEF_MAX = 8000;
const BriefSchema = z.string().min(1).max(BRIEF_MAX);
/** Live output per `output` frame (locked plan §9.10). */
export const OUTPUT_MAX_LINES = 20;
export const OUTPUT_MAX_BYTES = 2048;
/** Changed files per result: the list, not the content (locked plan §9.11). */
export const CHANGED_MAX_FILES = 200;
export const CHANGED_CAP = 16_384;

function base64(bytes: number) {
  // Node's decoder accepts noncanonical encodings; the wire contract does not.
  return z.string().refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.length === bytes && decoded.toString("base64") === value;
  }, `Expected canonical base64 encoding of ${bytes} bytes`);
}

export const IntentInputSchema = z.strictObject({
  // v1 peers receive at most the first 4000 characters (master.ts `wireText`).
  text: BriefSchema,
  repos: z.array(RepoRefSchema).min(1).max(16).optional(),
});
/** `v:1` answers in the ≤0.1.13 status shape; `v:2` adds the ORCH-6 fields. */
const ControlStatusSchema = z.strictObject({
  type: z.literal("control"),
  v: ProtocolSchema,
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
  v: ProtocolSchema,
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
    v: ProtocolSchema,
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
export const ChangedFileSchema = z.strictObject({
  path: z.string().min(1).max(512),
  change: z.enum(["added", "modified", "deleted"]),
  /** Line counts; null for binary or unrecorded content. */
  added: z.number().int().nonnegative().nullable(),
  removed: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof ChangedFileSchema>;
/**
 * The files an item changed (v2 results, locked plan §9.11): paths and line counts only, never
 * content. `total` counts every changed file, `files` the first that fit the cap; `partial` means
 * the peer compared only part of the tree.
 */
export const ChangedSchema = z
  .strictObject({
    files: z.array(ChangedFileSchema).max(CHANGED_MAX_FILES),
    total: z.number().int().nonnegative().max(1_000_000),
    partial: z.boolean(),
  })
  .refine((value) => value.files.length <= value.total, "files must not exceed total")
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value.files), "utf8") <= CHANGED_CAP,
    `Serialized changed files must fit in ${CHANGED_CAP} bytes`,
  );
export type Changed = z.infer<typeof ChangedSchema>;
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
  // v2 only on the wire; a sub talking to a v1 master drops it.
  changed: ChangedSchema.optional(),
});
export type SubResult = z.infer<typeof SubResultSchema>;
/** The v1 result frame (≤0.1.13): no changed-files list. */
export const ResultMsgSchema = z.strictObject({
  type: z.literal("result"),
  itemId: ItemIdSchema,
  epoch: EpochSchema,
  ...SubResultSchema.omit({ changed: true }).shape,
});
/** The v2 result: the v1 fields plus the changed-files list. */
export const ResultMsgV2Schema = ResultMsgSchema.extend({ changed: ChangedSchema.optional() });
export type ResultMsg = z.infer<typeof ResultMsgV2Schema>;
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
export const PeerPhaseSchema = z.enum(PEER_PHASES);
const SummarySchema = z.string().max(SUMMARY_MAX);
const CountSchema = z.number().int().nonnegative().max(10_000);
const progressFields = {
  done: CountSchema,
  total: CountSchema,
  failed: CountSchema,
  percent: z.number().int().min(0).max(100),
  summary: SummarySchema, // "" allowed
  itemId: ItemIdSchema.optional(),
};
type ProgressCounts = { done: number; total: number; failed: number; percent: number };
function progressRules<T extends z.ZodType<ProgressCounts>>(schema: T): T {
  return schema
    .refine((m) => m.done <= m.total && m.failed <= m.done, "done ≤ total and failed ≤ done")
    .refine(
      (m) => m.percent === percentOf(m.done, m.total),
      "percent must equal floor(100*done/total)",
    );
}
/**
 * One member serves both directions; `receive` enforces the direction rules (plan §2.2): a sub
 * never names a peer or sends "left", and a master relay always names another peer.
 */
export const ProgressMsgSchema = progressRules(
  z.strictObject({
    type: z.literal("progress"),
    // Master-filled identity. MUST be absent sub→master, MUST be present master→sub.
    peerId: IdSchema.optional(),
    device: DeviceSchema.optional(),
    role: RoleSchema.nullable().optional(),
    phase: z.enum([...PEER_PHASES, "left"]), // "left": master→sub only
    ...progressFields,
  }),
);
export type ProgressMsg = z.infer<typeof ProgressMsgSchema>;

const OutputLinesSchema = z
  .array(z.string().max(OUTPUT_MAX_BYTES))
  .min(1)
  .max(OUTPUT_MAX_LINES)
  .refine(
    (lines) => Buffer.byteLength(lines.join("\n"), "utf8") <= OUTPUT_MAX_BYTES,
    `Output lines must fit in ${OUTPUT_MAX_BYTES} bytes`,
  );
/** One live-output frame: new complete lines of one item's agent, redacted (plan §9.6). */
export const OutputMsgSchema = z.strictObject({
  type: z.literal("output"),
  itemId: ItemIdSchema,
  lines: OutputLinesSchema,
  /** Lines printed since the previous frame that did not fit this one. */
  skipped: z.number().int().nonnegative().max(1_000_000),
});
export type OutputMsg = z.infer<typeof OutputMsgSchema>;

const sessionMembers = [
  z.strictObject({ type: z.literal("heartbeat"), seq: z.number().int().nonnegative() }),
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
  z.strictObject({ type: z.literal("result-ack"), itemId: ItemIdSchema }),
  z.strictObject({
    type: z.literal("result-reject"),
    itemId: ItemIdSchema,
    reason: ResultRejectReasonSchema,
  }),
  ProgressMsgSchema,
  z.strictObject({ type: z.literal("bye"), reason: z.string().min(1).max(500) }),
] as const;

/** v1 frames, exactly as ≤0.1.13 speaks them: every member strict. */
export const SessionMsgSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("welcome"), sessionId: IdSchema, peerId: IdSchema }),
  z.strictObject({ type: z.literal("intent"), intentId: IdSchema, text: TextSchema }),
  ...sessionMembers,
  ResultMsgSchema,
]);
/**
 * v2 frames (ORCH-6): the welcome names the master's release, a sub reports its own release,
 * live-output choice, repo and role in `peer-info`, intents carry briefs up to {@link BRIEF_MAX}, results may
 * list changed files, and an opted-in sub sends `output`.
 */
export const SessionMsgV2Schema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("welcome"),
    sessionId: IdSchema,
    peerId: IdSchema,
    version: VersionSchema,
  }),
  z.strictObject({ type: z.literal("intent"), intentId: IdSchema, text: BriefSchema }),
  ...sessionMembers,
  ResultMsgV2Schema,
  z.strictObject({
    type: z.literal("peer-info"),
    version: VersionSchema,
    shareOutput: z.boolean(),
    /**
     * The repo and role this join works on, known at join time, so the master can show and
     * route by them before the first intent's `capability`. Optional: earlier v2 builds omit it.
     */
    repo: RepoRefSchema.optional(),
    role: RoleSchema.optional(),
  }),
  OutputMsgSchema,
]);
export type SessionMsg = z.infer<typeof SessionMsgSchema> | z.infer<typeof SessionMsgV2Schema>;

/** The frame schema of a negotiated protocol version. */
export function sessionSchema(v: ProtocolVersion) {
  return v === 2 ? SessionMsgV2Schema : SessionMsgSchema;
}
export type ClaimMsg = Extract<SessionMsg, { type: "claim" }>;
export type PeerInfoMsg = Extract<SessionMsg, { type: "peer-info" }>;
export type DatalistMsg = Extract<SessionMsg, { type: "datalist" }>;

export const ItemStatusSchema = PlanItemSchema.extend({
  state: z.enum(["planned", "claimed", "done", "failed"]),
  result: ResultMsgV2Schema.omit({ type: true }).optional(),
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
      // Optional: a status from a ≤0.1.13 master has neither (ORCH-6).
      protocol: ProtocolSchema.optional(),
      version: VersionSchema.nullable().optional(),
      shareOutput: z.boolean().optional(),
      progress: progressRules(z.strictObject({ phase: PeerPhaseSchema, ...progressFields })),
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

/** The status a ≤0.1.13 client parses strictly: no v2 peer fields, no changed-files lists. */
export function v1Status(status: SessionStatus): SessionStatus {
  return {
    ...status,
    peers: status.peers.map(({ protocol: _p, version: _v, shareOutput: _s, ...peer }) => peer),
    intents: status.intents.map((intent) => ({
      ...intent,
      items: intent.items.map((item) => {
        if (item.result === undefined) return item;
        const { changed: _changed, ...result } = item.result;
        return { ...item, result };
      }),
    })),
  };
}
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
