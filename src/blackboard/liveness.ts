import { z } from "zod";
import { AgentIdSchema, ShaSchema } from "../core/schemas/common.js";
import { type Heartbeat, HeartbeatSchema } from "../core/schemas/heartbeat.js";
import type { Clock } from "../util/clock.js";

export interface LivenessConfig {
  liveFactor: number;
  staleMs: number;
  lostMs: number;
}

export interface LivenessClassification {
  cls: "live" | "stale" | "lost" | "unknown";
  sinceChangeMs: number;
  bootId?: string;
}

interface Observation {
  oid: string;
  n: number;
  bootId: string;
  intervalMs: number;
  changedAt: number;
  observations: number;
}

const ConfigSchema = z
  .strictObject({
    liveFactor: z.number().positive().finite(),
    staleMs: z.number().nonnegative().finite(),
    lostMs: z.number().positive().finite(),
  })
  .refine((cfg) => cfg.lostMs > cfg.staleMs, "lostMs must exceed staleMs");
const ObservationSchema = z.strictObject({
  agent: AgentIdSchema.refine((value) => !/[\r\n\0]/.test(value)),
  oid: ShaSchema.refine((value) => !value.includes("\n")),
  hb: HeartbeatSchema.refine((value) => !/[\r\n\0]/.test(value.boot_id)),
});

export class LivenessError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LivenessError";
  }
}

export class LivenessTracker {
  private readonly agents = new Map<string, Observation>();
  private readonly cfg: LivenessConfig;

  constructor(
    private readonly clock: Clock,
    cfg: LivenessConfig = { liveFactor: 3, staleMs: 5 * 60_000, lostMs: 15 * 60_000 },
  ) {
    const parsed = ConfigSchema.safeParse(cfg);
    if (!parsed.success)
      throw new LivenessError("Invalid liveness configuration", { cause: parsed.error });
    this.cfg = parsed.data;
  }

  observe(agent: string, oid: string, hb: Heartbeat | null): void {
    if (hb === null) {
      // An unverifiable heartbeat supplies no evidence of liveness (ARCHITECTURE §8.2).
      this.agents.delete(agent);
      return;
    }
    const parsed = ObservationSchema.safeParse({ agent, oid, hb });
    if (!parsed.success || parsed.data.hb.agent !== agent) {
      throw new LivenessError("Invalid heartbeat observation or mismatched agent", {
        cause: parsed.success ? undefined : parsed.error,
      });
    }
    const previous = this.agents.get(agent);
    const restart = previous?.bootId !== hb.boot_id;
    const changed = !previous || previous.oid !== oid || previous.n !== hb.n || restart;
    this.agents.set(agent, {
      oid,
      n: hb.n,
      bootId: hb.boot_id,
      // skep.hb/v1 has no interval field. PRD §10.4 fixes it at 60 s with a lease, 300 s idle.
      intervalMs: hb.epoch === null ? 300_000 : 60_000,
      changedAt: changed ? this.clock.monotonicMs() : previous.changedAt,
      observations: !previous || restart ? 1 : Math.min(2, previous.observations + 1),
    });
  }

  classify(agent: string): LivenessClassification {
    const observed = this.agents.get(agent);
    if (!observed) return { cls: "unknown", sinceChangeMs: 0 };
    const sinceChangeMs = this.clock.monotonicMs() - observed.changedAt;
    let cls: LivenessClassification["cls"] = "unknown";
    if (observed.observations >= 2) {
      // Lost takes precedence. Idle beats remain live within their longer three-interval window;
      // active beats between that window and staleMs are unknown (ARCHITECTURE §8.2).
      if (sinceChangeMs >= this.cfg.lostMs) cls = "lost";
      else if (sinceChangeMs < this.cfg.liveFactor * observed.intervalMs) cls = "live";
      else if (sinceChangeMs >= this.cfg.staleMs) cls = "stale";
    }
    return { cls, sinceChangeMs, bootId: observed.bootId };
  }

  resetAll(): void {
    // PRD §10.5: after our own suspend, time we did not observe cannot justify revocation.
    this.agents.clear();
  }
}
