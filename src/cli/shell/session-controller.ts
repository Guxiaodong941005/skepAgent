/**
 * The shell's single source of session truth (docs/plans/tui-session-reliability.md §2).
 *
 * The header, the bee footer, slash gating, `/status` and the intent gate all read
 * {@link SessionController.snapshot}; nothing else in the shell keeps session state. Peers come
 * only from a flow the shell currently owns (or, for a master in another process, from its live
 * control `status`), so a flow that ended can never leave rows behind.
 */

import type { ControlEndpoint, JoinFlow, MasterFlow, SessionStatus } from "../commands/session.js";
import { formatJoinCode } from "../commands/session.js";
import type { ShellPeer } from "./model.js";

export type SessionMode = "none" | "joining" | "master" | "joined" | "external";

export interface SessionView {
  mode: SessionMode;
  live: boolean;
  /** Header text: `no session`, `master · code …`, `joined … as peer-2 · coding`, … */
  label: string;
  master: { listen: string; repo: string; joinCode: string | null; external: boolean } | null;
  join: { target: string; role: string; peerId: string } | null;
  peers: ShellPeer[];
  /** A joined shell: milliseconds since the master was last heard from. */
  linkSilentMs: number | null;
}

export type IntentRoute =
  | { kind: "own"; master: MasterFlow }
  | { kind: "control"; external: ExternalMaster }
  | { kind: "refused"; message: string };

/**
 * A master in another process on this device: the endpoint it was discovered at (its token
 * identifies it) and the status read from exactly that endpoint. Actions go to `endpoint`, never
 * to whatever `session.json` names later.
 */
export interface ExternalMaster {
  endpoint: ControlEndpoint;
  status: SessionStatus;
}

/** Heartbeats are sent every 10 s and a link dies after 30 s of silence (`SessionWire`). */
export const QUIET_AFTER_MS = 20_000;

export class SessionController {
  private master: MasterFlow | null = null;
  private join: JoinFlow | null = null;
  private joining: { generation: number; target: string } | null = null;
  private joinGeneration = 0;
  private generation = 0;
  private roster: ShellPeer[] = [];
  private external: ExternalMaster | null = null;
  /** Only the newest discovery may apply; ownership changes and shutdown invalidate older ones. */
  private probeGeneration = 0;

  get ownMaster(): MasterFlow | null {
    return this.master;
  }

  get ownJoin(): JoinFlow | null {
    return this.join;
  }

  /** True while a join handshake runs or a joined flow is open. */
  get joinBusy(): boolean {
    return this.join !== null || this.joining !== null;
  }

  get externalStatus(): SessionStatus | null {
    return this.external?.status ?? null;
  }

  get externalMaster(): ExternalMaster | null {
    return this.external;
  }

  setMaster(flow: MasterFlow): void {
    this.master = flow;
    this.external = null;
    this.invalidateProbes();
  }

  /** False when `flow` is not the current master (a late close of an older flow). */
  masterEnded(flow: MasterFlow): boolean {
    if (this.master !== flow) return false;
    this.master = null;
    return true;
  }

  /** Starts a join attempt; roster updates must carry the returned generation. */
  beginJoin(target: string): number {
    this.generation += 1;
    this.joining = { generation: this.generation, target };
    this.roster = [];
    this.external = null;
    this.invalidateProbes();
    return this.generation;
  }

  joinStarted(generation: number, flow: JoinFlow): boolean {
    if (this.joining?.generation !== generation) return false;
    this.joining = null;
    this.join = flow;
    this.joinGeneration = generation;
    return true;
  }

  joinFailed(generation: number): void {
    if (this.joining?.generation !== generation) return;
    this.joining = null;
    this.roster = [];
  }

  /**
   * Drops a join still in its handshake; its flow is refused by {@link joinStarted} when it
   * arrives. Returns the dropped target, or null when no join was in flight.
   */
  abortJoin(): string | null {
    const joining = this.joining;
    if (joining === null) return null;
    this.joining = null;
    this.roster = [];
    return joining.target;
  }

  /** False when `flow` is not the current join. */
  joinEnded(flow: JoinFlow): boolean {
    if (this.join !== flow) return false;
    this.join = null;
    this.roster = [];
    return true;
  }

  /** A sub roster update; ignored unless it belongs to the current join attempt or flow. */
  joinRoster(generation: number, peers: ShellPeer[]): boolean {
    const current =
      this.joining?.generation === generation ||
      (this.join !== null && this.joinGeneration === generation);
    if (!current) return false;
    this.roster = peers;
    return true;
  }

  /** Starts a discovery of a master in another process; its result needs this generation. */
  beginProbe(): number {
    this.probeGeneration += 1;
    return this.probeGeneration;
  }

  /** Any discovery in flight is now stale (an own flow started, or the shell is leaving). */
  invalidateProbes(): void {
    this.probeGeneration += 1;
  }

  /** Forgets a master in another process; any discovery in flight no longer applies. */
  clearExternal(): void {
    this.external = null;
    this.invalidateProbes();
  }

  /**
   * Applies a discovery result (null: no live master). Ignored when a newer discovery started
   * or ownership changed since, and while the shell owns a flow: then its own flows are the truth.
   */
  applyProbe(generation: number, found: ExternalMaster | null): boolean {
    if (generation !== this.probeGeneration) return false;
    if (this.master !== null || this.joinBusy) return false;
    this.external = found;
    return true;
  }

