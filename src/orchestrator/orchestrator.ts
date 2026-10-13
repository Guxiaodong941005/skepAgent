/**
 * Drives orchestrations (docs/plans/tui-scroll-and-herdr-controller.md §3.2): the pure reducer
 * decides the phase, this class performs what the phase asks for — a master agent turn, a
 * question, a confirmation, a dispatch, a synthesis — and feeds the outcome back as an event.
 *
 * Skep owns the loop (T1, plan §3.1): the master agent only refines and synthesizes, it never
 * dispatches. Every I/O dependency is injected so tests run it with fakes.
 */

import {
  type OrchestrationEvent,
  type OrchestrationItem,
  type OrchestrationMode,
  type OrchestrationState,
  reduceOrchestration,
  startOrchestration,
  TERMINAL_PHASES,
} from "../core/orchestration/reducer.js";
import { briefText, parseRefineOutput } from "../core/orchestration/schemas.js";
import type { Clock } from "../util/clock.js";
import type { Ledger } from "./ledger.js";
import { LEDGER_VERSION } from "./ledger.js";
import { MASTER_CONTEXT_MAX_CHARS, type MasterAgent, MasterAgentError } from "./master-agent.js";
import {
  historyLine,
  type PeerTarget,
  PROMPT_VERSION,
  refinePrompt,
  repairPrompt,
  synthesisPrompt,
} from "./prompts.js";

/** Earlier orchestrations a re-seeded conversation starts with (plan §3.7). */
export const RESEED_HISTORY = 3;

export type OrchestratorTone = "info" | "event" | "warn" | "error" | "muted";

export type ConfirmAnswer =
  | { action: "send" }
  | { action: "edit"; text: string }
  | { action: "cancel" };

export interface OrchestratorDeps {
  agent: MasterAgent;
  clock: Clock;
  /** Null disables the ledger (and with it re-seeding and /history). */
  ledger: Ledger | null;
  peers(): PeerTarget[];
  /** Sends the brief through the shell's intent route; resolves with the intent ids. */
  dispatch(text: string): Promise<string[]>;
  /** The items of `intentIds` as the master reports them now; null when unknown. */
  items(intentIds: readonly string[]): OrchestrationItem[] | null;
  /**
   * Snapshots the master's working tree and returns a check that lists files a master agent turn
   * changed (plan §3.4 read-only contract).
   */
  guard(): Promise<() => Promise<string[]>>;
  ask(question: string): Promise<string | null>;
  confirm(brief: { title: string; text: string }): Promise<ConfirmAnswer>;
  show(text: string, tone: OrchestratorTone, gutter?: string): void;
  /** A phase changed: redraw the footer. */
  changed?(): void;
}

interface Run {
  state: OrchestrationState;
  ledgerId: string;
  createdAtMs: number;
  phaseSinceMs: number;
  qa: { question: string; answer: string }[];
  abort: AbortController;
  /** The effect loop is running; events from outside only reduce. */
  busy: boolean;
  /** Ledger writes of this run, in order: a late write must never overwrite a newer state. */
  writes: Promise<void>;
  finished: Promise<OrchestrationState>;
  settle(state: OrchestrationState): void;
}

export class Orchestrator {
  private readonly runs = new Map<string, Run>();
  private next = 1;
  /** Master agent turns run one at a time: they share one conversation. */
  private turns: Promise<unknown> = Promise.resolve();
  /** History for the first turn after a fresh conversation was forced (cap or resume failure). */
  private reseed: string[] | null = null;
  private ledgerWarned = false;
  private readonly stamp: string;

  constructor(private readonly deps: OrchestratorDeps) {
    this.stamp = deps.clock.nowMs().toString(36);
  }

  /** Starts an orchestration for one human request; resolves when it reached a final phase. */
  start(
    userText: string,
    mode: Exclude<OrchestrationMode, "off">,
  ): {
    id: string;
    done: Promise<OrchestrationState>;
  } {
    const id = `O-${this.next++}`;
    const now = this.deps.clock.monotonicMs();
    let settle: (state: OrchestrationState) => void = () => {};
    const finished = new Promise<OrchestrationState>((resolve) => {
      settle = resolve;
    });
    const run: Run = {
      state: startOrchestration(id, userText, mode),
      ledgerId: `O-${this.stamp}-${id.slice(2)}`,
      createdAtMs: this.deps.clock.nowMs(),
      phaseSinceMs: now,
      qa: [],
      abort: new AbortController(),
      busy: false,
      writes: Promise.resolve(),
      finished,
      settle,
    };
    this.runs.set(id, run);
    this.deps.show(`${id} master agent ${this.deps.agent.cli} is refining your request`, "muted");
    this.persist(run);
    void this.drive(run);
    return { id, done: finished };
  }

