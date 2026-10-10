import { describe, expect, it } from "vitest";
import type { JoinFlow, MasterFlow, SessionStatus } from "../commands/session.js";
import {
  type ExternalMaster,
  explainReason,
  noMatchText,
  noPeersText,
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

function masterFlow(peers: MasterPeer[] = [], advertise = "192.168.1.20:7419"): MasterFlow {
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
    advertise,
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
    repo: "app",
    role: "coding",
    control: "auto",
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
      "/join --host 192.168.1.20:7419 --code 1234-5678-9012 --repo app",
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
    const a = external("A", [vps]);
    expect(session.applyProbe(session.beginProbe(), a)).toBe(true);
    expect(session.snapshot()).toMatchObject({
      mode: "external",
      label: "master (other process) · code 1234-5678-9012 · 192.168.1.20:7419",
    });
    // Actions are bound to the endpoint the master was discovered at.
    expect(session.intentRoute()).toEqual({ kind: "control", external: a });
    session.setMaster(masterFlow());
    expect(session.externalStatus).toBeNull();
    expect(session.applyProbe(session.beginProbe(), external("B"))).toBe(false);
  });
});

describe("external discovery generations", () => {
  it("an older probe failing after a newer success does not clear the master", () => {
    const session = new SessionController();
    const older = session.beginProbe();
    const newer = session.beginProbe();
    expect(session.applyProbe(newer, external("A", [vps]))).toBe(true);
    expect(session.applyProbe(older, null)).toBe(false);
    expect(session.snapshot()).toMatchObject({ mode: "external", live: true });
  });

  it("an older probe succeeding after a newer miss does not resurrect a master", () => {
    const session = new SessionController();
    const older = session.beginProbe();
    const newer = session.beginProbe();
    expect(session.applyProbe(newer, null)).toBe(true);
    expect(session.applyProbe(older, external("A"))).toBe(false);
    expect(session.snapshot().mode).toBe("none");
  });

  it("a probe that completes across /start or /join is dropped", () => {
    const session = new SessionController();
    const beforeStart = session.beginProbe();
    session.setMaster(masterFlow());
    expect(session.applyProbe(beforeStart, external("A"))).toBe(false);
    expect(session.snapshot().mode).toBe("master");

    const other = new SessionController();
    const beforeJoin = other.beginProbe();
    const generation = other.beginJoin("192.168.1.20:7419");
    other.joinFailed(generation);
    // The join failed, but the probe started before it is still stale; a new one must run.
    expect(other.applyProbe(beforeJoin, external("A"))).toBe(false);
    expect(other.applyProbe(other.beginProbe(), external("A"))).toBe(true);
  });

  it("shutdown invalidates a probe in flight", () => {
    const session = new SessionController();
    const probe = session.beginProbe();
    session.invalidateProbes();
    expect(session.applyProbe(probe, external("A"))).toBe(false);
  });
});

function external(id: string, peers: MasterPeer[] = []): ExternalMaster {
  return {
    endpoint: { listen: "192.168.1.20:7419", token: id.toLowerCase().repeat(32).slice(0, 32) },
    status: { ...status(peers), sessionId: `session-${id}` },
  };
}

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

  it("gives the pasteable /join line, with the repo, when no peer joined", () => {
    const text = noPeersText("203.0.113.7:7419", "123456789012", "app");
    expect(text).toContain(
      "paste into skep: /join --host 203.0.113.7:7419 --code 1234-5678-9012 --repo app",
    );
    expect(text).toContain(
      "skep session join --host 203.0.113.7:7419 --code 1234-5678-9012 --repo app",
    );
    expect(noPeersText("h:1", null, "app")).toContain("/join --host h:1 --code <code> --repo app");
  });

  it("refuses an intent without peers with the advertise address, not the bind", () => {
    const session = new SessionController();
    session.setMaster(masterFlow([], "203.0.113.7:7419"));
    const route = session.intentRoute();
    expect(route.kind).toBe("refused");
    if (route.kind !== "refused") return;
    expect(route.message).toContain(
      "/join --host 203.0.113.7:7419 --code 1234-5678-9012 --repo app",
    );
    expect(route.message).not.toContain("192.168.1.20");
  });
});

describe("SessionController /clean support", () => {
  it("abortJoin drops a handshake in flight and refuses its late flow", () => {
    const session = new SessionController();
    expect(session.abortJoin()).toBeNull();
    const generation = session.beginJoin("192.168.1.20:7419");
    session.joinRoster(generation, [row]);
    expect(session.abortJoin()).toBe("192.168.1.20:7419");
    expect(session.joinBusy).toBe(false);
    expect(session.joinStarted(generation, joinFlow())).toBe(false);
    expect(session.joinRoster(generation, [row])).toBe(false);
    expect(session.snapshot().mode).toBe("none");
    expect(session.snapshot().peers).toEqual([]);
  });

  it("clearExternal forgets the other master and voids discoveries in flight", () => {
    const session = new SessionController();
    const external: ExternalMaster = {
      endpoint: { listen: "192.168.1.20:7419", token: "t" },
      status: status([vps]),
    };
    expect(session.applyProbe(session.beginProbe(), external)).toBe(true);
    expect(session.snapshot().mode).toBe("external");
    const pending = session.beginProbe();
    session.clearExternal();
    expect(session.snapshot().mode).toBe("none");
    expect(session.applyProbe(pending, external)).toBe(false);
    expect(session.snapshot().live).toBe(false);
  });
});