  snapshot(): SessionView {
    const join = this.join;
    const joinView =
      join === null ? null : { target: join.target, role: join.role, peerId: join.handle.peerId };
    const linkSilentMs = join?.handle.silenceMs?.() ?? null;
    if (this.master !== null) {
      const status = this.master.handle.status();
      const code = this.master.joinCode ?? "none";
      const label = [
        `master · code ${code} · ${this.master.listen}`,
        ...(joinView === null ? [] : [`joined as ${joinView.peerId}`]),
      ].join(" · ");
      return {
        mode: "master",
        live: true,
        label,
        master: {
          listen: this.master.listen,
          repo: this.master.repo,
          joinCode: this.master.joinCode,
          external: false,
        },
        join: joinView,
        // The master's own status is the truth for who is connected; a sub roster of the same
        // session only adds relays that may lag behind it.
        peers: peersFromStatus(status, this.master.handle.presence?.()),
        linkSilentMs,
      };
    }
    if (joinView !== null) {
      return {
        mode: "joined",
        live: true,
        label: `joined ${joinView.target} as ${joinView.peerId} · ${joinView.role}`,
        master: null,
        join: joinView,
        peers: this.roster,
        linkSilentMs,
      };
    }
    if (this.joining !== null) {
      return {
        mode: "joining",
        live: true,
        label: `joining ${this.joining.target}…`,
        master: null,
        join: null,
        peers: this.roster,
        linkSilentMs: null,
      };
    }
    if (this.external !== null) {
      const status = this.external.status;
      const code = status.joinCode === null ? "none" : formatJoinCode(status.joinCode);
      return {
        mode: "external",
        live: true,
        label: `master (other process) · code ${code} · ${status.listen}`,
        master: { listen: status.listen, repo: status.repo, joinCode: code, external: true },
        join: null,
        peers: peersFromStatus(status),
        linkSilentMs: null,
      };
    }
    return {
      mode: "none",
      live: false,
      label: "no session",
      master: null,
      join: null,
      peers: [],
      linkSilentMs: null,
    };
  }

  /** Where an intent typed in this shell goes, or why it cannot go anywhere. */
  intentRoute(): IntentRoute {
    const view = this.snapshot();
    switch (view.mode) {
      case "none":
        return {
          kind: "refused",
          message: "no session on this device — /start a master or /join one",
        };
      case "joining":
        return { kind: "refused", message: "still joining — wait for the master to accept" };
      case "joined":
        return {
          kind: "refused",
          message: `this device is a peer of ${view.join?.target ?? "the master"}; type intents in the master's shell`,
        };
      default:
        break;
    }
    const master = view.master;
    if (master === null) throw new Error("a master view without master details");
    // This shell's own join of its own master counts: it can work the items too.
    if (view.peers.length === 0) {
      return { kind: "refused", message: noPeersText(master.listen, master.joinCode) };
    }
    if (this.master !== null) return { kind: "own", master: this.master };
    if (this.external === null) throw new Error("an external view without an external master");
    return { kind: "control", external: this.external };
  }
}

export function noPeersText(listen: string, joinCode: string | null): string {
  const code = joinCode ?? "<code>";
  return (
    "no peers joined yet — nothing can take this intent\n" +
    `on another device: skep → /join ${code} --host ${listen}`
  );
}

/** Why routing found no peer, naming each connected peer's repo (`?` until it described one). */
export function noMatchText(status: SessionStatus, repos: readonly string[]): string {
  if (status.peers.length === 0) return noPeersText(status.listen, status.joinCode);
  const peers = status.peers.map(
    (peer) => `${peer.peerId} ${peer.device}: repo ${peer.repo ?? "?"}`,
  );
  return (
    `no connected peer works on repo ${repos.join(", ")} (${peers.join("; ")})\n` +
    `peers must /join from a checkout of ${repos.join(", ")}`
  );
}

const LEAVE_REASONS: Record<string, string> = {
  heartbeat_timeout: "no heartbeat for 30 s — sleep, Wi-Fi or a firewall",
  connection_closed: "connection lost",
  transport_error: "network error",
  master_closed: "the master closed the session",
  sub_closed: "left on request",
  callback_error: "this device failed to answer the master (see the line above)",
  protocol_error: "protocol error — are both devices on the same skep version?",
};

/** A close reason with a human explanation, e.g. `heartbeat_timeout: no heartbeat for 30 s …`. */
export function explainReason(reason: string): string {
  const text = LEAVE_REASONS[reason];
  return text === undefined ? reason : `${reason}: ${text}`;
}

function peersFromStatus(
  status: SessionStatus,
  presence?: { peerId: string; silentMs: number }[],
): ShellPeer[] {
  const silence = new Map((presence ?? []).map((entry) => [entry.peerId, entry.silentMs]));
  return status.peers.map((peer) => {
    const silentMs = silence.get(peer.peerId);
    const role = peer.role ?? "-";
    if (peer.progress === undefined) {
      return {
        peerId: peer.peerId,
        device: peer.device,
        role,
        state: "joined",
        ...silent(silentMs),
      };
    }
    const { phase, done, total, failed, percent, summary } = peer.progress;
    return {
      peerId: peer.peerId,
      device: peer.device,
      role,
      state: phase,
      progress: { phase, done, total, failed, percent, summary },
      ...silent(silentMs),
    };
  });
}

function silent(silentMs: number | undefined): { silentMs?: number } {
  return silentMs === undefined ? {} : { silentMs };
}