  /** Orchestrations not yet finished, with how long they have been in their phase. */
  active(): { id: string; phase: string; forMs: number }[] {
    const now = this.deps.clock.monotonicMs();
    return [...this.runs.values()]
      .filter((run) => !TERMINAL_PHASES.has(run.state.phase))
      .map((run) => ({ id: run.state.id, phase: run.state.phase, forMs: now - run.phaseSinceMs }));
  }

  get(id: string): OrchestrationState | null {
    return this.runs.get(id)?.state ?? null;
  }

  /** Re-reads the items of every awaiting orchestration (the shell calls this on its tick). */
  poll(): void {
    for (const run of this.runs.values()) {
      const { phase, intentIds } = run.state;
      if (phase !== "awaiting" && phase !== "stalled") continue;
      const items = this.deps.items(intentIds);
      if (items === null || sameItems(items, run.state.items)) continue;
      const before = run.state.phase;
      this.apply(run, { type: "itemsChanged", items });
      if (run.state.phase === "stalled" && before !== "stalled") {
        const waiting = run.state.items.filter((item) => item.verdict === "pending");
        this.deps.show(
          `${run.state.id} waits for a human on ${waiting.map((i) => i.itemId).join(", ")}; ` +
            `answer it in the agent's pane, or /summarize ${run.state.id} to summarize what exists`,
          "warn",
        );
      }
      if (phaseOf(run) === "synthesizing") void this.drive(run);
    }
  }

  /** `/summarize <id>`: synthesize with the results that exist now. */
  summarize(id: string): string | null {
    const run = this.runs.get(id);
    if (run === undefined) return `no orchestration ${id} in this shell`;
    if (run.state.phase !== "awaiting" && run.state.phase !== "stalled") {
      return `${id} is ${run.state.phase}; /summarize applies while it waits for peers`;
    }
    const items = this.deps.items(run.state.intentIds);
    if (items !== null) this.apply(run, { type: "itemsChanged", items });
    this.apply(run, { type: "summarizeNow" });
    if (phaseOf(run) !== "synthesizing") return `${id} has no results yet`;
    void this.drive(run);
    return null;
  }

  cancel(id: string): string | null {
    const run = this.runs.get(id);
    if (run === undefined) return `no orchestration ${id} in this shell`;
    if (TERMINAL_PHASES.has(run.state.phase)) return `${id} already ended (${run.state.phase})`;
    run.abort.abort();
    this.apply(run, { type: "cancelled" });
    run.settle(run.state);
    this.deps.show(
      run.state.intentIds.length > 0
        ? `${id} cancelled here; intent ${run.state.intentIds.join(", ")} keeps running on the peers`
        : `${id} cancelled`,
      "event",
    );
    return null;
  }

  /** `/orchestrate new`: the next request starts a fresh master agent conversation. */
  newConversation(): void {
    this.deps.agent.reset();
    this.reseed = null;
  }

  // -------------------------------------------------------------------------------------------

  private apply(run: Run, event: OrchestrationEvent): void {
    const before = run.state.phase;
    run.state = reduceOrchestration(run.state, event);
    if (run.state.phase !== before) run.phaseSinceMs = this.deps.clock.monotonicMs();
    this.persist(run);
    this.deps.changed?.();
  }

  /** Resolves when every ledger write issued so far has finished (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.runs.values()].map((run) => run.writes));
  }

  /** Runs effects until the orchestration waits on peers or ends. */
  private async drive(run: Run): Promise<OrchestrationState> {
    if (run.busy) return run.state;
    run.busy = true;
    try {
      for (;;) {
        const event = await this.effect(run);
        if (event === null) break;
        this.apply(run, event);
      }
    } catch (error) {
      // An effect that throws is a bug or a dead dependency: the request fails visibly.
      this.deps.show(`${run.state.id} failed: ${errorMessage(error)}`, "error");
      this.apply(run, { type: "cancelled" });
      run.settle(run.state);
    } finally {
      run.busy = false;
    }
    return run.state;
  }

