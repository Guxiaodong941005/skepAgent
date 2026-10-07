/**
 * CLI ↔ daemon socket frames (ARCHITECTURE §12).
 *
 * NDJSON: one strict JSON object per line, at most {@link MAX_FRAME_BYTES}. `v` is the only
 * version; a mismatch is `protocol_version` and nothing else is interpreted. The `publish`
 * method carries an {@link IntentSpec} — a serializable description the daemon maps back to the
 * same pure intent the CLI uses in fallback mode (ARCHITECTURE §7.4), so both paths agree.
 * Signing payloads travel as base64 and signatures come back as armored text; the human private
 * key never crosses the socket.
 */

import { z } from "zod";
import { IntentSpecSchema } from "../core/intent-spec.js";
import { AgentIdSchema, PositiveIntSchema, TaskIdSchema } from "../core/schemas/common.js";
import { SshSignatureSchema } from "../git/signer.js";

/** Current frame version. Any other `v` is refused with `protocol_version`. */
export const IPC_VERSION = 1;

/** One frame, including its trailing newline, may not exceed this (ARCHITECTURE §12). */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** Socket file mode: owner read/write, nobody else (ARCHITECTURE §12). */
export const SOCKET_MODE = 0o600;

/** Directory the socket lives in: owner only. */
export const SOCKET_DIR_MODE = 0o700;

export const IPC_METHODS = [
  "status",
  "log",
  "publish",
  "agent.start",
  "agent.stop",
  "logs.tail",
  "doctor",
  "ping",
  "pull",
] as const;

export type IpcMethod = (typeof IPC_METHODS)[number];

/**
 * Error codes a daemon may return. `protocol_version` is reserved for a `v` mismatch;
 * `bad_frame` covers anything that is not a valid frame.
 */
