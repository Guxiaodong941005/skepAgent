import type { Clock } from "../util/clock.js";
import { type Hint, type HintChannel, HintSchema } from "./types.js";

/**
 * @internal Test helper for SK-302 (ships in `src/` so the sync tests can import it; not a
 * production transport). Delivery is explicit and synchronous, with no network or real timers.
 *
 * `publish` before `start()` is discarded, not queued (SK-308 review note 2): the channel never
 * rejects, and a hint published while stopped would otherwise reappear on restart and surprise a
 * test that forgot to start the channel. `published` only records what a live subscriber could
 * have observed.
 */
export class FakeHintChannel implements HintChannel {
  readonly name = "fake";
  readonly published: Hint[] = [];
  private onHint: ((hint: Hint) => void) | null = null;
  private lastMessageMonoMs: number | null = null;

  constructor(private readonly clock: Clock) {}

  async start(onHint: (hint: Hint) => void): Promise<void> {
    this.onHint = onHint;
  }

  async publish(hint: Hint): Promise<void> {
    // Before `start()` (and after `stop()`) there is no subscriber, so the hint is dropped rather
    // than recorded or queued (SK-308 review note 2). A test that forgets to start the channel
    // sees an empty `published`, which is the bug; queueing would hide it until restart.
    if (this.onHint === null) return;
    const parsed = HintSchema.safeParse(hint);
    if (parsed.success) this.published.push(parsed.data);
    // No automatic loopback: tests control inbound hints independently from local writes (§17.2).
  }

  /** Invalid frames and hints received while stopped are dropped, never queued (§17.3). */
  emit(hint: unknown): boolean {
    if (this.onHint === null) return false;
    const parsed = HintSchema.safeParse(hint);
    if (!parsed.success) return false;
    this.lastMessageMonoMs = this.clock.monotonicMs();
    this.onHint(parsed.data);
    return true;
  }

  async stop(): Promise<void> {
    this.onHint = null;
  }

  health(): { connected: boolean; lastMessageMonoMs: number | null } {
    return { connected: this.onHint !== null, lastMessageMonoMs: this.lastMessageMonoMs };
  }
}
