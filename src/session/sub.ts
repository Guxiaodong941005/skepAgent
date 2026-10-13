import { timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { z } from "zod";
import { Redactor } from "../exec/redact.js";
import { systemClock } from "../util/clock.js";
import { cryptoRandom } from "../util/random.js";
import { ChannelError, positiveDuration, SecureChannel, SessionWire } from "./channel.js";
import {
  confirmation,
  createEphemeral,
  deriveKeys,
  fingerprint,
  JoinRejectedError,
  type KeyMaterial,
  normalizeJoinCode,
} from "./handshake.js";
import type { AgentProgressState, SubHandle, SubOptions } from "./index.js";
import {
  CHANGED_CAP,
  CHANGED_MAX_FILES,
  type Changed,
  ChangedSchema,
  ControlResultSchema,
  DATALIST_CAP,
  type DatalistEntry,
  DatalistEntrySchema,
  DescriptionSchema,
  DeviceSchema,
  HandshakeMsgSchema,
  type PlanItem,
  PROTOCOL_LATEST,
  type ProgressMsg,
  type ProtocolVersion,
  type SessionMsg,
  SubResultSchema,
  sessionSchema,
  VersionSchema,
} from "./messages.js";
import { OutputTap } from "./output.js";
import {
  type PeerProgress,
  ProgressCoalescer,
  type ProgressValue,
  progressInterval,
  type SubItemState,
  sameProgress,
  subProgress,
} from "./progress.js";

/** Redact before sizing: escaping and UTF-8 encoding both count against the wire limit. */
export function prepareDatalist(input: DatalistEntry[]): {
  entries: DatalistEntry[];
  truncated: boolean;
} {
  const values = z.array(DatalistEntrySchema).parse(input);
  const redactor = new Redactor();
  const entries: DatalistEntry[] = [];
  let bytes = 2;
  for (const value of values) {
    const entry: DatalistEntry = {
      kind: value.kind,
      path: redactor.redact(value.path).slice(0, 1024),
      ...(value.detail === undefined
        ? {}
        : { detail: redactor.redact(value.detail).slice(0, 1024) }),
    };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + (entries.length ? 1 : 0);
    if (entries.length === 2000 || bytes + size > DATALIST_CAP) break;
    entries.push(entry);
    bytes += size;
  }
  return { entries, truncated: entries.length < values.length };
}

/** Redacted paths that fit the wire cap; files beyond it are still counted in `total`. */
export function prepareChanged(input: Changed): Changed {
  const value = ChangedSchema.parse(input);
  const redactor = new Redactor();
  const files: Changed["files"] = [];
  let bytes = 2;
  for (const file of value.files) {
    const entry = { ...file, path: redactor.redact(file.path).slice(0, 512) };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + (files.length ? 1 : 0);
    if (files.length === CHANGED_MAX_FILES || bytes + size > CHANGED_CAP) break;
    files.push(entry);
    bytes += size;
  }
  return { files, total: value.total, partial: value.partial };
}

/** The master answered `join{v:2}` the way a ≤0.1.13 master answers any unknown first frame. */
export class OlderMasterError extends Error {
  override readonly name = "OlderMasterError";
  constructor() {
    super("The master runs Skep 0.1.13 or older, which speaks session protocol v1 only");
  }
}

export const OLDER_MASTER_NOTE =
  "master is older (≤0.1.13); orchestration features limited (no long briefs, changed-file " +
  "lists or live output)";

/**
 * Joins with the newest protocol. A v1 master rejects `join{v:2}` before any key exchange, so the
 * join code is untouched and one retry with `v:1` is safe (plan §3.6). A caller-supplied stream
 * cannot be reopened; it fails with {@link OlderMasterError} instead.
 */
export async function connectSub(o: SubOptions): Promise<SubHandle> {
  const protocol = o.protocol ?? PROTOCOL_LATEST;
  try {
    return await connectOnce(o, protocol);
  } catch (error) {
    if (!(error instanceof OlderMasterError) || protocol === 1 || o.target === undefined) {
      throw error;
    }
    o.onEvent?.({ kind: "protocol", message: OLDER_MASTER_NOTE });
    return connectOnce(o, 1);
  }
}

async function connectOnce(o: SubOptions, protocol: ProtocolVersion): Promise<SubHandle> {
  const code = normalizeJoinCode(o.code);
  DeviceSchema.parse(o.device);
  if (Boolean(o.stream) === Boolean(o.target))
    throw new ChannelError("Supply exactly one session stream or TCP target");
  if (
    o.target &&
    (!o.target.host ||
      !Number.isInteger(o.target.port) ||
      o.target.port < 1 ||
      o.target.port > 65535)
  ) {
    throw new ChannelError("Session target requires a host and TCP port between 1 and 65535");
  }
  const clock = o.clock ?? systemClock;
  const random = o.random ?? cryptoRandom;
  const heartbeatMs = positiveDuration(o.heartbeatMs, 10_000);
  const progressMs = progressInterval(o.progressIntervalMs);
  const sendsProgress = o.progress !== false;
  const version = VersionSchema.parse(o.version ?? "unknown");
  const schema = sessionSchema(protocol);
  let olderMaster = false;
  let masterVersion: string | null = null;
  // Off unless this device's human opted in, for this session only (locked plan §9.9).
  let shareOutput = protocol === 2 && o.shareOutput === true;
  const ephemeral = createEphemeral(random);
  const subNonce = Buffer.from(random.bytes(16));
  const stream = o.stream ?? createConnection(o.target ?? { host: "", port: 0 });
  let phase: "challenge" | "accept" | "welcome" | "session" = "challenge";
  let keys: KeyMaterial | null = null;
  let fp = "";
  let handle: SubHandle | null = null;
  let resolveReady: (value: SubHandle) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<SubHandle>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let resolveClosed: (value: { reason: string }) => void = () => {};
  const closed = new Promise<{ reason: string }>((resolve) => {
    resolveClosed = resolve;
  });
  const descriptions = new Map<string, z.infer<typeof DescriptionSchema> | null>();
  const requests = new Set<string>();
  const items = new Map<string, { item: PlanItem; state: SubItemState; intentId: string }>();
  /** Each intent's full text: the agent works from it, not from the 200-character title (S8). */
  const intentTexts = new Map<string, string>();
  const agents = new Map<string, AgentProgressState>();
  let everBlocked = false;
  let role: string | null = null;
  let lastSelf: PeerProgress | null = null;
  const event = (kind: string, message: string) => o.onEvent?.({ kind, message });
  const callbackFailed = () => {
    event("error", "Session callback failed or returned invalid data");
    wire.finish(
      "callback_error",
      wire.channel ? { type: "bye", reason: "callback_error" } : undefined,
    );
  };

  const coalescer = new ProgressCoalescer<ProgressValue>({
    intervalMs: progressMs,
    monotonicMs: () => clock.monotonicMs(),
    schedule: (ms, fn) => wire.timer(ms, fn),
    // No identity on the way up: the master fills it from the authenticated wire (plan §2.4).
    send: (value) => {
      if (wire.active) wire.send({ type: "progress", ...value });
    },
  });
  const tap = new OutputTap({
    intervalMs: progressMs,
    monotonicMs: () => clock.monotonicMs(),
    schedule: (ms, fn) => wire.timer(ms, fn),
    send: (itemId, frame) => {
      if (wire.active && shareOutput) wire.send({ type: "output", itemId, ...frame });
    },
  });
  const sendPeerInfo = () => {
    if (protocol === 2 && wire.active) wire.send({ type: "peer-info", version, shareOutput });
  };
  const progressChanged = () => {
    if (!handle || !wire.active) return;
    const value = subProgress(
      [...items.values()].map(({ item, state }) => ({
        itemId: item.itemId,
        title: item.title,
        state,
      })),
      agents,
      everBlocked,
    );
    if (sendsProgress) coalescer.push(value);
    const self: PeerProgress = { peerId: handle.peerId, device: o.device, role, ...value };
    if (lastSelf && sameProgress(lastSelf, self)) return;
    lastSelf = self;
    try {
      o.onProgress?.({ ...self, self: true });
    } catch {
      callbackFailed();
    }
  };
  const relayed = (message: ProgressMsg) => {
    if (
      message.peerId === undefined ||
      message.device === undefined ||
      message.peerId === handle?.peerId
    )
      throw new ChannelError("Relayed progress must name another peer");
    const { type: _type, peerId, device, role: peerRole, ...value } = message;
    try {
      o.onProgress?.({ peerId, device, role: peerRole ?? null, ...value, self: false });
    } catch {
      callbackFailed();
    }
  };

  const receive = (message: SessionMsg) => {
    if (!handle) throw new ChannelError("Session has not received welcome");
    switch (message.type) {
      case "heartbeat":
        return;
      case "bye":
        wire.finish(message.reason);
        return;
      case "intent": {
        if (descriptions.has(message.intentId)) throw new ChannelError("Duplicate intent");
        descriptions.set(message.intentId, null);
        intentTexts.set(message.intentId, message.text);
        event("intent", new Redactor().redact(message.text));
        void Promise.resolve()
          .then(() => o.describe())
          .then((value) => {
            if (!wire.active) return;
            const description = DescriptionSchema.parse(value);
            descriptions.set(message.intentId, description);
            wire.send({ type: "capability", intentId: message.intentId, ...description });
            role = description.role;
            progressChanged();
          })
          .catch(callbackFailed);
        return;
      }
      case "datalist-request": {
        const description = descriptions.get(message.intentId);
        if (!description || requests.has(message.requestId))
          throw new ChannelError("Unexpected datalist request");
        requests.add(message.requestId);
        event("datalist-request", message.intentId);
        void Promise.resolve()
          .then(() => o.collectDatalist(description.repo))
          .then((entries) => {
            if (!wire.active) return;
            wire.send({
              type: "datalist",
              intentId: message.intentId,
              requestId: message.requestId,
              ...prepareDatalist(entries),
            });
          })
          .catch(callbackFailed);
        return;
      }
      case "plan": {
        if (!descriptions.get(message.intentId))
          throw new ChannelError("Plan has no described intent");
        for (const item of message.items) {
          if (item.epoch !== message.epoch)
            throw new ChannelError("Plan item epoch differs from plan epoch");
          if (item.assignee !== handle.peerId) continue;
          if (items.has(item.itemId) || item.repo !== descriptions.get(message.intentId)?.repo) {
            throw new ChannelError("Duplicate item or plan for an undescribed repository");
          }
          items.set(item.itemId, { item, state: "claiming", intentId: message.intentId });
          wire.send({ type: "claim", itemId: item.itemId, epoch: item.epoch });
        }
        event("plan", message.planId);
        return;
      }
      case "claim-ack": {
        const work = items.get(message.itemId);
        if (work?.state !== "claiming" || message.epoch !== work.item.epoch)
          throw new ChannelError("Unexpected claim acknowledgement");
        work.state = "working";
        event("claim-ack", message.itemId);
        progressChanged();
        void Promise.resolve()
          .then(() => {
            const intentText = intentTexts.get(work.intentId);
            return o.onItem({ ...work.item }, intentText === undefined ? {} : { intentText });
          })
          .then((value) => {
            tap.finish(work.item.itemId);
            if (!wire.active || value === null) return;
            const { changed, ...result } = SubResultSchema.parse(value);
            if (result.repo !== work.item.repo)
              throw new ChannelError("Item result repository differs from assignment");
            work.state = "sent";
            wire.send({
              type: "result",
              itemId: work.item.itemId,
              epoch: work.item.epoch,
              ...result,
              summary: new Redactor().redact(result.summary).slice(0, 4000),
              // A v1 master rejects unknown keys; the summary's `changed …` line still names them.
              ...(protocol === 2 && changed !== undefined
                ? { changed: prepareChanged(changed) }
                : {}),
            });
          })
          .catch(callbackFailed);
        return;
      }
      case "claim-reject": {
        const work = items.get(message.itemId);
        if (work?.state !== "claiming") throw new ChannelError("Unexpected claim rejection");
        work.state = "rejected";
        event("claim-reject", `${message.itemId}: ${message.reason}`);
        progressChanged();
        return;
      }
      case "result-ack":
      case "result-reject": {
        const work = items.get(message.itemId);
        if (work?.state !== "sent") throw new ChannelError("Unexpected result response");
        work.state = "done";
        event(
          message.type,
          message.type === "result-reject"
            ? `${message.itemId}: ${message.reason}`
            : message.itemId,
        );
        progressChanged();
        return;
      }
      case "progress":
        relayed(message);
        return;
      default:
        throw new ChannelError("Message is not allowed from a master");
    }
  };

  const wire = new SessionWire(
    stream,
    clock,
    (frame) => {
      const value = wire.read(frame);
      if (phase === "challenge" && protocol > 1) {
        // A ≤0.1.13 master answers an unknown first frame with a control error and hangs up.
        const older = ControlResultSchema.safeParse(value);
        if (older.success && !older.data.ok && older.data.error.code === "bad_request") {
          cancelFirst();
          olderMaster = true;
          wire.finish("older_master");
          return;
        }
      }
      if (phase === "challenge" || phase === "accept") {
        cancelFirst();
        const message = HandshakeMsgSchema.parse(value);
        if (message.type === "join-reject") {
          rejectReady(new JoinRejectedError(message.reason));
          wire.finish(message.reason);
          return;
        }
        if (phase === "challenge" && message.type === "join-challenge") {
          if (message.v !== protocol)
            throw new ChannelError("Master answered in another protocol version");
          keys = deriveKeys({
            privateKey: ephemeral.privateKey,
            remotePub: Buffer.from(message.pub, "base64"),
            subPub: ephemeral.pub,
            subNonce,
            masterPub: Buffer.from(message.pub, "base64"),
            masterNonce: Buffer.from(message.nonce, "base64"),
            device: o.device,
            code,
            protocol,
          });
          fp = fingerprint(keys.th);
          o.onFingerprint?.(fp);
          phase = "accept";
          wire.send({ type: "join-confirm", mac: confirmation(keys, "sub").toString("base64") });
        } else if (phase === "accept" && message.type === "join-accept" && keys) {
          if (!timingSafeEqual(Buffer.from(message.mac, "base64"), confirmation(keys, "master"))) {
            throw new ChannelError("Master key confirmation did not match");
          }
          wire.channel = new SecureChannel(keys.kS2M, keys.kM2S);
          phase = "welcome";
        } else throw new ChannelError("Unexpected handshake message");
      } else {
        const message: SessionMsg = schema.parse(value);
        if (phase === "welcome") {
          if (message.type !== "welcome")
            throw new ChannelError("First encrypted message must be welcome");
          if ("version" in message && typeof message.version === "string")
            masterVersion = message.version;
          phase = "session";
          cancelHandshake();
          handle = {
            peerId: message.peerId,
            sessionId: message.sessionId,
            fingerprint: fp,
            close: async () => {
              wire.finish("sub_closed", { type: "bye", reason: "sub_closed" });
              await closed;
            },
            closed,
            reportAgent: (itemId, state) => {
              if (!wire.active) return;
              if (!items.has(itemId)) throw new ChannelError(`Unknown session item ${itemId}`);
              agents.set(itemId, state);
              if (state === "blocked") everBlocked = true;
              progressChanged();
            },
            silenceMs: () => wire.silenceMs(),
            protocol,
            masterVersion: () => masterVersion,
            sharingOutput: () => shareOutput,
            shareOutput: (on) => {
              if (protocol !== 2) throw new OlderMasterError();
              if (!wire.active || on === shareOutput) return;
              shareOutput = on;
              if (!on) tap.clear();
              sendPeerInfo();
            },
            reportOutput: (itemId, chunk) => {
              if (!shareOutput || !wire.active || chunk === "") return;
              // Only an item this peer is running; late chunks after its result are dropped.
              if (items.get(itemId)?.state !== "working") return;
              tap.push(itemId, chunk);
            },
          };
          wire.startHeartbeat(heartbeatMs);
          // Before any progress: the master learns this peer's release and output choice first.
          sendPeerInfo();
          // The first progress frame is the opt-in for relays (plan §2.6).
          progressChanged();
          resolveReady(handle);
        } else {
          receive(message);
          if (wire.active) wire.received();
        }
      }
    },
    (reason) => {
      tap.clear();
      if (!handle)
        rejectReady(
          olderMaster
            ? new OlderMasterError()
            : new ChannelError(`Session connection ended before welcome: ${reason}`),
        );
      resolveClosed({ reason });
      event("disconnected", reason);
    },
  );
  const cancelFirst = wire.timer(5000, () => wire.destroy("first_frame_timeout"));
  const cancelHandshake = wire.timer(15_000, () => {
    rejectReady(new JoinRejectedError("expired"));
    wire.destroy("handshake_timeout");
  });
  try {
    wire.send({
      type: "join",
      v: protocol,
      device: o.device,
      pub: ephemeral.pub.toString("base64"),
      nonce: subNonce.toString("base64"),
    });
  } catch {
    wire.destroy("transport_error");
  }
  return ready;
}
