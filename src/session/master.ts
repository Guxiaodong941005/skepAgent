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
import type { MasterEvent, MasterHandle, MasterOptions } from "./index.js";
import {
  type ControlResult,
  DeviceSchema,
  FirstFrameSchema,
  HandshakeMsgSchema,
  IntentInputSchema,
  type ItemStatus,
  type JoinRejectReason,
  type OutputMsg,
  type PeerInfoMsg,
  type ProgressMsg,
  ProgressMsgSchema,
  ProgressMsgV2Schema,
  type ProtocolVersion,
  type SessionMsg,
  type SessionStatus,
  SessionStatusSchema,
  sessionSchema,
  TokenSchema,
  VersionSchema,
  v1Status,
} from "./messages.js";
import { outputFrame } from "./output.js";
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

/** An accepted result's summary in operator scrollback: enough to read, never the full 4000. */
export const SCROLLBACK_SUMMARY_LINES = 8;
export const SCROLLBACK_SUMMARY_CHARS = 600;

/**
 * The first {@link SCROLLBACK_SUMMARY_LINES} non-empty lines of an (already redacted) summary,
 * at most {@link SCROLLBACK_SUMMARY_CHARS} characters, marked when anything was cut. A failed
 * item's summary is never cut: its cause and the agent's last words are what the operator needs
 * (SESSION-UX §3.4); the wire already bounds it to 4000 characters.
 */
export function scrollbackSummary(summary: string, opts: { failed?: boolean } = {}): string {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return "(no summary)";
  if (opts.failed === true) return lines.join("\n");
  let text = lines.slice(0, SCROLLBACK_SUMMARY_LINES).join("\n");
  let cut = lines.length > SCROLLBACK_SUMMARY_LINES;
  if (text.length > SCROLLBACK_SUMMARY_CHARS) {
    text = text.slice(0, SCROLLBACK_SUMMARY_CHARS).trimEnd();
    cut = true;
  }
  return cut ? `${text} …` : text;
}

/** The item fields a roll-up reads; also satisfied by the CLI's parsed status. */
export interface ItemOutcome {
  state: string;
  result?:
    | {
        checks: readonly { status: string }[];
        summary: string;
        submit?: { state: string } | undefined;
      }
    | undefined;
}

/** A finished item counts as failed: dropped assignee, or a failing check (also the agent's). */
export function itemFailed(item: ItemOutcome): boolean {
  return item.state === "failed" || (item.result?.checks.some((c) => c.status === "fail") ?? false);
}

const PEER_STATUS_RE = /^(done|FAILED|blocked|declined|skipped|DRY RUN) · (.+)$/;

/**
 * How an item ended, as the operator must read it (SESSION-UX §2.3, R6). A result is not success
 * just because it was accepted: the agent may have failed, the submit may have failed after the
 * agent succeeded, the agent may still be waiting for a human in its pane (submit `pending`), or
 * nothing ran because the peer declined or skipped it.
 */
export type ItemVerdict = "done" | "failed" | "submit-failed" | "pending" | "declined" | "running";

export function itemVerdict(item: ItemOutcome): ItemVerdict {
  if (itemFailed(item)) return "failed";
  if (item.state !== "done" || item.result === undefined) return "running";
  const submit = item.result.submit?.state;
  if (submit === "failed") return "submit-failed";
  if (submit === "pending") return "pending";
  const lines = item.result.summary.split(/\r?\n/).filter((line) => line.trim() !== "");
  const status = PEER_STATUS_RE.exec(
    (lines[0]?.startsWith("submit ") === true ? lines[1] : lines[0]) ?? "",
  );
  if (status?.[1] === "declined" || status?.[1] === "skipped") return "declined";
  return "done";
}

/** Verdicts whose whole summary is shown: the cause of a failure is usually the long part. */
const UNCAPPED: ReadonlySet<ItemVerdict> = new Set(["failed", "submit-failed"]);

/**
 * One finished item as the operator reads it (SESSION-UX §2.3):
 * `I-1 done · mac (app) · claude · 2m 14s` then the indented summary lines. The peer's leading
 * `submit …` line moves to the end; its status line is folded into the headline. Older peers
 * without a status line still render, just with fewer fields. `full` (used by `/status`) never
 * applies the event cap of a successful item.
 */
