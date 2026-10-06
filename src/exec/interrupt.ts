import type { ProcessHandle } from "../runtime/types.js";
import type { Clock } from "../util/clock.js";

async function exitedWithin(exited: Promise<boolean>, clock: Clock, ms: number): Promise<boolean> {
  const timeout = new AbortController();
  try {
    return await Promise.race([exited, clock.sleep(ms, timeout.signal).then(() => false)]);
  } finally {
    // Cancel losing sleeps so completed invocations do not keep timers or the daemon alive.
    timeout.abort();
  }
}

/** ARCHITECTURE §9.2 / PRD §9.7: stop the process group before recording a checkpoint. */
export async function runInterruptLadder(
  h: ProcessHandle,
  clock: Clock,
  opts: { graceMs?: number; termMs?: number } = {},
): Promise<"completed" | "interrupted" | "killed"> {
  const graceMs = opts.graceMs ?? 120_000;
  const termMs = opts.termMs ?? 30_000;
  for (const [name, value] of Object.entries({ graceMs, termMs })) {
    if (value < 0 || !Number.isFinite(value)) {
      throw new RangeError(`${name} must be a non-negative finite delay, received ${value}`);
    }
  }

  const exited = h.wait().then(() => true);
  // Let an already-settled wait win before sending any signal, without advancing the clock.
  if (await Promise.race([exited, Promise.resolve().then(() => false)])) return "completed";

  h.signalGroup("SIGINT");
  if (await exitedWithin(exited, clock, graceMs)) return "interrupted";

  h.signalGroup("SIGTERM");
  if (await exitedWithin(exited, clock, termMs)) return "interrupted";

  h.signalGroup("SIGKILL");
  await exited;
  return "killed";
}