  private async effect(run: Run): Promise<OrchestrationEvent | null> {
    const { state } = run;
    if (run.abort.signal.aborted) return null;
    switch (state.phase) {
      case "refining":
        return this.refine(run);
      case "asking":
        return this.askQuestions(run);
      case "confirming":
        return this.confirmBrief(run);
      case "dispatching":
        return this.dispatchBrief(run);
      case "synthesizing":
        return this.synthesize(run);
      case "awaiting": {
        // Results may already be there (a fast peer, or a poll that ran before dispatch).
        const items = this.deps.items(state.intentIds);
        if (items !== null && !sameItems(items, state.items)) {
          return { type: "itemsChanged", items };
        }
        return null;
      }
      case "done":
        this.finish(run);
        run.settle(run.state);
        return null;
      case "failed":
        this.fail(run);
        run.settle(run.state);
        return null;
      case "cancelled":
        run.settle(run.state);
        return null;
      default:
        return null;
    }
  }

  private async refine(run: Run): Promise<OrchestrationEvent> {
    const { state } = run;
    const prompt = refinePrompt({
      userText: state.userText,
      peers: this.deps.peers(),
      answers: run.qa,
    });
    let reply: string;
    try {
      reply = await this.turn(run, prompt);
    } catch (error) {
      return { type: "refineFailed", cause: errorMessage(error) };
    }
    let parsed = parseRefineOutput(reply);
    if (!parsed.ok) {
      // One repair turn, then a clear failure — never a silent fallback to the raw text.
      try {
        parsed = parseRefineOutput(await this.turn(run, repairPrompt(parsed.reason)));
      } catch (error) {
        return { type: "refineFailed", cause: errorMessage(error) };
      }
      if (!parsed.ok) return { type: "refineFailed", cause: parsed.reason };
    }
    return { type: "refined", output: parsed.output };
  }

  private async askQuestions(run: Run): Promise<OrchestrationEvent> {
    const answers: string[] = [];
    for (const question of run.state.questions) {
      const answer = await this.deps.ask(`${run.state.id} master agent asks: ${question}`);
      if (answer === null) {
        this.deps.show(`${run.state.id} cancelled; nothing was sent`, "event");
        return { type: "cancelled" };
      }
      run.qa.push({ question, answer });
      answers.push(`Q: ${question}\nA: ${answer}`);
    }
    return { type: "answered", text: answers.join("\n") };
  }

  private async confirmBrief(run: Run): Promise<OrchestrationEvent> {
    const brief = run.state.brief;
    if (brief === null) return { type: "cancelled" };
    this.showBrief(run, "brief ready (confirm mode)");
    const answer = await this.deps.confirm(brief);
    if (answer.action === "cancel") {
      this.deps.show(`${run.state.id} cancelled; nothing was sent`, "event");
      return { type: "cancelled" };
    }
    if (answer.action === "edit") {
      return { type: "confirmed", brief: { title: brief.title, text: answer.text } };
    }
    return { type: "confirmed" };
  }

  private async dispatchBrief(run: Run): Promise<OrchestrationEvent> {
    const brief = run.state.brief;
    if (brief === null) return { type: "dispatchFailed", cause: "no brief" };
    if (run.state.mode === "auto") this.showBrief(run, "brief → peers");
    try {
      const intentIds = await this.deps.dispatch(briefText(brief.title, brief.text));
      if (intentIds.length === 0) return { type: "dispatchFailed", cause: "nothing was sent" };
      this.deps.show(
        `${run.state.id} sent as intent ${intentIds.join(", ")}; waiting for the peers`,
        "event",
      );
      return { type: "dispatched", intentIds };
    } catch (error) {
      return { type: "dispatchFailed", cause: errorMessage(error) };
    }
  }

  private async synthesize(run: Run): Promise<OrchestrationEvent> {
    const { state } = run;
    this.deps.show(
      `${state.id} peers settled; master agent ${this.deps.agent.cli} is writing the summary`,
      "muted",
    );
    const prompt = synthesisPrompt({
      userText: state.userText,
      brief: state.brief === null ? "(none)" : briefText(state.brief.title, state.brief.text),
      items: state.items,
    });
    try {
      return { type: "synthesized", text: await this.turn(run, prompt) };
    } catch (error) {
      return { type: "synthFailed", cause: errorMessage(error) };
    }
  }

