import { describe, expect, it } from "vitest";
import type { JoinFlow, MasterFlow, SessionStatus } from "../commands/session.js";
import {
  explainReason,
  noMatchText,
  SessionController,
  type SessionView,
} from "./session-controller.js";

function status<P extends SessionStatus["peers"][number]>(peers: P[] = []) {
  return {
    sessionId: "S-1",
    listen: "192.168.1.20:7419",
    repo: "app",
    joinCode: "123456789012",
    joinCodeExpiresAtMs: null,
    peers,
    intents: [],
  };
}

const vps: MasterPeer = {
  peerId: "peer-1",
  device: "vps",
  address: "10.0.0.2",
  family: "IPv4",
  repo: "api",
  head: null,
  role: null,
  progress: { phase: "working", done: 1, total: 2, failed: 0, percent: 50, summary: "forms" },
};

type MasterPeer = ReturnType<MasterFlow["handle"]["status"]>["peers"][number];

function masterFlow(peers: MasterPeer[] = []): MasterFlow {
  const never = new Promise<void>(() => {});
  return {
    handle: {
      address: null,
      sessionId: "S-1",
      status: () => status(peers),
      presence: () => peers.map((peer) => ({ peerId: peer.peerId, silentMs: 3_000 })),
      submitIntent: async () => ({ intentId: "N-1" }),
      attach: () => {},
      close: async () => {},
      closed: never,
    },
    listen: "192.168.1.20:7419",
    repo: "app",
    device: "mac",
    joinCode: "1234-5678-9012",
    joinCodeExpiresAtMs: null,
    closed: never,
    close: async () => {},
  };
}

function joinFlow(): JoinFlow {
  return {
    handle: {
      peerId: "peer-3",
      sessionId: "S-1",
      fingerprint: "ffff",
      close: async () => {},
      closed: new Promise(() => {}),
      silenceMs: () => 4_000,
    },
    target: "192.168.1.20:7419",
    device: "laptop",
    role: "coding",
    closed: new Promise(() => {}),
    close: async () => {},
  };
}

const row = { peerId: "peer-2", device: "vps", role: "web", state: "idle" };

describe("SessionController", () => {
  it("starts with no session and refuses intents", () => {
    const session = new SessionController();
    expect(session.snapshot()).toMatchObject<Partial<SessionView>>({
      mode: "none",
      live: false,
      label: "no session",
      peers: [],
    });
    expect(session.intentRoute()).toEqual({
      kind: "refused",
      message: "no session on this device — /start a master or /join one",
    });
  });

  it("reads an own master's peers and presence live, and gates intents on peers", () => {
    const peers: MasterPeer[] = [];
    const session = new SessionController();
    const flow = masterFlow(peers);
    session.setMaster(flow);
    expect(session.snapshot().label).toBe("master · code 1234-5678-9012 · 192.168.1.20:7419");
    const refused = session.intentRoute();
    expect(refused.kind).toBe("refused");
    expect(refused.kind === "refused" && refused.message).toContain(
      "/join 1234-5678-9012 --host 192.168.1.20:7419",
    );
    peers.push(vps);
    expect(session.snapshot().peers).toEqual([
      {
        peerId: "peer-1",
        device: "vps",
        role: "-",
        state: "working",
        progress: { phase: "working", done: 1, total: 2, failed: 0, percent: 50, summary: "forms" },
        silentMs: 3_000,
      },
    ]);
    expect(session.intentRoute()).toEqual({ kind: "own", master: flow });
    expect(session.masterEnded(masterFlow())).toBe(false);
    expect(session.masterEnded(flow)).toBe(true);
    expect(session.snapshot().mode).toBe("none");
  });

  it("accepts rosters only from the current join attempt", () => {
    const session = new SessionController();
    const first = session.beginJoin("192.168.1.20:7419");
    expect(session.snapshot()).toMatchObject({ mode: "joining", live: true });
    expect(session.joinRoster(first, [row])).toBe(true);
    session.joinFailed(first);
    expect(session.snapshot()).toMatchObject({ mode: "none", peers: [] });
    expect(session.joinRoster(first, [row])).toBe(false);

    const second = session.beginJoin("192.168.1.20:7419");
    const flow = joinFlow();
    expect(session.joinStarted(second, flow)).toBe(true);
    expect(session.joinRoster(second, [row])).toBe(true);
    expect(session.snapshot()).toMatchObject({
      mode: "joined",
      label: "joined 192.168.1.20:7419 as peer-3 · coding",
      peers: [row],
      linkSilentMs: 4_000,
    });
    expect(session.intentRoute()).toMatchObject({ kind: "refused" });
    expect(session.joinEnded(flow)).toBe(true);
    expect(session.joinRoster(second, [row])).toBe(false);
    expect(session.snapshot()).toMatchObject({ mode: "none", peers: [] });
  });

  it("attaches to an external master only while it owns no flow", () => {
    const session = new SessionController();
    expect(session.setExternal(status([vps]))).toBe(true);
    expect(session.snapshot()).toMatchObject({
      mode: "external",
      label: "master (other process) · code 1234-5678-9012 · 192.168.1.20:7419",
    });
    expect(session.intentRoute()).toEqual({ kind: "control" });
    session.setMaster(masterFlow());
    expect(session.externalStatus).toBeNull();
    expect(session.setExternal(status())).toBe(false);
  });
});

describe("texts", () => {
  it("explains known close reasons and passes others through", () => {
    expect(explainReason("heartbeat_timeout")).toMatch(/^heartbeat_timeout: no heartbeat/);
    expect(explainReason("weird")).toBe("weird");
  });

  it("names peers' repos in a no_match", () => {
    expect(noMatchText(status([vps]), ["app"])).toContain(
      "no connected peer works on repo app (peer-1 vps: repo api)",
    );
    expect(noMatchText(status(), ["app"])).toContain("no peers joined yet");
  });
});
