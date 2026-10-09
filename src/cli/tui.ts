/**
 * Skep's full-screen control view (D30): one agent at a time, several agents as a list.
 *
 * Dependency-free on purpose: ANSI escapes, raw mode and the alternate screen are all it needs,
 * and a terminal emulator or TUI library would widen the supply chain for a ~24-row screen. The
 * screen is redrawn in full on every change; there is no diffing.
 *
 * It never forwards input to an agent and has no approve key (D29): a blocked agent is answered
 * in the agent's own view, which `a` opens (PTY: this terminal; herdr: its pane).
 */

import { type Clock, systemClock } from "../util/clock.js";
import type { JoinView, JoinViewModel, PeerPhase } from "./commands/session.js";

const ESC = "\x1b[";
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;
const CURSOR_HIDE = `${ESC}?25l`;
const CURSOR_SHOW = `${ESC}?25h`;
const HOME_CLEAR = `${ESC}H${ESC}2J`;
const INVERSE = `${ESC}7m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

/** Below this the layout cannot show every section, so only a notice is drawn. */
export const MIN_ROWS = 24;
/** At most this many list rows; the rest of the screen belongs to the tail. */
const MAX_LIST_ROWS = 6;

export type Glyphs = "unicode" | "ascii";
export const TICK_MS = 250;

export function beeLane(phase: PeerPhase, beat: number, glyphs: Glyphs): string {
  const bee = glyphs === "unicode" ? "🐝" : "~b";
  if (phase === "working") {
    const offset = [0, 1, 2, 1][beat % 4] ?? 0;
    return `${" ".repeat(offset)}${bee}${" ".repeat(2 - offset)}`;
  }
  if (phase === "blocked") {
    return glyphs === "unicode" ? (beat % 4 < 2 ? "🐝! " : "🐝  ") : beat % 4 < 2 ? "b!  " : "b   ";
  }
  if (phase === "done") return glyphs === "unicode" ? "✓   " : "ok  ";
  return glyphs === "unicode" ? "·   " : ".   ";
}

export function progressBar(percent: number, glyphs: Glyphs): string {
  const bounded = Math.max(0, Math.min(100, percent));
  const filled = bounded === 100 ? 8 : Math.min(7, Math.round(bounded / 12.5));
  const full = glyphs === "unicode" ? "█" : "#";
  const empty = glyphs === "unicode" ? "░" : ".";
  return full.repeat(filled) + empty.repeat(8 - filled);
}

export function charWidth(cp: number): number {
  return cp >= 0x1f300 && cp <= 0x1faff ? 2 : 1;
}

function displayWidth(text: string): number {
  return [...text].reduce((width, char) => width + charWidth(char.codePointAt(0) ?? 0), 0);
}

// ---------------------------------------------------------------------------------------------
// Terminal I/O.

export interface TtyInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TtyOutput {
  write(text: string): unknown;
  columns?: number;
  rows?: number;
  on?(event: "resize", listener: () => void): unknown;
  off?(event: "resize", listener: () => void): unknown;
}

type ProcessEvent = "SIGINT" | "SIGTERM" | "exit";

/** Where terminal-restoring handlers are installed; `process` in production, a fake in tests. */
export interface ProcessHooks {
  on(event: ProcessEvent, listener: () => void): unknown;
  off(event: ProcessEvent, listener: () => void): unknown;
}

export type Key =
  | { name: "up" | "down" | "enter" | "quit" }
  | { name: "char"; char: string }
  | { name: "other" };

/**
 * Splits one stdin chunk into keys. Raw mode delivers Ctrl-C as a byte rather than a signal, so it
 * decodes to `quit` like `q`. Unknown escape sequences are swallowed whole so their tail bytes are
 * never read as letters.
 */
export function decodeKeys(chunk: Buffer | string): Key[] {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const keys: Key[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\x1b") {
      const next = text[i + 1];
      if (next === "[" || next === "O") {
        // CSI/SS3: parameter bytes, then one final byte in @..~.
        let end = i + 2;
        while (end < text.length && !/[@-~]/.test(text[end] as string)) end++;
        const final = text[end];
        keys.push(
          final === "A" ? { name: "up" } : final === "B" ? { name: "down" } : { name: "other" },
        );
        i = end + 1;
      } else {
        keys.push({ name: "other" });
        i += 1;
      }
      continue;
    }
    if (ch === "\x03" || ch === "q") keys.push({ name: "quit" });
    else if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (/^[a-z]$/i.test(ch)) keys.push({ name: "char", char: ch.toLowerCase() });
    else keys.push({ name: "other" });
    i += 1;
  }
  return keys;
}

/** Drops control characters so text from the wire can never move the cursor or restyle. */
function printable(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\t") out += " ";
    else if (!(code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0))) out += char;
  }
  return out;
}

/** Cuts `text` to `width` display columns, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
  const clean = printable(text);
  if (displayWidth(clean) <= width) return clean;
  if (width <= 0) return "";
  let used = 0;
  let out = "";
  for (const char of clean) {
    const columns = charWidth(char.codePointAt(0) ?? 0);
    if (used + columns > width - 1) break;
    out += char;
    used += columns;
  }
  return `${out}…`;
}

export type Line = string | { text: string; style: "inverse" | "bold" };

export interface ScreenIo {
  stdin: TtyInput;
  stdout: TtyOutput;
  /** Fixed size (tests); otherwise read from `stdout` on every frame. */
  columns?: number;
  rows?: number;
}

/**
 * Owns the terminal between `start()` and `close()`. Every exit path — quit, a thrown error, a
 * signal, process exit, `suspend()` — goes through {@link restore}, so the user's shell is never
 * left in raw mode on the alternate screen.
 */
export class Screen {
  private active = false;
  private closed = false;
  private readonly onData = (chunk: Buffer | string): void => {
    for (const key of decodeKeys(chunk)) {
      if (!this.active) return;
      this.handlers.onKey(key);
    }
  };
  private readonly onResize = (): void => this.handlers.onResize?.();
  private readonly onSignal = (): void => {
    this.close();
    this.handlers.onSignal?.();
  };
  private readonly onExit = (): void => this.close();

  constructor(
    private readonly io: ScreenIo,
    private readonly handlers: {
      onKey(key: Key): void;
      onResize?(): void;
      /** After the terminal was restored because of SIGINT/SIGTERM. */
      onSignal?(): void;
    },
    private readonly hooks: ProcessHooks = process,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  size(): { columns: number; rows: number } {
    return {
      columns: this.io.columns ?? this.io.stdout.columns ?? 80,
      rows: this.io.rows ?? this.io.stdout.rows ?? 24,
    };
  }

  start(): void {
    if (this.closed) throw new Error("the screen was closed and cannot be restarted");
    this.hooks.on("SIGINT", this.onSignal);
    this.hooks.on("SIGTERM", this.onSignal);
    this.hooks.on("exit", this.onExit);
    this.io.stdout.on?.("resize", this.onResize);
    this.enter();
  }

  /** Full redraw. A throw (e.g. a broken stdout) restores the terminal before it propagates. */
  draw(lines: Line[]): void {
    if (!this.active) return;
    try {
      const { columns, rows } = this.size();
      const body = lines.slice(0, rows).map((line) => {
        if (typeof line === "string") return truncate(line, columns);
        const text = truncate(line.text, columns);
        const pad = line.style === "inverse" ? " ".repeat(columns - displayWidth(text)) : "";
        return `${line.style === "inverse" ? INVERSE : BOLD}${text}${pad}${RESET}`;
      });
      this.io.stdout.write(`${HOME_CLEAR}${body.join("\r\n")}`);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Gives the terminal back (a PTY agent runs in it) until {@link resume}. */
  suspend(): void {
    if (!this.active) return;
    this.restore();
  }

  resume(): void {
    if (this.active || this.closed) return;
    this.enter();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.hooks.off("SIGINT", this.onSignal);
    this.hooks.off("SIGTERM", this.onSignal);
    this.hooks.off("exit", this.onExit);
    this.io.stdout.off?.("resize", this.onResize);
    if (this.active) this.restore();
  }

  private enter(): void {
    const { stdin, stdout } = this.io;
    if (stdin.isTTY === true) stdin.setRawMode?.(true);
    stdin.on("data", this.onData);
    stdin.resume();
    stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
    this.active = true;
  }

  private restore(): void {
    const { stdin, stdout } = this.io;
    this.active = false;
    // Each step runs even when an earlier one throws: half a restore is worse than none.
    const steps = [
      () => stdin.off("data", this.onData),
      () => stdin.pause(),
      () => {
        if (stdin.isTTY === true) stdin.setRawMode?.(false);
      },
      () => stdout.write(`${RESET}${CURSOR_SHOW}${ALT_SCREEN_OFF}`),
    ];
    const errors: unknown[] = [];
    for (const step of steps) {
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "could not fully restore the terminal");
    }
  }
}

// ---------------------------------------------------------------------------------------------
// What the screen shows.

export type SubmitChoice = "pr" | "mr" | "push" | "none" | null;
export type CodeHostKind = "github" | "gitlab" | "git";

export interface TuiPeer {
  peerId: string;
  device: string;
  role: string;
  state: string;
  progress?: JoinViewModel["peers"][number]["progress"];
}

/** One item, and its agent when this device runs it. A master sees items without agents. */
export interface TuiEntry {
  key: string;
  /** The peer the item is assigned to. */
  peerId: string;
  item: NonNullable<JoinViewModel["item"]>;
  /** The item's protocol state as the master tracks it, when there is no local agent. */
  itemState?: string;
  agent: JoinViewModel["agent"];
  /** Already redacted and control-stripped by the producer. */
  tail: string;
  submit?: JoinViewModel["submit"];
}

export interface TuiSnapshot {
  header: { session: string; device: string; role: string };
  peers: TuiPeer[];
  entries: TuiEntry[];
}

type Row = { text: string; entry: string | null };

/**
 * State and frame layout without any I/O, so frames can be asserted line by line.
 * {@link TuiJoinView} and `skep ui` drive it through a {@link Screen}.
 */
export class TuiModel {
  snapshot: TuiSnapshot = {
    header: { session: "-", device: "-", role: "-" },
    peers: [],
    entries: [],
  };
  selected: string | null = null;
  /** Items whose submit choice is waiting on the human. */
  readonly pendingSubmit = new Set<string>();
  /** The PTY item waiting for `a` to take the terminal. */
  pendingAttach: string | null = null;
  host: CodeHostKind = "github";
  message = "";
  beat = 0;
  glyphs: Glyphs = "unicode";

  animating(): boolean {
    return this.snapshot.peers.some(
      (peer) => peer.progress?.phase === "working" || peer.progress?.phase === "blocked",
    );
  }

  set(snapshot: TuiSnapshot): void {
    this.snapshot = snapshot;
    if (this.selected === null || !snapshot.entries.some((e) => e.key === this.selected)) {
      this.selected = snapshot.entries[0]?.key ?? null;
    }
  }

  current(): TuiEntry | null {
    return this.snapshot.entries.find((e) => e.key === this.selected) ?? null;
  }

  move(delta: number): void {
    const { entries } = this.snapshot;
    if (entries.length === 0) return;
    const at = entries.findIndex((e) => e.key === this.selected);
    const next = Math.min(entries.length - 1, Math.max(0, at + delta));
    this.selected = entries[next]?.key ?? this.selected;
  }

  /** What `a`/Enter would do for the selected entry, or null when attaching is not possible. */
  attachKind(entry: TuiEntry | null = this.current()): "pty" | "herdr" | null {
    if (entry === null || entry.agent === null) return null;
    if (entry.agent.view === "pty" && this.pendingAttach === entry.key) return "pty";
    const live = entry.agent.state === "running" || entry.agent.state === "blocked";
    if (entry.agent.view === "herdr" && live && entry.agent.focusCommand !== undefined) {
      return "herdr";
    }
    return null;
  }

  prLabel(): "pr" | "mr" {
    return this.host === "gitlab" ? "mr" : "pr";
  }

  /** Only the keys that do something right now. */
  footerKeys(): string[] {
    const keys: string[] = [];
    const entry = this.current();
    if (this.snapshot.entries.length > 1) keys.push("↑↓ select");
    if (this.attachKind(entry) !== null) keys.push("a/enter attach");
    if (entry !== null && this.pendingSubmit.has(entry.key)) {
      keys.push(`p ${this.prLabel()}`, "u push", "n none", "s skip");
    }
    keys.push("q quit");
    return keys;
  }

  frame(columns: number, rows: number): Line[] {
    if (rows < MIN_ROWS) {
      return [`terminal too small: ${columns}x${rows}, need at least ${MIN_ROWS} rows`];
    }
    const { header } = this.snapshot;
    const lines: Line[] = [
      {
        text: ` skep  session ${header.session}  device ${header.device}  role ${header.role}`,
        style: "inverse",
      },
      { text: "Peers", style: "bold" },
    ];

    const list = this.listRows();
    if (list.length === 0) lines.push("  (no peers yet)");
    const at = list.findIndex((r) => r.entry !== null && r.entry === this.selected);
    const start = Math.max(0, Math.min(at - MAX_LIST_ROWS + 1, list.length - MAX_LIST_ROWS));
    for (const row of list.slice(Math.max(0, start), Math.max(0, start) + MAX_LIST_ROWS)) {
      const mark = row.entry !== null && row.entry === this.selected;
      lines.push(mark ? { text: `> ${row.text}`, style: "inverse" } : `  ${row.text}`);
    }
    if (list.length > MAX_LIST_ROWS) lines.push(`  (${list.length} rows, ↑↓ to scroll)`);

    lines.push("");
    const entry = this.current();
    lines.push(...this.detail(entry));
    if (this.message !== "") lines.push(this.message);

    lines.push({ text: "Output", style: "bold" });
    const footer: Line = { text: ` ${this.footerKeys().join("  ")}`, style: "inverse" };
    const room = rows - lines.length - 1;
    const tail = entry === null || entry.tail === "" ? [] : entry.tail.split("\n");
    const shown = room > 0 ? tail.slice(-room) : [];
    lines.push(...shown.map((line) => `  ${line}`));
    while (lines.length < rows - 1) lines.push("");
    lines.push(footer);
    return lines;
  }

  private listRows(): Row[] {
    const { peers, entries } = this.snapshot;
    const out: Row[] = [];
    const known = new Set(peers.map((p) => p.peerId));
    for (const peer of peers) {
      const own = entries.filter((e) => e.peerId === peer.peerId);
      const who = `${peer.device}  ${peer.role}`;
      const progress = peer.progress;
      if (progress !== undefined) {
        const label =
          progress.phase === "done" && progress.failed > 0
            ? `done (${progress.failed} failed)`
            : progress.phase;
        const summary = printable(progress.summary);
        out.push({
          text: `${who}  ${beeLane(progress.phase, this.beat, this.glyphs)}  [${progressBar(progress.percent, this.glyphs)}] ${String(progress.percent).padStart(3)}%  ${progress.done}/${progress.total}  ${label}${summary === "" ? "" : `  ${summary}`}`,
          entry: null,
        });
      } else if (own.length === 0) out.push({ text: `${who}  ${peer.state}`, entry: null });
      for (const entry of own) out.push({ text: `${who}  ${entryLine(entry)}`, entry: entry.key });
    }
    for (const entry of entries.filter((e) => !known.has(e.peerId))) {
      out.push({ text: `${entry.peerId}  ${entryLine(entry)}`, entry: entry.key });
    }
    return out;
  }

  private detail(entry: TuiEntry | null): string[] {
    if (entry === null) return ["Item   none yet", "Agent  -"];
    const { item, agent } = entry;
    const lines = [`Item   ${item.itemId} (epoch ${item.epoch}, ${item.repo}): ${item.title}`];
    if (agent === null) {
      lines.push(`Agent  runs on its device; item ${entry.itemState ?? "unknown"}`);
    } else {
      lines.push(`Agent  ${agent.cli}  view ${agent.view}  ${agent.state}`);
      if (agent.state === "blocked") lines.push("       answer in the agent's own view (a)");
      if (this.pendingAttach === entry.key) {
        lines.push("       ready: press a to give the agent this terminal");
      }
      if (agent.view === "herdr" && agent.focusCommand !== undefined) {
        lines.push(`       watch: ${agent.focusCommand.join(" ")}`);
      }
    }
    const outcome = entry.submit?.outcome;
    if (this.pendingSubmit.has(entry.key)) {
      lines.push(`Submit p ${this.prLabel()} / u push / n none / s skip?`);
    } else if (outcome !== undefined) {
      const url = outcome.url === undefined ? "" : ` ${outcome.url}`;
      lines.push(`Submit ${outcome.method} ${outcome.state}${url}`);
    } else if (entry.submit !== undefined) {
      lines.push(`Submit policy ${entry.submit.policy}`);
    }
    return lines;
  }
}

function entryLine(entry: TuiEntry): string {
  const { item, agent } = entry;
  const id = `${item.itemId} e${item.epoch}`;
  if (agent === null) return `${id}  ${entry.itemState ?? "unknown"}`;
  return `${id}  ${agent.cli}/${agent.view}  ${agent.state}`;
}

// ---------------------------------------------------------------------------------------------
// The `JoinView` for `skep session join --ui`.

export interface TuiOptions {
  io: ScreenIo;
  hooks?: ProcessHooks;
  /** The device's code host; GitLab offers `mr` in place of `pr`. Awaited before a choice. */
  host?: CodeHostKind | Promise<CodeHostKind>;
  /** Runs a herdr `focus` command (argv, never a shell string). */
  runFocus?(argv: readonly string[]): Promise<void>;
  /** The human pressed `q`/Ctrl-C or a signal arrived; the terminal is already restored. */
  onQuit?(reason: "key" | "signal"): void;
  session?: string;
  clock?: Clock;
  animate?: boolean;
  glyphs?: Glyphs;
}

/** Shared screen + model + key handling for both the join view and `skep ui`. */
export class Tui {
  readonly model = new TuiModel();
  readonly screen: Screen;
  private readonly submitWaiters = new Map<string, (choice: SubmitChoice) => void>();
  private attachWaiter: (() => void) | null = null;
  private ticker: AbortController | null = null;
  /** Settles once the code host is known (or could not be read; then `pr` is offered). */
  readonly hostReady: Promise<void>;

  constructor(private readonly opts: TuiOptions) {
    this.model.glyphs = opts.glyphs ?? "unicode";
    this.screen = new Screen(
      opts.io,
      {
        onKey: (key) => this.guard(() => this.onKey(key)),
        onResize: () => this.guard(() => this.render()),
        onSignal: () => this.quit("signal"),
      },
      opts.hooks,
    );
    const host = opts.host ?? "github";
    if (typeof host === "string") {
      this.model.host = host;
      this.hostReady = Promise.resolve();
    } else {
      this.hostReady = host.then(
        (value) => {
          this.model.host = value;
        },
        (error: unknown) => {
          this.model.message = `could not read the code host (${errorMessage(error)}); offering pr`;
        },
      );
    }
  }

  start(): void {
    this.screen.start();
    this.render();
  }

  render(): void {
    const { columns, rows } = this.screen.size();
    this.screen.draw(this.model.frame(columns, rows));
    this.maybeTick();
  }

  /** Runs `fn`; on a throw the terminal is restored before the error propagates. */
  guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** Resolves with the human's choice for `key`; null when they skip or the view closes. */
  askSubmit(key: string): Promise<SubmitChoice> {
    if (this.screen.isClosed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.submitWaiters.set(key, resolve);
      this.model.pendingSubmit.add(key);
      // Bring the question on screen unless the human is already answering another one.
      if (!this.model.pendingSubmit.has(this.model.selected ?? "")) this.model.selected = key;
      this.render();
    });
  }

  /** Resolves once the human pressed `a` and the screen gave the terminal away. */
  waitForAttach(key: string): Promise<void> {
    if (this.screen.isClosed) return Promise.resolve();
    return new Promise((resolve) => {
      this.attachWaiter = resolve;
      this.model.pendingAttach = key;
      this.model.selected = key;
      this.render();
    });
  }

  resume(): void {
    this.screen.resume();
    this.render();
  }

  close(): void {
    this.ticker?.abort();
    this.screen.close();
    for (const [key, resolve] of this.submitWaiters) {
      this.model.pendingSubmit.delete(key);
      resolve(null);
    }
    this.submitWaiters.clear();
    // The terminal is free now; a waiting PTY run may take it (the join aborts it when closing).
    this.attachWaiter?.();
    this.attachWaiter = null;
  }

  private maybeTick(): void {
    if (
      this.opts.animate === false ||
      !this.model.animating() ||
      this.screen.isClosed ||
      this.ticker !== null
    )
      return;
    const controller = new AbortController();
    this.ticker = controller;
    const tick = async (): Promise<void> => {
      try {
        for (;;) {
          try {
            await (this.opts.clock ?? systemClock).sleep(TICK_MS, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            throw error;
          }
          if (!this.model.animating() || this.screen.isClosed) return;
          this.model.beat += 1;
          if (this.screen.isActive) this.guard(() => this.render());
        }
      } finally {
        this.ticker = null;
      }
    };
    void tick().catch((error: unknown) =>
      this.guard(() => {
        throw error;
      }),
    );
  }

  private quit(reason: "key" | "signal"): void {
    this.close();
    this.opts.onQuit?.(reason);
  }

  private onKey(key: Key): void {
    const model = this.model;
    if (key.name === "quit") {
      this.quit("key");
      return;
    }
    if (key.name === "up" || key.name === "down") {
      model.move(key.name === "up" ? -1 : 1);
      this.render();
      return;
    }
    const entry = model.current();
    if (key.name === "enter" || (key.name === "char" && key.char === "a")) {
      this.attach(entry);
      return;
    }
    if (key.name !== "char" || entry === null || !model.pendingSubmit.has(entry.key)) return;
    const choices: Record<string, SubmitChoice> = {
      p: model.prLabel(),
      u: "push",
      n: "none",
      s: null,
    };
    if (!(key.char in choices)) return;
    const resolve = this.submitWaiters.get(entry.key);
    this.submitWaiters.delete(entry.key);
    model.pendingSubmit.delete(entry.key);
    model.message = "";
    this.render();
    resolve?.(choices[key.char] ?? null);
  }

  private attach(entry: TuiEntry | null): void {
    const kind = this.model.attachKind(entry);
    if (entry === null || kind === null) return;
    if (kind === "pty") {
      const resolve = this.attachWaiter;
      this.attachWaiter = null;
      this.model.pendingAttach = null;
      this.model.message = "";
      this.screen.suspend();
      resolve?.();
      return;
    }
    const argv = entry.agent?.focusCommand ?? [];
    const command = argv.join(" ");
    this.model.message = `focusing the agent; from another terminal: ${command}`;
    this.render();
    const run = this.opts.runFocus;
    if (run === undefined) return;
    run(argv).then(
      () => undefined,
      (error: unknown) => {
        this.model.message = `focus failed (${errorMessage(error)}); run it yourself: ${command}`;
        this.render();
      },
    );
  }
}

/**
 * `JoinView` over a {@link Tui}. Items are kept by `itemId`/`epoch`, so concurrent items form the
 * agent list; this device is the peer every item belongs to.
 */
export class TuiJoinView implements JoinView {
  readonly tui: Tui;
  private readonly entries = new Map<string, TuiEntry>();
  private peers: TuiPeer[] = [];
  private lastKey: string | null = null;
  private readonly session: string;

  constructor(opts: TuiOptions) {
    this.tui = new Tui(opts);
    this.session = opts.session ?? "joined";
    this.tui.start();
  }

  update(model: JoinViewModel): void {
    this.tui.guard(() => {
      this.absorb(model);
      if (!this.tui.screen.isClosed) this.tui.render();
    });
  }

  async chooseSubmit(model: JoinViewModel): Promise<SubmitChoice> {
    const key = this.absorb(model);
    if (key === null) return null;
    // The p label (pr or mr) must be right before the question is shown.
    await this.tui.hostReady;
    return this.tui.askSubmit(key);
  }

  suspend(): Promise<void> {
    // `runPty` reports "running" just before it asks for the terminal.
    const key = this.lastKey;
    if (key === null) {
      this.tui.screen.suspend();
      return Promise.resolve();
    }
    return this.tui.waitForAttach(key);
  }

  resume(): void {
    this.tui.guard(() => this.tui.resume());
  }

  close(): void {
    this.tui.close();
  }

  private absorb(model: JoinViewModel): string | null {
    this.peers = model.peers;
    const self = model.peers[0];
    let key: string | null = null;
    if (model.item !== null) {
      key = `${model.item.itemId}-e${model.item.epoch}`;
      this.entries.set(key, {
        key,
        peerId: self?.peerId ?? "this device",
        item: model.item,
        agent: model.agent,
        tail: model.tail,
        submit: model.submit,
      });
      this.lastKey = key;
    }
    this.tui.model.set({
      header: {
        session: this.session,
        device: self?.device ?? "-",
        role: self?.role ?? "-",
      },
      peers: this.peers,
      entries: [...this.entries.values()],
    });
    return key;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