export function itemBlock(
  itemId: string,
  where: { device: string; repo: string },
  summary: string,
  verdict: ItemVerdict,
  opts: { full?: boolean } = {},
): string {
  const lines = scrollbackSummary(summary, {
    failed: opts.full === true || UNCAPPED.has(verdict),
  }).split("\n");
  const submit = lines[0]?.startsWith("submit ") === true ? lines.shift() : undefined;
  const status = PEER_STATUS_RE.exec(lines[0] ?? "");
  if (status !== null) lines.shift();
  const word =
    verdict === "failed"
      ? "FAILED"
      : verdict === "submit-failed"
        ? "SUBMIT FAILED"
        : verdict === "pending"
          ? "WAITING"
          : (status?.[1] ?? "done");
  const tail = status?.[2] === undefined ? "" : ` · ${status[2]}`;
  const body = [...lines, ...(submit === undefined ? [] : [submit])].filter(
    (line) => line !== "(no summary)",
  );
  return [
    `${itemId} ${word} · ${where.device} (${where.repo})${tail}`,
    ...body.map((l) => `  ${l}`),
  ].join("\n");
}

/**
 * `2 done · 1 failed · 4 files changed` over an intent's items. Failed submits, agents waiting for
 * a human and declined items are counted apart, never as done (R6).
 */
export function intentRollup(items: readonly ItemOutcome[]): string {
  const count: Record<ItemVerdict, number> = {
    done: 0,
    failed: 0,
    "submit-failed": 0,
    pending: 0,
    declined: 0,
    running: 0,
  };
  let files = 0;
  for (const item of items) {
    const verdict = itemVerdict(item);
    count[verdict] += 1;
    if (verdict === "running") continue;
    files += Number(/^changed (\d+) files?\b/m.exec(item.result?.summary ?? "")?.[1] ?? 0);
  }
  const optional = (n: number, label: string): string[] => (n === 0 ? [] : [`${n} ${label}`]);
  return [
    `${count.done} done`,
    `${count.failed} failed`,
    ...optional(count["submit-failed"], "submit failed"),
    ...optional(count.pending, "waiting for you"),
    ...optional(count.declined, "declined"),
    ...optional(count.running, "running"),
    `${files} ${files === 1 ? "file" : "files"} changed`,
  ].join(" · ");
}

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

/** v1 peers (≤0.1.13) accept at most this much intent text (plan §3.6). */
const V1_TEXT_MAX = 4000;
/**
 * Live output a peer may send in a burst before frames are dropped: senders keep one frame per
 * 500 ms (locked plan §9.10), but TCP may deliver a stalled run of them at once.
 */
const OUTPUT_BURST = 8;
const OUTPUT_REFILL_MS = 500;

/** The intent text a peer of `protocol` can parse: v1 gets the head, marked when cut. */
export function wireText(text: string, protocol: ProtocolVersion): string {
  if (protocol === 2 || text.length <= V1_TEXT_MAX) return text;
  return `${text.slice(0, V1_TEXT_MAX - 1)}…`;
}

interface Peer {
  peerId: string;
  device: string;
  path: PeerPath;
  protocol: ProtocolVersion;
  /** From v2 `peer-info`; null until it arrives and on v1. */
  version: string | null;
  /** The peer's human opted in to live output (v2 only, D35). */
  shareOutput: boolean;
  output: { tokens: number; atMs: number };
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
  /** The caller named the repos; an unmatched explicit repo is never rerouted. */
  explicitRepos: boolean;
  state: "open" | "no_match" | "planned";
  items: ItemStatus[];
  waiting: Set<string>;
  candidates: SubCandidate[];
  requests: Request[];
  routing: boolean;
  /** The final roll-up was emitted; it is said once per intent. */
  finished?: boolean;
  cancel: () => void;
  resolve: (value: { intentId: string }) => void;
  reject: (error: Error) => void;
}
interface ActiveCode {
  code: string;
  expiresAt: number;
  expiresAtMs: number;
  /** Wrong join-confirm MACs proved against this code so far (see {@link MAX_CODE_MISSES}). */
  misses: number;
}

/**
 * Wrong tries one join code absorbs before it rotates. A guess is an online try at 1 in 10^12
 * (12 digits), and 8 of them against one code change that by nothing measurable; rotating on
 * every miss instead let one stale or mistyped paste cancel the other joins in flight (Phase 3
 * exit run, bug 3). A proved code still rotates at once: it admits one device.
 */