export const IPC_ERROR_CODES = [
  "protocol_version",
  "bad_frame",
  "unknown_method",
  "bad_params",
  "unavailable",
  "internal",
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

const FrameIdSchema = z.string().min(1).max(64);
const RequestIdSchema = z.string().min(1).max(64);

// ---------------------------------------------------------------------------------------------
// IntentSpec — every kind a CLI write command can ask the daemon to publish (SK-603 sends these).
// The schema is defined in `core/intent-spec.ts` next to `intentFromSpec` and re-exported here,
// so a frame this module accepts is exactly a spec that mapping can build (ARCHITECTURE §2).
// ---------------------------------------------------------------------------------------------

export type { IntentSpec } from "../core/intent-spec.js";
export { IntentSpecSchema } from "../core/intent-spec.js";

/** Every CLI write kind, in spec order. Tests assert the schema covers each of them. */
export const INTENT_KINDS = [
  "task.create",
  "task.cancel",
  "plan.approve",
  "plan.reject",
  "lease.revoke",
  "decide",
  "replan.request",
] as const;

export type IntentKind = (typeof INTENT_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// Method params
// ---------------------------------------------------------------------------------------------

const StatusParams = z.strictObject({});

const LogParams = z.strictObject({
  task: TaskIdSchema,
  /** First seq to return; omitted means the whole task log. */
  from_seq: PositiveIntSchema.optional(),
});

const PublishParams = z.strictObject({
  intent: IntentSpecSchema,
  signer: z.enum(["daemon", "human"]),
});

/** `agent.start`/`agent.stop`: the role directory the slot is bound to (PRD §7.1). */
const AgentSlotParams = z.strictObject({
  role_dir: z.string().min(1).max(1024),
});

/**
 * `logs.tail` serves local agents only (D18): a remote agent has no log transport, and the
 * handler reports that instead of reaching out.
 */
const LogsTailParams = z.strictObject({
  agent: AgentIdSchema,
  follow: z.boolean().optional(),
  /** Bytes of existing log to send before following. */
  tail_bytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .optional(),
});

const DoctorParams = z.strictObject({});

const PingParams = z.strictObject({});

const PARAMS_BY_METHOD = {
  status: StatusParams,
  log: LogParams,
  publish: PublishParams,
  "agent.start": AgentSlotParams,
  "agent.stop": AgentSlotParams,
  "logs.tail": LogsTailParams,
  doctor: DoctorParams,
  ping: PingParams,
  pull: PingParams,
} as const;

export type ParamsOf<M extends IpcMethod> = z.infer<(typeof PARAMS_BY_METHOD)[M]>;

export interface MethodCall<M extends IpcMethod = IpcMethod> {
  method: M;
  params: ParamsOf<M>;
}

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

const SignResultSchema = z.strictObject({
  req: RequestIdSchema,
  signature: SshSignatureSchema,
});

const SignRequestSchema = z.strictObject({
  req: RequestIdSchema,
  /** The exact commit bytes to sign, base64 (standard alphabet, no newlines). */
  payload_b64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  principal: z.string().min(1).max(128),
});

/** One `logs.tail` chunk. `text` is already redacted by the server (ARCHITECTURE §16). */
const StreamChunkSchema = z.strictObject({
  agent: AgentIdSchema,
  text: z.string().max(64 * 1024),
  /** Set on the final chunk, including when following stops. */
  eof: z.boolean().optional(),
});

export const ClientFrameSchema = z.union([
  z.strictObject({
    v: z.literal(IPC_VERSION),
    id: FrameIdSchema,
    method: z.enum(IPC_METHODS),
    params: z.unknown().optional(),
  }),
  z.strictObject({
    v: z.literal(IPC_VERSION),
    id: FrameIdSchema,
    sign_result: SignResultSchema,
  }),
]);

export const ServerFrameSchema = z.union([
  z.strictObject({
    v: z.literal(IPC_VERSION),
    id: FrameIdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.strictObject({
    v: z.literal(IPC_VERSION),
    id: FrameIdSchema,
    ok: z.literal(false),
    error: z.strictObject({
      code: z.enum(IPC_ERROR_CODES),
      message: z.string().min(1).max(2000),
    }),
  }),
  z.strictObject({
    v: z.literal(IPC_VERSION),
    id: FrameIdSchema,
    sign_request: SignRequestSchema,
  }),
  z.strictObject({
    v: z.literal(IPC_VERSION),
    id: FrameIdSchema,
    stream: StreamChunkSchema,
  }),
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

export type RequestFrame = Extract<ClientFrame, { method: IpcMethod }>;
export type SignResultFrame = Extract<ClientFrame, { sign_result: unknown }>;
export type ResultFrame = Extract<ServerFrame, { ok: true }>;
export type ErrorFrame = Extract<ServerFrame, { ok: false }>;
export type SignRequestFrame = Extract<ServerFrame, { sign_request: unknown }>;
export type StreamFrame = Extract<ServerFrame, { stream: unknown }>;

export class ProtocolError extends Error {
  readonly code: IpcErrorCode;

  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
  }
}

export interface DecodedFrame {
  /** Present only when the frame is a valid current-version frame. */
  frame?: ClientFrame | ServerFrame;
  /**
   * Why the frame was refused. A version mismatch is always `protocol_version`, even when the
   * rest of the frame would not validate (ARCHITECTURE §12: `v` is checked first).
   */
  error?: ProtocolError;
  /** Correlation id, recovered even from a rejected frame so the peer can be answered. */
  id?: string;
}

/** Read a correlation id out of anything object-shaped; absent or unusable ids yield undefined. */
function frameIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("id" in value)) return undefined;
  const id = (value as { id: unknown }).id;
  return FrameIdSchema.safeParse(id).success ? (id as string) : undefined;
}

function versionProblem(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("v" in value)) return undefined;
  const version = (value as { v: unknown }).v;
  if (version === IPC_VERSION) return undefined;
  const shown = typeof version === "number" ? String(version) : JSON.stringify(version);
  return `protocol version ${shown} is not supported (this daemon speaks v${IPC_VERSION})`;
}

/**
 * Decode one already-parsed JSON value as a frame of `side`.
 *
 * Order matters: a `v` other than {@link IPC_VERSION} is `protocol_version` before any other
 * field is judged, so a mismatched peer learns why rather than seeing a generic schema error.
 */
export function decodeFrame(value: unknown, side: "client" | "server"): DecodedFrame {
  const id = frameIdOf(value);
  const mismatch = versionProblem(value);
  if (mismatch !== undefined) {
    return { id, error: new ProtocolError("protocol_version", mismatch) };
  }
  const schema = side === "client" ? ClientFrameSchema : ServerFrameSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { id, error: new ProtocolError("bad_frame", z.prettifyError(parsed.error)) };
  }
  return { id, frame: parsed.data };
}

/** Encode a frame as one NDJSON line (trailing newline included). */
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Validate `params` against the method it arrived with. */
export function parseParams<M extends IpcMethod>(
  method: M,
  params: unknown,
): { ok: true; params: ParamsOf<M> } | { ok: false; error: string } {
  const parsed = PARAMS_BY_METHOD[method].safeParse(params ?? {});
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, params: parsed.data as ParamsOf<M> };
}

/** A request frame plus its validated params. */
export type ParsedRequest = {
  [M in IpcMethod]: { id: string; method: M; params: ParamsOf<M> };
}[IpcMethod];

export function parseRequest(
  frame: RequestFrame,
): { ok: true; request: ParsedRequest } | { ok: false; error: string } {
  const params = parseParams(frame.method, frame.params);
  if (!params.ok) return params;
  return {
    ok: true,
    request: { id: frame.id, method: frame.method, params: params.params } as ParsedRequest,
  };
}

export function errorFrame(id: string, code: IpcErrorCode, message: string): ErrorFrame {
  return { v: IPC_VERSION, id, ok: false, error: { code, message: message.slice(0, 2000) } };
}

export function resultFrame(id: string, result: unknown): ResultFrame {
  return { v: IPC_VERSION, id, ok: true, result };
}

/** Decode the base64 payload of a `sign_request`. Rejects non-canonical padding and whitespace. */
export function decodeSignPayload(payloadB64: string): Uint8Array {
  const parsed = SignRequestSchema.shape.payload_b64.safeParse(payloadB64);
  if (!parsed.success) {
    throw new ProtocolError("bad_frame", "sign payload is not canonical base64");
  }
  return Buffer.from(parsed.data, "base64");
}
