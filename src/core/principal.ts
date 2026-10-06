import { type AgentId, DEVICE_RE, type DeviceName, deviceOfAgent } from "./ids.js";

/**
 * A signer principal from the local trust root (`~/.skep/allowed_signers`, PRD §11.2).
 * - `human`: the human key (Mac only).
 * - `daemon:<device>`: a device's skepd key.
 */
export type Principal = { kind: "human" } | { kind: "daemon"; device: DeviceName };

export function parsePrincipal(s: string): Principal | null {
  if (s === "human") return { kind: "human" };
  if (s.startsWith("daemon:")) {
    const device = s.slice("daemon:".length);
    return DEVICE_RE.test(device) ? { kind: "daemon", device } : null;
  }
  return null;
}

export function formatPrincipal(p: Principal): string {
  return p.kind === "human" ? "human" : `daemon:${p.device}`;
}

/** True when a daemon principal may act for the given agent (agent lives on that device). */
export function daemonOwnsAgent(p: Principal, agent: AgentId): boolean {
  return p.kind === "daemon" && deviceOfAgent(agent) === p.device;
}

/** The actor string the human uses in event envelopes. */
export const HUMAN_ACTOR = "human";
