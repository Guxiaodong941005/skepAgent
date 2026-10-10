import { timingSafeEqual } from "node:crypto";
import { createServer, isIP, type Server } from "node:net";
import type { Duplex } from "node:stream";
import { RepoRefSchema } from "../core/schemas/common.js";
import { findSecrets, Redactor } from "../exec/redact.js";
import { systemClock } from "../util/clock.js";
import { cryptoRandom } from "../util/random.js";
import { ChannelError, positiveDuration, SecureChannel, SessionWire } from "./channel.js";
import {
  confirmation,
  createEphemeral,
  deriveKeys,
  fingerprint,
  generateJoinCode,
  type KeyMaterial,
} from "./handshake.js";
import type { MasterHandle, MasterOptions } from "./index.js";
import {
  type ControlResult,
  DeviceSchema,
  FirstFrameSchema,
  HandshakeMsgSchema,
  IntentInputSchema,
  type ItemStatus,
  type JoinRejectReason,
  type ProgressMsg,
  ProgressMsgSchema,
  type SessionMsg,
  SessionMsgSchema,
  type SessionStatus,
  SessionStatusSchema,
  TokenSchema,
} from "./messages.js";
import type { PeerPath } from "./path.js";
import {
  deriveProgress,
  type PeerPhase,
  type PeerProgress,
  ProgressCoalescer,
  progressInterval,
  type ReportedProgress,
} from "./progress.js";
import { applyClaim, applyResult, buildPlan, matchSub, type SubCandidate } from "./state.js";

export class ListenAddressError extends Error {
  override readonly name = "ListenAddressError";
}
export class NoMatchError extends Error {
  override readonly name = "NoMatchError";
  readonly code = "no_match";
  constructor(repos: readonly string[], peers: number) {
    super(
      peers === 0
        ? "No peers have joined the session, so nothing can take the intent"
        : `None of the ${peers} connected peer(s) works on repo ${repos.join(", ")}`,
    );
  }
}

interface Peer {
  peerId: string;
  device: string;
  path: PeerPath;
  joinedOrder: number;
  wire: SessionWire;
  repo: string | null;
  head: string | null;
  role: string | null;
  progress: {
    /** Only peers that sent a `progress` frame receive relays (plan §2.6). */
    optIn: boolean;
    reported: ReportedProgress | null;
    /** Coalesces relays *about* this peer to every other opted-in peer. */
    coalescer: ProgressCoalescer<PeerProgress>;
    lastPhase: PeerPhase | null;
  };
}
interface Request {
  requestId: string;
  candidate: SubCandidate;
  done: boolean;
  entries: number;
  cancel: () => void;
}
interface Intent {
  intentId: string;
  text: string;
  repos: string[];
  state: "open" | "no_match" | "planned";
  items: ItemStatus[];
  waiting: Set<string>;
  candidates: SubCandidate[];
  requests: Request[];
  routing: boolean;
  cancel: () => void;
  resolve: (value: { intentId: string }) => void;
  reject: (error: Error) => void;
}
interface ActiveCode {
  code: string;
  expiresAt: number;
  expiresAtMs: number;
}

export async function startMaster(o: MasterOptions): Promise<MasterHandle> {
  const master = new SessionMaster(o);
  try {
    await master.start();
    return master;
  } catch (error) {
    await master.close();
    throw error;
  }
}

class SessionMaster implements MasterHandle {
  readonly sessionId: string;
  readonly closed: Promise<void>;
  private resolveClosed: () => void = () => {};
  private boundAddress: { host: string; port: number } | null = null;
  private server: Server | null = null;
  private stopped = false;
  private code: ActiveCode | null = null;
  private cancelCode: () => void = () => {};
  private readonly clock;
  private readonly random;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly datalistMs: number;
  private readonly progressMs: number;
  private readonly wires = new Set<SessionWire>();
  private readonly unauthenticated = new Set<SessionWire>();
  private readonly peers = new Map<string, Peer>();
  private readonly intents: Intent[] = [];
  private readonly timers = new Set<AbortController>();
  private peerSeq = 0;
  private intentSeq = 0;
  private requestSeq = 0;
  private itemSeq = 1;