  /**
   * One master agent turn: serialized, bounded by the 500K cap, re-seeded once when a resume
   * fails, and checked for working-tree changes afterwards.
   */
  private turn(run: Run, prompt: string): Promise<string> {
    const go = async (): Promise<string> => {
      const agent = this.deps.agent;
      if (agent.contextChars + prompt.length > MASTER_CONTEXT_MAX_CHARS) {
        await this.freshConversation("its context reached 500K characters");
      }
      const check = await this.deps.guard();
      let text: string;
      try {
        text = (await agent.turn({ prompt: this.withReseed(prompt), signal: run.abort.signal }))
          .text;
      } catch (error) {
        // Only a CLI that ran and failed may have lost its conversation; a timeout or an
        // unreadable answer would just fail again, slower.
        const resumeFailed =
          error instanceof MasterAgentError &&
          error.kind === "failed" &&
          agent.conversationId !== null;
        if (!resumeFailed || run.abort.signal.aborted) throw error;
        await this.freshConversation(`resuming it failed (${errorMessage(error)})`);
        text = (await agent.turn({ prompt: this.withReseed(prompt), signal: run.abort.signal }))
          .text;
      }
      // The new conversation has its history now.
      this.reseed = null;
      const changed = await check();
      if (changed.length > 0) {
        throw new MasterAgentError(
          `the master agent changed files it must only read: ${changed.join(", ")}; ` +
            "the turn was rejected — review those changes in your folder",
        );
      }
      return text;
    };
    const result = this.turns.then(go, go);
    this.turns = result.catch(() => undefined);
    return result;
  }

  private async freshConversation(why: string): Promise<void> {
    this.deps.agent.reset();
    this.reseed = await this.history();
    this.deps.show(
      `master agent: starting a fresh conversation because ${why}` +
        (this.reseed.length > 0 ? `; seeded with the last ${this.reseed.length} requests` : ""),
      "warn",
    );
  }

  private withReseed(prompt: string): string {
    if (this.reseed === null || this.reseed.length === 0) return prompt;
    const history = this.reseed.map((entry) => `- ${entry}`).join("\n");
    return `Earlier requests in this session (summaries, oldest first):\n${history}\n\n${prompt}`;
  }

  private async history(): Promise<string[]> {
    if (this.deps.ledger === null) return [];
    const { records } = await this.deps.ledger.recent(RESEED_HISTORY + this.runs.size);
    return records
      .filter((record) => record.state.phase === "done" && record.state.synthesis !== null)
      .slice(0, RESEED_HISTORY)
      .reverse()
      .map((record) => historyLine(record.state));
  }

  private showBrief(run: Run, label: string): void {
    const brief = run.state.brief;
    if (brief === null) return;
    this.deps.show(`${run.state.id} ${label}:`, "event");
    this.deps.show(briefText(brief.title, brief.text), "info", "  │ ");
  }

  private finish(run: Run): void {
    const { state } = run;
    if (state.synthesis !== null) {
      this.deps.show(`${state.id} summary:`, "event");
      this.deps.show(state.synthesis, "info", "  │ ");
      return;
    }
    // Synthesis failed: the results as received, so nothing the peers did is lost.
    this.deps.show(
      `${state.id} could not be summarized (${state.failure?.cause ?? "unknown"}); results as received:`,
      "warn",
    );
    for (const item of state.items) {
      this.deps.show(
        `${item.itemId} ${item.verdict} · ${item.device ?? "?"} (${item.repo})\n${item.summary ?? "(no result)"}`,
        item.verdict === "done" ? "info" : "warn",
        "  │ ",
      );
    }
  }

  private fail(run: Run): void {
    const { state } = run;
    const failure = state.failure;
    if (failure === null) return;
    const fix =
      failure.stage === "refine"
        ? `send your words as they are with /intent ${oneLine(state.userText)}`
        : "check /status, then send the request again";
    this.deps.show(`${state.id} ${failure.stage} failed: ${failure.cause}\nfix: ${fix}`, "error");
  }

  private persist(run: Run): void {
    const ledger = this.deps.ledger;
    if (ledger === null) return;
    const snapshot = run.state;
    const write = () =>
      ledger.write({
        version: LEDGER_VERSION,
        id: run.ledgerId,
        createdAtMs: run.createdAtMs,
        updatedAtMs: this.deps.clock.nowMs(),
        cli: this.deps.agent.cli,
        conversationId: this.deps.agent.conversationId,
        promptVersion: PROMPT_VERSION,
        state: snapshot,
      });
    run.writes = run.writes.then(write).catch((error: unknown) => {
      // Said once: the orchestration itself goes on without its ledger.
      if (this.ledgerWarned) return;
      this.ledgerWarned = true;
      this.deps.show(`orchestration ledger: ${errorMessage(error)}`, "warn");
    });
  }
}

/** The live phase; a plain read so earlier checks on it do not narrow it. */
function phaseOf(run: Run): OrchestrationState["phase"] {
  return run.state.phase;
}

function sameItems(a: readonly OrchestrationItem[], b: readonly OrchestrationItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
