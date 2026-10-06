import { randomBytes } from "node:crypto";

/**
 * Injected randomness. Production uses crypto; the simulation harness supplies a seeded source
 * so runs are replayable (`skep sim run --seed 42`).
 */
export interface RandomSource {
  bytes(n: number): Uint8Array;
}

export const cryptoRandom: RandomSource = {
  bytes: (n) => new Uint8Array(randomBytes(n)),
};

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** RFC 4122 v4 UUID built from the given source. */
export function uuidV4(rs: RandomSource): string {
  const b = rs.bytes(16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function newEventId(rs: RandomSource): string {
  return `evt_${uuidV4(rs)}`;
}

export function newAttemptId(rs: RandomSource): string {
  return `att_${hex(rs.bytes(6))}`;
}

export function newBootId(rs: RandomSource): string {
  return `b_${hex(rs.bytes(6))}`;
}

/** `T-<yyyymmdd>-<4 hex>` from a wall-clock time (display meaning only). */
export function newTaskId(rs: RandomSource, nowMs: number): string {
  const d = new Date(nowMs).toISOString().slice(0, 10).replaceAll("-", "");
  return `T-${d}-${hex(rs.bytes(2))}`;
}