  constructor(private readonly options: MasterOptions) {
    DeviceSchema.parse(options.device);
    RepoRefSchema.parse(options.repo);
    TokenSchema.parse(options.controlToken);
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? cryptoRandom;
    this.heartbeatMs = positiveDuration(options.heartbeatMs, 10_000);
    this.ttlMs = positiveDuration(options.joinCodeTtlMs, 600_000);
    this.datalistMs = positiveDuration(options.datalistTimeoutMs, 30_000);
    this.progressMs = progressInterval(options.progressIntervalMs);
    this.sessionId = `session-${Buffer.from(this.random.bytes(16)).toString("hex")}`;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get address(): { host: string; port: number } | null {
    return this.boundAddress ? { ...this.boundAddress } : null;
  }

  async start(): Promise<void> {
    if (this.options.listen) {
      const { host, port } = this.options.listen;
      if (!host || isUnspecified(host) || !Number.isInteger(port) || port < 0 || port > 65535) {
        throw new ListenAddressError(
          "Listen on a specific host address and a valid TCP port, not 0.0.0.0 or ::",
        );
      }
      const server = createServer((socket) => {
        const address = socket.remoteAddress;
        const family = socket.remoteFamily;
        if (!address || (family !== "IPv4" && family !== "IPv6")) {
          socket.destroy();
          return;
        }
        this.attach(socket, { address, family });
      });
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        const failed = (cause: Error) =>
          reject(new ListenAddressError("Unable to bind session listener", { cause }));
        server.once("error", failed);
        server.listen({ host, port }, () => {
          server.off("error", failed);
          resolve();
        });
      });
      const bound = server.address();
      if (!bound || typeof bound === "string" || isUnspecified(bound.address)) {
        throw new ListenAddressError("Session listener must bind a specific network address");
      }
      this.boundAddress = { host: bound.address, port: bound.port };
      server.on("error", () => {
        this.event("error", "Session listener failed");
        void this.close();
      });
    }
    this.rotateCode();
  }

  status(): SessionStatus {
    this.refreshCode();
    // Parsing also returns a detached JSON snapshot: callers cannot mutate live protocol state.
    return SessionStatusSchema.parse({
      sessionId: this.sessionId,
      listen: this.boundAddress ? formatAddress(this.boundAddress) : "",
      repo: this.options.repo,
      joinCode: this.code?.code ?? null,
      joinCodeExpiresAtMs: this.code?.expiresAtMs ?? null,
      peers: [...this.peers.values()].map((peer) => ({
        peerId: peer.peerId,
        device: peer.device,
        ...peer.path,
        repo: peer.repo,
        head: peer.head,
        role: peer.role,
        progress: deriveProgress(this.allItems(), peer.peerId, peer.progress.reported),
      })),
      intents: this.intents.map(({ intentId, text, state, items }) => ({
        intentId,
        text,
        state,
        items,
      })),
    });
  }

  presence(): { peerId: string; silentMs: number }[] {
    return [...this.peers.values()].map((peer) => ({
      peerId: peer.peerId,
      silentMs: peer.wire.silenceMs(),
    }));
  }

  submitIntent(text: string, repos?: string[]): Promise<{ intentId: string }> {
    if (this.stopped) return Promise.reject(new ChannelError("Master session is closed"));
    const input = IntentInputSchema.parse({ text, ...(repos ? { repos } : {}) });
    return new Promise((resolve, reject) => {
      const intent: Intent = {
        intentId: `intent-${++this.intentSeq}`,
        text: new Redactor().redact(input.text),
        repos: [...new Set(input.repos ?? [this.options.repo])],
        state: "open",
        items: [],
        waiting: new Set(this.peers.keys()),
        candidates: [],
        requests: [],
        routing: false,
        cancel: () => {},
        resolve,
        reject,
      };
      this.intents.push(intent);
      // Capabilities have no specified deadline. Bound them by the datalist timeout so an
      // unresponsive earlier peer cannot keep routing open forever.
      intent.cancel = this.timer(this.datalistMs, () => this.route(intent));
      for (const peer of this.peers.values()) {
        peer.wire.send({ type: "intent", intentId: intent.intentId, text: intent.text });
      }
      if (intent.waiting.size === 0) this.route(intent);
    });
  }

  attach(stream: Duplex, path: PeerPath): void {
    if (this.stopped) {
      stream.destroy();
      return;
    }
    if (!path.address || (path.family !== "IPv4" && path.family !== "IPv6")) {
      stream.destroy();
      throw new ChannelError("Peer path requires an address and IPv4 or IPv6 family");
    }
    let phase: "first" | "confirm" | "approval" | "control" | "session" = "first";
    let peer: Peer | null = null;
    let challenge: { code: ActiveCode; keys: KeyMaterial; device: string } | null = null;
    const wire = new SessionWire(
      stream,
      this.clock,
      (frame) => {
        const value = wire.read(frame);
        if (phase === "first") {
          cancelFirst();
          const parsed = FirstFrameSchema.safeParse(value);
          if (!parsed.success) {
            wire.finish(
              "bad_request",
              controlError("bad_request", "Invalid first session request"),
            );
            return;
          }
          const first = parsed.data;
          if (first.type === "control") {
            phase = "control";
            cancelHandshake();
            if (!this.local(path)) {
              wire.finish(
                "not_local",
                controlError("not_local", "Control requests must originate locally"),
              );
            } else if (
              !timingSafeEqual(
                Buffer.from(first.token, "hex"),
                Buffer.from(this.options.controlToken, "hex"),
              )
            ) {
              wire.finish("bad_token", controlError("bad_token", "Invalid session control token"));
            } else if (first.op === "status") {
              wire.finish("control_complete", {
                type: "control-result",
                ok: true,
                result: this.status(),
              });
            } else {
              void this.submitIntent(first.text, first.repos)
                .then((result) => {
                  if (wire.active)
                    wire.finish("control_complete", { type: "control-result", ok: true, result });
                })
                .catch((error: unknown) => {
                  if (wire.active)
                    wire.finish(
                      "control_error",
                      // NoMatchError text names repos and counts only; other errors stay generic.
                      error instanceof NoMatchError
                        ? controlError("no_match", error.message)
                        : controlError("bad_request", "Unable to route the session intent"),
                    );
                });
            }
            return;
          }
          this.refreshCode();
          if (!this.code) {
            rejectJoin("no_code");
            return;
          }
          const ephemeral = createEphemeral(this.random);
          const masterNonce = Buffer.from(this.random.bytes(16));
          const keys = deriveKeys({
            privateKey: ephemeral.privateKey,
            remotePub: Buffer.from(first.pub, "base64"),
            subPub: Buffer.from(first.pub, "base64"),
            subNonce: Buffer.from(first.nonce, "base64"),
            masterPub: ephemeral.pub,
            masterNonce,
            device: first.device,
            code: this.code.code,
          });
          challenge = { code: this.code, keys, device: first.device };
          phase = "confirm";
          wire.send({
            type: "join-challenge",
            v: 1,
            pub: ephemeral.pub.toString("base64"),
            nonce: masterNonce.toString("base64"),
          });
        } else if (phase === "confirm") {
          const message = HandshakeMsgSchema.parse(value);
          if (message.type !== "join-confirm" || !challenge)
            throw new ChannelError("Expected join-confirm");
          this.refreshCode();
          if (
            this.code !== challenge.code ||
            this.clock.monotonicMs() >= challenge.code.expiresAt
          ) {
            rejectJoin("expired");
            return;
          }
          if (
            !timingSafeEqual(
              Buffer.from(message.mac, "base64"),
              confirmation(challenge.keys, "sub"),
            )
          ) {
            this.rotateCode();
            rejectJoin("bad_code");
            return;
          }
          // Consume before awaiting human approval. Parallel challenges for this code expire,
          // including when the human declines; a proved code is never reusable.
          this.rotateCode();
          phase = "approval";
          const { keys, device } = challenge;
          const fp = fingerprint(keys.th);
          this.event("fingerprint", `${device}: ${fp}`);
          void Promise.resolve()
            .then(() => this.options.acceptJoin({ device, fingerprint: fp, ...path }))
            .then((accepted) => {
              if (!wire.active) return;
              if (!accepted) {
                rejectJoin("declined");
                return;
              }
              wire.send({
                type: "join-accept",
                mac: confirmation(keys, "master").toString("base64"),
              });
              wire.channel = new SecureChannel(keys.kM2S, keys.kS2M);
              phase = "session";
              cancelHandshake();
              this.unauthenticated.delete(wire);
              const joinedOrder = ++this.peerSeq;
              const joined: Peer = {
                peerId: `peer-${joinedOrder}`,
                device,
                path: { ...path },
                joinedOrder,
                wire,
                repo: null,
                head: null,
                role: null,
                progress: {
                  optIn: false,
                  reported: null,
                  lastPhase: null,
                  coalescer: new ProgressCoalescer<PeerProgress>({
                    intervalMs: this.progressMs,
                    monotonicMs: () => this.clock.monotonicMs(),
                    schedule: (ms, fn) => this.timer(ms, fn),
                    send: (value) => this.relay(joined, value),
                  }),
                },
              };
              peer = joined;
              this.peers.set(peer.peerId, peer);
              wire.send({ type: "welcome", sessionId: this.sessionId, peerId: peer.peerId });
              wire.startHeartbeat(this.heartbeatMs);
              this.event("joined", `Peer ${peer.peerId} joined`);
              this.progressChanged(peer);
            })
            .catch(() => {
              this.event("error", "Join approval failed");
              if (wire.active) rejectJoin("declined");
            });
        } else if (phase === "session" && peer) {
          const message = SessionMsgSchema.parse(value);
          this.receive(peer, message);
          if (wire.active) wire.received();
        } else {
          throw new ChannelError("Unexpected frame while a request is pending");
        }
      },
      (reason) => {
        this.wires.delete(wire);
        this.unauthenticated.delete(wire);
        if (peer) {
          this.dropPeer(peer);
          this.event("left", `Peer ${peer.peerId} (${peer.device}) left: ${reason}`);
        } else if (phase !== "control") {
          // A finished control request is routine; a join that never completed is not.
          const who = challenge === null ? path.address : `${challenge.device} (${path.address})`;
          this.event("join-failed", `Join from ${who} ended: ${reason}`);
        }
      },
    );
    const rejectJoin = (reason: JoinRejectReason) =>
      wire.finish(reason, { type: "join-reject", reason });
    this.wires.add(wire);
    if (this.unauthenticated.size >= 8) {
      rejectJoin("busy");
      return;
    }
    this.unauthenticated.add(wire);
    const cancelFirst = wire.timer(5000, () => wire.destroy("first_frame_timeout"));
    const cancelHandshake = wire.timer(15_000, () => rejectJoin("expired"));
  }

  private receive(peer: Peer, message: SessionMsg): void {
    if (message.type === "heartbeat") return;
    if (message.type === "bye") {
      peer.wire.finish(message.reason);
      return;
    }
    if (message.type === "capability") {
      const intent = this.intents.find((entry) => entry.intentId === message.intentId);
      // Late replies to a bounded collection are ignored; unsolicited/duplicate replies fail.
      if (intent?.routing) return;
      if (!intent?.waiting.delete(peer.peerId)) throw new ChannelError("Unexpected capability");
      peer.repo = message.repo;
      peer.head = message.head;
      peer.role = message.role;
      this.progressChanged(peer);
      intent.candidates.push({
        peerId: peer.peerId,
        repo: message.repo,
        joinedOrder: peer.joinedOrder,
      });
      if (intent.waiting.size === 0) this.route(intent);
    } else if (message.type === "datalist") {
      const intent = this.intents.find((entry) => entry.intentId === message.intentId);
      const request = intent?.requests.find((entry) => entry.requestId === message.requestId);
      if (!intent || !request || request.candidate.peerId !== peer.peerId)
        throw new ChannelError("Unexpected datalist");
      if (request.done) return;
      // Re-redact independently of the sub (ARCHITECTURE §16). Only counts enter a plan.
      const redactor = new Redactor();
      const entries = message.entries.map((entry) => ({
        ...entry,
        path: findSecrets(entry.path).length ? redactor.redact(entry.path) : entry.path,
        ...(entry.detail === undefined
          ? {}
          : {
              detail: findSecrets(entry.detail).length
                ? redactor.redact(entry.detail)
                : entry.detail,
            }),
      }));
      request.entries = entries.length;
      request.done = true;
      request.cancel();
      this.plan(intent);
    } else if (message.type === "claim" || message.type === "result") {
      const intent = this.intents.find((entry) =>
        entry.items.some((item) => item.itemId === message.itemId),
      );
      const change =
        message.type === "claim"
          ? applyClaim(intent?.items ?? [], peer.peerId, message)
          : applyResult(intent?.items ?? [], peer.peerId, {
              ...message,
              summary: new Redactor().redact(message.summary),
            });
      if (intent) intent.items = change.items;
      peer.wire.send(change.reply);
      this.event(change.reply.type, message.itemId);
      // Only the sender can be the assignee of an accepted claim or result.
      this.progressChanged(peer);
    } else if (message.type === "progress") {
      this.receiveProgress(peer, message);
    } else {
      throw new ChannelError("Message is not allowed from a sub");
    }
  }

  private route(intent: Intent): void {
    if (this.stopped || intent.routing) return;
    intent.routing = true;
    intent.cancel();
    const candidates = intent.candidates.filter((candidate) => this.peers.has(candidate.peerId));
    for (const repo of intent.repos) {
      const candidate = matchSub(repo, candidates);
      if (candidate)
        intent.requests.push({
          requestId: `request-${++this.requestSeq}`,
          candidate,
          done: false,
          entries: 0,
          cancel: () => {},
        });
    }
    if (!intent.requests.length) {
      intent.state = "no_match";
      intent.reject(new NoMatchError(intent.repos, this.peers.size));
      return;
    }
    for (const request of intent.requests) {
      request.cancel = this.timer(this.datalistMs, () => {
        request.done = true;
        this.plan(intent);
      });
      this.peers.get(request.candidate.peerId)?.wire.send({
        type: "datalist-request",
        intentId: intent.intentId,
        requestId: request.requestId,
      });
    }
    intent.resolve({ intentId: intent.intentId });
  }

  private plan(intent: Intent): void {
    if (
      this.stopped ||
      intent.state !== "open" ||
      !intent.routing ||
      intent.requests.some((request) => !request.done)
    )
      return;
    const items = buildPlan(
      intent,
      this.options.repo,
      intent.requests.map((request) => request.candidate),
      {
        firstItemNumber: this.itemSeq,
        datalistCounts: Object.fromEntries(
          intent.requests.map((request) => [request.candidate.repo, request.entries]),
        ),
      },
    );
    this.itemSeq += items.length;
    intent.items = items.map((item) => ({
      ...item,
      state: this.peers.has(item.assignee) ? "planned" : "failed",
    }));
    intent.state = "planned";
    for (const assignee of new Set(items.map((item) => item.assignee))) {
      this.peers.get(assignee)?.wire.send({
        type: "plan",
        planId: `plan-${intent.intentId}`,
        intentId: intent.intentId,
        epoch: 1,
        items,
      });
    }
    this.event("planned", intent.intentId);
    for (const assignee of new Set(items.map((item) => item.assignee))) {
      const peer = this.peers.get(assignee);
      if (peer) this.progressChanged(peer);
    }
  }

  private receiveProgress(peer: Peer, message: ProgressMsg): void {
    if (
      message.peerId !== undefined ||
      message.device !== undefined ||
      message.role !== undefined ||
      message.phase === "left"
    )
      throw new ChannelError("Progress from a sub must not name a peer");
    // Counts and percent are informational: the master derives them from its own item state.
    const reported: ReportedProgress = {
      phase: message.phase,
      summary: message.summary,
      ...(message.itemId === undefined ? {} : { itemId: message.itemId }),
    };
    const state = peer.progress;
    if (!state.optIn) {
      state.optIn = true;
      // The first frame is the opt-in: answer with everyone else's current strip, uncoalesced.
      for (const other of this.peers.values()) {
        if (other !== peer) peer.wire.send(progressFrame(this.effectiveProgress(other)));
      }
    } else if (
      state.reported &&
      state.reported.phase === reported.phase &&
      state.reported.summary === reported.summary &&
      state.reported.itemId === reported.itemId
    ) {
      return;
    }
    state.reported = reported;
    this.progressChanged(peer);
  }

  private effectiveProgress(peer: Peer): PeerProgress {
    return {
      // Identity comes from the authenticated wire and the handshake, never from a frame.
      peerId: peer.peerId,
      device: peer.device,
      role: peer.role,
      ...deriveProgress(this.allItems(), peer.peerId, peer.progress.reported),
    };
  }

  private progressChanged(peer: Peer): void {
    if (this.stopped || this.peers.get(peer.peerId) !== peer) return;
    const value = this.effectiveProgress(peer);
    if (value.phase !== "left" && value.phase !== peer.progress.lastPhase) {
      peer.progress.lastPhase = value.phase;
      this.event("progress", peer.peerId);
    }
    peer.progress.coalescer.push(value);
  }

  /** Fan out a strip about `subject` to every opted-in peer except the subject (no echo). */
  private relay(subject: Peer, value: PeerProgress): void {
    const frame = progressFrame(value);
    for (const other of this.peers.values()) {
      if (other !== subject && other.progress.optIn && other.wire.active) other.wire.send(frame);
    }
  }

  private allItems(): ItemStatus[] {
    return this.intents.flatMap((intent) => intent.items);
  }

  private dropPeer(peer: Peer): void {
    this.peers.delete(peer.peerId);
    peer.progress.coalescer.cancel();
    if (!this.stopped) {
      // Immediate, not coalesced: the row must disappear, whatever was pending for it.
      this.relay(peer, {
        peerId: peer.peerId,
        device: peer.device,
        role: peer.role,
        phase: "left",
        done: 0,
        total: 0,
        failed: 0,
        percent: 0,
        summary: "",
      });
    }
    for (const intent of this.intents) {
      intent.items = intent.items.map((item) =>
        item.assignee === peer.peerId && (item.state === "claimed" || item.state === "planned")
          ? { ...item, state: "failed" }
          : item,
      );
      if (!intent.routing && intent.waiting.delete(peer.peerId) && intent.waiting.size === 0)
        this.route(intent);
      for (const request of intent.requests) {
        if (request.candidate.peerId === peer.peerId && !request.done) {
          request.done = true;
          request.cancel();
        }
      }
      if (intent.requests.length) this.plan(intent);
    }
    // The dropped peer's items failed; anyone else whose plan just landed is already covered by
    // plan(), and the coalescers drop unchanged values.
    for (const other of this.peers.values()) this.progressChanged(other);
  }

  private local(path: PeerPath): boolean {
    const address = canonicalAddress(path.address);
    return (
      address === "::1" ||
      (isIP(address) === 4 && address.startsWith("127.")) ||
      (this.boundAddress !== null && address === canonicalAddress(this.boundAddress.host))
    );
  }

  private refreshCode(): void {
    if (this.code && this.clock.monotonicMs() >= this.code.expiresAt) this.rotateCode();
  }

  private rotateCode(): void {
    if (this.stopped) return;
    this.cancelCode();
    this.code = {
      code: generateJoinCode(this.random),
      expiresAt: this.clock.monotonicMs() + this.ttlMs,
      expiresAtMs: this.clock.nowMs() + this.ttlMs,
    };
    this.cancelCode = this.timer(this.ttlMs, () => this.rotateCode());
    this.options.onJoinCode({ code: this.code.code, expiresAtMs: this.code.expiresAtMs });
  }

  private timer(ms: number, fn: () => void): () => void {
    const controller = new AbortController();
    this.timers.add(controller);
    void this.clock
      .sleep(ms, controller.signal)
      .then(() => {
        this.timers.delete(controller);
        if (!this.stopped && !controller.signal.aborted) fn();
      })
      .catch(() => {
        this.timers.delete(controller);
        if (!controller.signal.aborted) {
          this.event("error", "Session timer failed");
          void this.close();
        }
      });
    return () => {
      controller.abort();
      this.timers.delete(controller);
    };
  }

  private event(kind: string, message: string): void {
    this.options.onEvent?.({ kind, message });
  }

  async close(): Promise<void> {
    if (this.stopped) return this.closed;
    this.stopped = true;
    this.code = null;
    for (const peer of this.peers.values()) peer.progress.coalescer.cancel();
    for (const timer of this.timers) timer.abort();
    this.timers.clear();
    for (const intent of this.intents)
      intent.reject(new ChannelError("Master session closed before routing completed"));
    for (const wire of this.wires)
      wire.finish(
        "master_closed",
        wire.channel ? { type: "bye", reason: "master_closed" } : undefined,
      );
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.resolveClosed();
  }
}

function progressFrame(value: PeerProgress): ProgressMsg {
  // Parse on the way out: a derivation bug must fail here, not disconnect the receiving sub.
  return ProgressMsgSchema.parse({ type: "progress", ...value });
}

function controlError(
  code: "bad_token" | "bad_request" | "no_match" | "not_local",
  message: string,
): ControlResult {
  return { type: "control-result", ok: false, error: { code, message } };
}

function canonicalAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1] ?? "", 16);
  const low = Number.parseInt(mapped[2] ?? "", 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isUnspecified(host: string): boolean {
  const address = canonicalAddress(host);
  return address === "0.0.0.0" || address === "::";
}

function formatAddress(address: { host: string; port: number }): string {
  return `${isIP(address.host) === 6 ? `[${address.host}]` : address.host}:${address.port}`;
}
