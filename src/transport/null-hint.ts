import type { Hint, HintChannel } from "./types.js";

/** Default transport: correctness depends on git polling, so hints are optional (§17.3, D18). */
export class NullHintChannel implements HintChannel {
  readonly name = "null";

  async start(_onHint: (hint: Hint) => void): Promise<void> {}

  async publish(_hint: Hint): Promise<void> {}

  async stop(): Promise<void> {}

  health(): { connected: boolean; lastMessageMonoMs: number | null } {
    return { connected: false, lastMessageMonoMs: null };
  }
}