export const MAX_CODE_MISSES = 8;

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
  private readonly version: string;
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
    this.version = VersionSchema.parse(options.version ?? "unknown");
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
        protocol: peer.protocol,
        version: peer.version,
        shareOutput: peer.shareOutput,
        progress: deriveProgress(this.allItems(), peer.peerId, peer.progress.reported),
      })),
      intents: this.intents.map(({ intentId, text, state, items }) => ({
        intentId,
        // The control status keeps the v1 limit, so an older local client still parses it.
        text: wireText(text, 1),
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
        explicitRepos: input.repos !== undefined,
        state: "open",
        items: [],
        waiting: new Set(this.recipients(input.repos)),
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
        if (!intent.waiting.has(peer.peerId)) continue;
        peer.wire.send({
          type: "intent",
          intentId: intent.intentId,
          text: wireText(intent.text, peer.protocol),
        });
      }
      if (intent.waiting.size === 0) this.route(intent);
    });
  }

  /**
   * Who receives an intent (ORCH-6): with named repos, only peers whose described repo is one of
   * them or that have not described one yet; a bare intent still reaches everyone, because the
   * lone-peer fallback may route it to any repo (INTENT-PEER).
   */
  private recipients(repos: readonly string[] | undefined): string[] {
    return [...this.peers.values()]
      .filter((peer) => repos === undefined || peer.repo === null || repos.includes(peer.repo))
      .map((peer) => peer.peerId);
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
    let challenge: {
      code: ActiveCode;
      keys: KeyMaterial;
      device: string;
      protocol: ProtocolVersion;
    } | null = null;
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
              const status = this.status();
              wire.finish("control_complete", {
                type: "control-result",
                ok: true,
                // An older local client parses the status strictly (ORCH-6).
                result: first.v === 1 ? v1Status(status) : status,
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
            protocol: first.v,
          });
          challenge = { code: this.code, keys, device: first.device, protocol: first.v };
          phase = "confirm";
          // Answer in the version asked for: a v1 sub parses only `v:1` (plan §3.6).
          wire.send({
            type: "join-challenge",
            v: first.v,
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
            // Count the miss instead of rotating: other joins on this code keep going. The code
            // is burned only once it has absorbed MAX_CODE_MISSES wrong tries.
            challenge.code.misses += 1;
            if (challenge.code.misses >= MAX_CODE_MISSES) this.rotateCode();
            rejectJoin("bad_code");
            return;
          }
          // Consume before awaiting human approval. Parallel challenges for this code expire,
          // including when the human declines; a proved code is never reusable.
          this.rotateCode();
          phase = "approval";
          const { keys, device, protocol } = challenge;
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
                protocol,
                version: null,
                shareOutput: false,
                output: { tokens: OUTPUT_BURST, atMs: this.clock.monotonicMs() },
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
              wire.send(
                protocol === 2
                  ? {
                      type: "welcome",
                      sessionId: this.sessionId,
                      peerId: peer.peerId,
                      version: this.version,
                    }
                  : { type: "welcome", sessionId: this.sessionId, peerId: peer.peerId },
              );
              wire.startHeartbeat(this.heartbeatMs);
              this.event("joined", `Peer ${peer.peerId} joined`);
              this.progressChanged(peer);
            })
            .catch(() => {
              this.event("error", "Join approval failed");
              if (wire.active) rejectJoin("declined");
            });
        } else if (phase === "session" && peer) {
          const message: SessionMsg = sessionSchema(peer.protocol).parse(value);
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
      if (change.reply.type === "result-ack" && message.type === "result") {
        // The operator reads the peer agent's outcome here instead of on the peer's machine.
        const stored = change.items.find((item) => item.itemId === message.itemId);
        const verdict = stored === undefined ? "done" : itemVerdict(stored);
        const where = { device: peer.device, repo: message.repo };
        const summary = stored?.result?.summary ?? "";
        this.event(
          verdict === "failed" || verdict === "submit-failed"
            ? "item-failed"
            : verdict === "pending"
              ? "item-pending"
              : "item-result",
          itemBlock(message.itemId, where, summary, verdict),
          // A scrolling shell shows the whole received summary (S2); still ≤4000 and redacted.
          itemBlock(message.itemId, where, summary, verdict, { full: true }),
        );
        if (intent) this.intentFinished(intent);
      } else if (change.reply.type === "result-reject") {
        this.event("result-reject", `${message.itemId}: ${change.reply.reason}`);
      } else {
        this.event(change.reply.type, message.itemId);
      }
      // Only the sender can be the assignee of an accepted claim or result.
      this.progressChanged(peer);
    } else if (message.type === "progress") {
      this.receiveProgress(peer, message);
    } else if (message.type === "peer-info") {
      this.receivePeerInfo(peer, message);
    } else if (message.type === "output") {
      this.receiveOutput(peer, message);
    } else {
      throw new ChannelError("Message is not allowed from a sub");
    }
  }

  private receivePeerInfo(peer: Peer, info: PeerInfoMsg): void {
    const { version, shareOutput: share, repo, role } = info;
    peer.version = version;
    // The join's own label until an intent's `capability` describes the peer (that one wins).
    if ((repo !== undefined && repo !== peer.repo) || (role !== undefined && role !== peer.role)) {
      peer.repo = repo ?? peer.repo;
      peer.role = role ?? peer.role;
      this.event("progress", peer.peerId);
      this.progressChanged(peer);
    }
    if (share === peer.shareOutput) return;
    peer.shareOutput = share;
    // The master's human sees who opted in: live output is a choice on the other device (D35).
    this.event(
      "share-output",
      share
        ? `Peer ${peer.peerId} (${peer.device}) shares its live agent output`
        : `Peer ${peer.peerId} (${peer.device}) stopped sharing its live agent output`,
      undefined,
      { peerId: peer.peerId },
    );
  }

  private receiveOutput(peer: Peer, message: OutputMsg): void {
    // Sharing is the sub's human's choice; a frame without it is a protocol violation.
    if (!peer.shareOutput) throw new ChannelError("Live output was not opted in");
    const item = this.allItems().find((entry) => entry.itemId === message.itemId);
    if (item?.assignee !== peer.peerId) throw new ChannelError("Live output for a foreign item");
    const budget = peer.output;
    const now = this.clock.monotonicMs();
    budget.tokens = Math.min(
      OUTPUT_BURST,
      budget.tokens + Math.floor((now - budget.atMs) / OUTPUT_REFILL_MS),
    );
    budget.atMs = now - ((now - budget.atMs) % OUTPUT_REFILL_MS);
    if (budget.tokens === 0) return;
    budget.tokens -= 1;
    // Clean and redact again on this side, independently of the sub (ARCHITECTURE §16).
    const frame = outputFrame(message.lines, message.skipped);
    if (frame.lines.length === 0) return;
    const skipped = frame.skipped === 0 ? [] : [`… ${frame.skipped} line(s) not shown`];
    this.event("peer-output", [...skipped, ...frame.lines].join("\n"), undefined, {
      peerId: peer.peerId,
      itemId: message.itemId,
    });
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
    // A bare intent defaults to the master's repo, but a lone peer working on another repo is
    // still the only possible assignee, so route the work to that peer's repo (INTENT-PEER).
    const sole = candidates[0];
    if (!intent.requests.length && !intent.explicitRepos && candidates.length === 1 && sole) {
      intent.requests.push({
        requestId: `request-${++this.requestSeq}`,
        candidate: sole,
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
    // Plan the repos that were actually routed, which may differ from the requested ones after
    // the lone-peer fallback.
    const items = buildPlan(
      { text: intent.text, repos: intent.requests.map((request) => request.candidate.repo) },
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
      message.repo !== undefined ||
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
        if (other !== peer)
          peer.wire.send(progressFrame(this.effectiveProgress(other), peer.protocol));
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
      ...(peer.repo === null ? {} : { repo: peer.repo }),
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
    for (const other of this.peers.values()) {
      if (other !== subject && other.progress.optIn && other.wire.active)
        other.wire.send(progressFrame(value, other.protocol));
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
      this.intentFinished(intent);
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
      misses: 0,
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

  /**
   * Once every item of a planned intent settled, one roll-up across its peers:
   * `intent-1 done: <text>` then `2 done · 0 failed · 4 files changed` (SESSION-UX Phase 2).
   * Only an all-successful intent is `intent-done`. A failed agent or submit makes it
   * `intent-failed`; an agent still waiting for a human makes it `intent-waiting`, never a final
   * success: its edits are not finished (R6).
   */
  private intentFinished(intent: Intent): void {
    if (intent.finished === true || intent.state !== "planned" || intent.items.length === 0) return;
    const verdicts = intent.items.map(itemVerdict);
    if (verdicts.includes("running")) return;
    intent.finished = true;
    const rollup = intentRollup(intent.items);
    if (verdicts.some((v) => v === "failed" || v === "submit-failed")) {
      this.event("intent-failed", `${intent.intentId} failed: ${intent.text}\n  ${rollup}`);
    } else if (verdicts.includes("pending")) {
      this.event(
        "intent-waiting",
        `${intent.intentId} waiting for you: ${intent.text}\n  ${rollup}\n` +
          "  an agent is blocked in its pane on the peer; answer it there",
      );
    } else {
      this.event("intent-done", `${intent.intentId} done: ${intent.text}\n  ${rollup}`);
    }
  }

  private event(
    kind: string,
    message: string,
    full?: string,
    about?: Pick<MasterEvent, "peerId" | "itemId">,
  ): void {
    this.options.onEvent?.({
      kind,
      message,
      ...(full === undefined ? {} : { full }),
      ...about,
    });
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

function progressFrame(value: PeerProgress, protocol: ProtocolVersion): ProgressMsg {
  // Parse on the way out: a derivation bug must fail here, not disconnect the receiving sub.
  if (protocol === 2) return ProgressMsgV2Schema.parse({ type: "progress", ...value });
  // Published v1 peers reject unknown keys, including repo (ARCHITECTURE D35).
  const { repo: _repo, ...v1 } = value;
  return ProgressMsgSchema.parse({ type: "progress", ...v1 });
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
