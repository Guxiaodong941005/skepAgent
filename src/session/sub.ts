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
import type { SubHandle, SubOptions } from "./index.js";
import {
  DATALIST_CAP,
  type DatalistEntry,
  DatalistEntrySchema,
  DescriptionSchema,
  DeviceSchema,
  HandshakeMsgSchema,
  type PlanItem,
  type SessionMsg,
  SessionMsgSchema,
  SubResultSchema,
} from "./messages.js";

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

export async function connectSub(o: SubOptions): Promise<SubHandle> {
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
  const items = new Map<
    string,
    { item: PlanItem; state: "claiming" | "working" | "sent" | "done" }
  >();
  const event = (kind: string, message: string) => o.onEvent?.({ kind, message });
  const callbackFailed = () => {
    event("error", "Session callback failed or returned invalid data");
    wire.finish(
      "callback_error",
      wire.channel ? { type: "bye", reason: "callback_error" } : undefined,
    );
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
        event("intent", new Redactor().redact(message.text));
        void Promise.resolve()
          .then(() => o.describe())
          .then((value) => {
            if (!wire.active) return;
            const description = DescriptionSchema.parse(value);
            descriptions.set(message.intentId, description);
            wire.send({ type: "capability", intentId: message.intentId, ...description });
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
          items.set(item.itemId, { item, state: "claiming" });
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
        void Promise.resolve()
          .then(() => o.onItem({ ...work.item }))
          .then((value) => {
            if (!wire.active || value === null) return;
            const result = SubResultSchema.parse(value);
            if (result.repo !== work.item.repo)
              throw new ChannelError("Item result repository differs from assignment");
            work.state = "sent";
            wire.send({
              type: "result",
              itemId: work.item.itemId,
              epoch: work.item.epoch,
              ...result,
              summary: new Redactor().redact(result.summary).slice(0, 4000),
            });
          })
          .catch(callbackFailed);
        return;
      }
      case "claim-reject": {
        const work = items.get(message.itemId);
        if (work?.state !== "claiming") throw new ChannelError("Unexpected claim rejection");
        work.state = "done";
        event("claim-reject", `${message.itemId}: ${message.reason}`);
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
        return;
      }
      default:
        throw new ChannelError("Message is not allowed from a master");
    }
  };

  const wire = new SessionWire(
    stream,
    clock,
    (frame) => {
      const value = wire.read(frame);
      if (phase === "challenge" || phase === "accept") {
        cancelFirst();
        const message = HandshakeMsgSchema.parse(value);
        if (message.type === "join-reject") {
          rejectReady(new JoinRejectedError(message.reason));
          wire.finish(message.reason);
          return;
        }
        if (phase === "challenge" && message.type === "join-challenge") {
          keys = deriveKeys({
            privateKey: ephemeral.privateKey,
            remotePub: Buffer.from(message.pub, "base64"),
            subPub: ephemeral.pub,
            subNonce,
            masterPub: Buffer.from(message.pub, "base64"),
            masterNonce: Buffer.from(message.nonce, "base64"),
            device: o.device,
            code,
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
        const message = SessionMsgSchema.parse(value);
        if (phase === "welcome") {
          if (message.type !== "welcome")
            throw new ChannelError("First encrypted message must be welcome");
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
          };
          wire.startHeartbeat(heartbeatMs);
          resolveReady(handle);
        } else {
          receive(message);
          if (wire.active) wire.received();
        }
      }
    },
    (reason) => {
      if (!handle)
        rejectReady(new ChannelError(`Session connection ended before welcome: ${reason}`));
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
      v: 1,
      device: o.device,
      pub: ephemeral.pub.toString("base64"),
      nonce: subNonce.toString("base64"),
    });
  } catch {
    wire.destroy("transport_error");
  }
  return ready;
}
