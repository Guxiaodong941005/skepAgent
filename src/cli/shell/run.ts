/**
 * `skep` with no subcommand: the unified shell (docs/plans/unified-tui-shell.md).
 *
 * One screen for everything Skep does on this device: a header, a scrollback of session events,
 * an input box with `/` commands, and the bee footer of peer progress under it. Slash commands
 * call the same session flows as `skep session start|join|intent|status` (§4.1 dispatch rule);
 * nothing here spawns `skep` or hands the terminal to an agent's own TUI (§5). Only a PTY item
 * run suspends the screen, exactly as `session join --ui` does.
 */

import os from "node:os";
import { type Clock, isoUtc, systemClock } from "../../util/clock.js";
import { AGENT_ORDER } from "../commands/agent-tui.js";
import {
  type AgentCli,
  type ControlEndpoint,
  checkIntent,
  clearStaleSessionFile,
  fetchSessionStatus,
  fetchSessionStatusAt,
  formatJoinPaste,
  INTENT_OUTCOME_UNKNOWN,
  type JoinFlow,
  type JoinFlowOptions,
  type JoinView,
  type JoinViewModel,
  joinSessionFlow,
  loadAgentSetting,
  type MasterFlow,
  readControlEndpoint,
  type SessionCliContext,
  type SessionStatus,
  saveAgentSetting,
  sessionStatusSections,
  startedText,
  startMasterFlow,
  submitIntentAt,
  undoItem,
  undoText,
  writeLastError,
} from "../commands/session.js";
import { CliError } from "../output.js";
import { createTheme, detectColorLevel, detectScheme } from "../theme.js";
import { detectGlyphs, type ProcessHooks, Screen, type ScreenIo, TICK_MS } from "../tui.js";
import { parseFlags, quoteSlashWord } from "./flags.js";
import {
  backspace,
  ESCAPE_TIMEOUT_MS,
  insertText,
  menuQuery,
  type ShellKey,
  ShellKeyDecoder,
} from "./input.js";
import { JOIN_USAGE, parseJoinArgs } from "./join-args.js";
import { ShellModel, type ShellPeer, type ShellTone } from "./model.js";
import {
  type ExternalMaster,
  explainReason,
  type IntentRoute,
  joinFailureText,
  noMatchText,
  QUIET_AFTER_MS,
  SessionController,
} from "./session-controller.js";
import {
  findCommand,
  matchCommands,
  parseSlash,
  type ShellCtx,
  type SlashCommand,
  type SlashResult,
} from "./slash.js";

export { parseFlags } from "./flags.js";

/** Rows one mouse wheel notch scrolls (SGR mouse reports; alternate-scroll sends arrows). */
const WHEEL_ROWS = 3;
const SUBMIT_CHOICES = ["commit", "push", "pr", "mr", "none"] as const;
/** A master in another process is re-read every this many ticks (2 s at 250 ms). */
const EXTERNAL_POLL_TICKS = 8;
/** A live master answers `status` well within this; discovery must not stall the ticker. */
const PROBE_TIMEOUT_MS = 2_000;

export type ShellCliContext = SessionCliContext & {
  /** Terminal streams (default: the process's). Tests pass a fake stdin and a fixed size. */
  shellIo?: ScreenIo;
  shellHooks?: ProcessHooks;
  clock?: Clock;
  hostname?: () => string;
};

/** Opens the shell and resolves once the human left it (`/quit`, Ctrl-D, a signal). */
export async function runShell(ctx: ShellCliContext): Promise<void> {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (ctx.shellIo === undefined && !tty) {
    throw new CliError(
      "not_a_tty",
      "skep needs an interactive terminal; scripts use `skep session start|join|...`",
    );
  }
  await new Shell(ctx).run();
}

interface Question {
  text: string;
  resolve(answer: string | null): void;
}

interface Picker {
  peers: ShellPeer[];
  resolve(peers: ShellPeer[] | null): void;
}

const REPO_FLAG = /(^|\s)--repo(?:=|\s+)(?:"((?:\\["\\]|[^"\\])*)"|((?!--|")\S+))(?=\s|$)/g;

/**
 * `/intent [--repo <name>]... <text>`: `--repo` may appear anywhere and repeat; the rest of the
 * line, spacing kept, is the intent text. Free text never goes through here (INTENT-PEER).
 */
export function parseIntentArgs(args: string): { text: string; repos?: string[] } {
  const repos: string[] = [];
  const text = args
    .replace(REPO_FLAG, (_match, _lead: string, quoted: string | undefined, bare: string) => {
      const repo = quoted === undefined ? bare : quoted.replace(/\\(["\\])/g, "$1");
      if (repo === "") throw new CliError("usage", "--repo needs a value");
      repos.push(repo);
      // The whitespace after the value stays, so the words around the flag stay apart.
      return "";
    })
    .trim();
  if (/(^|\s)--repo(=|\s|$)/.test(text)) throw new CliError("usage", "--repo needs a value");
  return repos.length === 0 ? { text } : { text, repos: [...new Set(repos)] };
}

/** The shell's controller: keys → model, slash commands → session flows, flows → scrollback. */
export class Shell {
  readonly model = new ShellModel();
  /** The only session state in the shell; the model is a copy of its snapshot. */
  readonly session = new SessionController();
  readonly commands: SlashCommand[];
  private readonly screen: Screen;
  private readonly io: ScreenIo;
  private readonly clock: Clock;
  private readonly animate: boolean;
  private readonly questions: Question[] = [];
  private picker: Picker | null = null;
  private ticker: AbortController | null = null;
  private ticks = 0;
  private listening = false;
  /** Ctrl-C on an empty input arms; a second one quits. */
  private interruptArmed = false;
  /** Esc closed the menu; it stays closed until the draft changes. */
  private menuDismissed = false;
  private quitting: Promise<void> | null = null;
  private finish: () => void = () => {};
  private readonly finished: Promise<void>;
  /** Commands run one at a time, in the order they were entered. */
  private queue: Promise<void> = Promise.resolve();
  private cleaning: Promise<SlashResult> | null = null;
  /** Releases the `/join` dispatch waiting on a handshake that `/clean` cancelled. */
  private cancelJoin: (() => void) | null = null;

  private readonly decoder = new ShellKeyDecoder();
  /** Cancels the wait that turns a held partial escape sequence into an Esc key. */
  private escapeWait: AbortController | null = null;

  private readonly onData = (chunk: Buffer | string): void => {
    this.escapeWait?.abort();
    this.escapeWait = null;
    for (const key of this.decoder.push(chunk)) this.guard(() => this.onKey(key));
    if (this.decoder.pending) this.awaitEscape();
  };

  constructor(private readonly ctx: ShellCliContext) {
    this.io = ctx.shellIo ?? { stdin: process.stdin, stdout: process.stdout };
    this.clock = ctx.clock ?? systemClock;
    this.animate = ctx.env.SKEP_TUI_ANIMATE !== "0";
    this.model.glyphs = detectGlyphs(ctx.env);
    this.model.header = {
      device: (ctx.hostname ?? os.hostname)(),
      cwd: displayPath(ctx.cwd ?? process.cwd(), ctx.env.HOME),
      session: "no session",
    };
    this.screen = new Screen(
      this.io,
      {
        // Keys come through `onData`: the monitor's decoder reads `q` as quit.
        onKey: () => {},
        onResize: () => this.guard(() => this.render()),
        onSignal: () => void this.quit(),
      },
      ctx.shellHooks,
      createTheme({
        level: detectColorLevel(ctx.env, this.io.stdout.isTTY === true),
        scheme: detectScheme(ctx.env),
      }),
      { alternateScroll: true },
    );
    if (ctx.env.SKEP_TUI_MOUSE === "1") this.screen.setMouse(true);
    this.commands = this.buildCommands();
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  /** A sequence split across chunks completes with the next one; silence makes it an Esc. */
  private awaitEscape(): void {
    const wait = new AbortController();
    this.escapeWait = wait;
    this.clock.sleep(ESCAPE_TIMEOUT_MS, wait.signal).then(
      () => {
        if (this.escapeWait !== wait) return;
        this.escapeWait = null;
        for (const key of this.decoder.flush()) this.guard(() => this.onKey(key));
      },
      // Aborted: more bytes arrived and completed (or replaced) the sequence.
      () => undefined,
    );
  }

  run(): Promise<void> {
    this.screen.start();
    this.listen();
    this.sync();
    void this.probeExternal();
    return this.finished;
  }

  /** What Enter does with a line: answer a question, run a slash command, or send an intent. */
  submit(text: string): Promise<void> {
    // `/clean` also works at a prompt: it answers every pending question with "no answer".
    if (this.isClean(text)) {
      this.log(`> ${text.trim()}`, "muted");
      return this.dispatch(text.trim());
    }
    const question = this.questions[0];
    if (question !== undefined) {
      this.questions.shift();
      this.log(`${question.text} ${text}`, "muted");
      this.showQuestion();
      question.resolve(text);
      return Promise.resolve();
    }
    const line = text.trim();
    if (line === "") return Promise.resolve();
    this.log(`> ${line}`, "muted");
    const run = this.queue.then(() => this.dispatch(line));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * `/clean` (or `/clear`) runs at once, outside the queue and ahead of a pending question: a
   * `/join` stuck in its handshake holds the queue, and `/clean` is how that join ends.
   */
  private isClean(text: string): boolean {
    const slash = parseSlash(text);
    return slash !== null && findCommand(this.commands, slash.name)?.name === "clean";
  }

  /** Leaves the session (if any), restores the terminal, and ends {@link run}. */
  quit(): Promise<void> {
    this.quitting ??= this.shutdown();
    return this.quitting;
  }

  // -------------------------------------------------------------------------------------------
  // Keys.

  private onKey(key: ShellKey): void {
    if (key.name !== "interrupt") this.interruptArmed = false;
    if (this.picker !== null) {
      this.onPickerKey(key);
      this.render();
      return;
    }
    const model = this.model;
    switch (key.name) {
      case "text":
        model.input = insertText(model.input, key.text);
        this.menuDismissed = false;
        break;
      case "backspace":
        model.input = backspace(model.input);
        this.menuDismissed = false;
        break;
      case "up":
      case "down":
        if (model.menu.length > 0) {
          const step = key.name === "up" ? -1 : 1;
          const count = Math.min(model.menu.length, 6);
          model.menuIndex = (model.menuIndex + step + count) % count;
        } else if (this.questions.length === 0) {
          // In the alternate screen the wheel arrives as arrows (?1007h): it scrolls (§5.2).
          model.scrollBy(key.name === "up" ? 1 : -1);
        }
        break;
      case "scrollUp":
      case "scrollDown":
        model.scrollBy(key.name === "scrollUp" ? 1 : -1);
        break;
      case "wheelUp":
      case "wheelDown":
        model.scrollBy(key.name === "wheelUp" ? WHEEL_ROWS : -WHEEL_ROWS);
        break;
      case "home":
        model.scrollToTop();
        break;
      case "end":
        model.scrollToBottom();
        break;
      case "tab":
        this.acceptMenu();
        break;
      case "escape":
        this.menuDismissed = true;
        break;
      case "enter":
        this.onEnter();
        break;
      case "interrupt":
        this.onInterrupt();
        break;
      case "eof":
        if (model.input === "") void this.quit();
        return;
      case "pageUp":
        model.scrollBy(model.pageRows());
        break;
      case "pageDown":
        model.scrollBy(-model.pageRows());
        break;
      default:
        return;
    }
    this.refreshMenu();
    this.render();
  }

  private onPickerKey(key: ShellKey): void {
    const picker = this.model.picker;
    if (picker === null) return;
    const count = picker.rows.length;
    switch (key.name) {
      case "up":
      case "down":
        picker.cursor = (picker.cursor + (key.name === "up" ? -1 : 1) + count) % count;
        break;
      case "text": {
        if (!key.text.includes(" ")) break;
        const row = picker.rows[picker.cursor];
        if (row !== undefined) row.selected = !row.selected;
        break;
      }
      case "enter":
        // At least one peer must be chosen; Esc is how the intent is dropped.
        if (picker.rows.some((row) => row.selected)) this.closePicker(true);
        break;
      case "escape":
      case "interrupt":
        this.interruptArmed = false;
        this.closePicker(false);
        break;
      default:
        break;
    }
  }

  private closePicker(confirmed: boolean): void {
    const picker = this.picker;
    const rows = this.model.picker?.rows ?? [];
    this.picker = null;
    this.model.picker = null;
    picker?.resolve(
      confirmed ? picker.peers.filter((_peer, index) => rows[index]?.selected === true) : null,
    );
  }

  /** Asks which of several connected peers should take an intent; null when cancelled. */
  private pickPeers(peers: ShellPeer[]): Promise<ShellPeer[] | null> {
    if (this.quitting !== null || this.cleaning !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.picker = { peers, resolve };
      this.model.picker = {
        title: "send this intent to which peers?",
        rows: peers.map((peer) => ({
          label: `${peer.peerId}  ${peer.device}  ${peer.repo ?? "?"}`,
          selected: false,
        })),
        cursor: 0,
      };
      this.render();
    });
  }

  private onEnter(): void {
    const selected = this.selectedMenuCommand();
    if (selected !== null && selected.argsRequired === true) {
      this.acceptMenu();
      return;
    }
    const text = selected === null ? this.model.input : `/${selected.name}`;
    this.model.input = "";
    // The human just said something: show it and what follows. An empty Enter keeps the view,
    // and so does a scroll command, which would otherwise undo itself.
    if (text.trim() !== "" && !/^\/(top|bottom)\s*$/.test(text.trim())) this.model.scrollToBottom();
    this.menuDismissed = false;
    // Failures are logged into the scrollback by `dispatch`; nothing is left to report here.
    this.submit(text).catch(() => undefined);
  }

  private onInterrupt(): void {
    const model = this.model;
    if (model.input !== "") {
      model.input = "";
      return;
    }
    const question = this.questions.shift();
    if (question !== undefined) {
      this.log(`${question.text} (no answer)`, "muted");
      this.showQuestion();
      question.resolve(null);
      return;
    }
    if (this.interruptArmed) {
      void this.quit();
      return;
    }
    this.interruptArmed = true;
    this.log("press ctrl+c again or type /quit to leave", "muted");
  }

  private selectedMenuCommand(): SlashCommand | null {
    if (this.model.menu.length === 0) return null;
    return this.model.menu[this.model.menuIndex] ?? null;
  }

  /** Completes the draft to the selected command (with a space when it takes arguments). */
  private acceptMenu(): void {
    const command = this.selectedMenuCommand();
    if (command === null) return;
    const takesArgs = command.argsRequired === true || command.usage !== undefined;
    this.model.input = `/${command.name}${takesArgs ? " " : ""}`;
    this.menuDismissed = false;
  }

  private refreshMenu(): void {
    const query = this.questions.length > 0 ? null : menuQuery(this.model.input);
    const model = this.model;
    model.menu =
      query === null || this.menuDismissed
        ? []
        : matchCommands(this.commands, query, this.shellCtx());
    if (model.menuIndex >= Math.min(model.menu.length, 6)) model.menuIndex = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Commands.

  private async dispatch(line: string): Promise<void> {
    try {
      const slash = parseSlash(line);
      let result: SlashResult;
      if (slash === null) {
        result = await this.freeText(line);
      } else {
        const command = findCommand(this.commands, slash.name);
        result =
          command === null
            ? { type: "error", message: `unknown command: /${slash.name} — try /help` }
            : await command.run(this.shellCtx(), slash.args);
      }
      if (result.type === "quit") {
        await this.quit();
        return;
      }
      if (result.type === "error") this.log(result.message, "error");
      else if (result.message !== undefined) this.log(result.message);
    } catch (error) {
      this.log(errorMessage(error), "error");
    }
  }

  /** §5: free text is an intent; where it may go is the session controller's call. */
  private freeText(text: string): Promise<SlashResult> {
    return this.sendIntent(text);
  }

  private intentCommand(args: string): Promise<SlashResult> | SlashResult {
    const usage: SlashResult = {
      type: "error",
      message: "usage: /intent [--repo <name>]... <text>",
    };
    if (args === "") return usage;
    const { text, repos } = parseIntentArgs(args);
    if (text === "") return usage;
    return this.sendIntent(text, repos);
  }

  /**
   * Without `--repo`, several connected peers mean the human picks who takes the intent; the
   * picked peers' repos become the intent's repos. A lone peer needs no pick: the master routes
   * a bare intent to it (INTENT-PEER).
   */
  private async sendIntent(text: string, explicit?: string[]): Promise<SlashResult> {
    const route = this.session.intentRoute();
    if (route.kind === "refused") return { type: "error", message: route.message };
    let repos = explicit;
    const peers = this.session.snapshot().peers;
    if (repos === undefined && peers.length > 1) {
      const picked = await this.pickPeers(peers);
      if (picked === null) return { type: "ok", message: "intent cancelled" };
      const unknown = picked.filter((peer) => peer.repo === undefined);
      if (unknown.length > 0) {
        return {
          type: "error",
          message:
            `repo is unknown for ${unknown.map((peer) => peer.peerId).join(", ")}; intent was not sent\n` +
            "use /intent --repo <name> <text> to name the repo explicitly",
        };
      }
      const known = [
        ...new Set(picked.flatMap((peer) => (peer.repo === undefined ? [] : [peer.repo]))),
      ];
      repos = known;
      // A new discovery must not redirect a selection made for the previous master.
      const current = this.session.intentRoute();
      if (current.kind === "refused") return { type: "error", message: current.message };
      const sameMaster =
        route.kind === "own"
          ? current.kind === "own" && route.master.handle === current.master.handle
          : current.kind === "control" &&
            route.external.status.sessionId === current.external.status.sessionId &&
            sameEndpoint(route.external.endpoint, current.external.endpoint);
      if (!sameMaster) {
        return {
          type: "error",
          message:
            "the session master changed while choosing peers; intent was not sent — check /status and resend",
        };
      }
    }
    try {
      let intentId: string;
      if (route.kind === "own") {
        // The shell owns the master: no detour through session.json and the control port.
        checkIntent(text, repos);
        ({ intentId } = await route.master.handle.submitIntent(text, repos));
      } else {
        const sent = await this.sendExternalIntent(route.external, text, repos);
        if (sent.type === "error") return sent;
        intentId = sent.intentId;
      }
      const to = repos === undefined ? "" : ` (repo ${repos.join(", ")})`;
      return { type: "ok", message: `intent ${intentId} routed: ${text}${to}` };
    } catch (error) {
      if (isNoMatch(error)) {
        const status = await this.freshStatus(route);
        const named = repos ?? [status?.repo ?? "?"];
        return {
          type: "error",
          message: status === null ? errorMessage(error) : noMatchText(status, named),
        };
      }
      throw error;
    } finally {
      this.sync();
    }
  }

  /**
   * An intent for the master in another process that the shell displays, sent to exactly the
   * endpoint (and token) it was discovered at. When delivery is known to have failed (another
   * master is published, the endpoint refused the connection or rejected the token), the shell
   * re-discovers and says what it shows now. When the request left but no reply came back, the
   * outcome is unknown and the shell says so: resending could duplicate the work.
   */
  private async sendExternalIntent(
    shown: ExternalMaster,
    text: string,
    repos?: string[],
  ): Promise<{ type: "ok"; intentId: string } | { type: "error"; message: string }> {
    const published = await readControlEndpoint(this.ctx).catch(() => null);
    if (published === null || !sameEndpoint(published, shown.endpoint)) {
      return this.externalChanged(shown);
    }
    try {
      const { intentId } = await submitIntentAt(shown.endpoint, text, repos);
      return { type: "ok", intentId };
    } catch (error) {
      if (error instanceof CliError && error.code === INTENT_OUTCOME_UNKNOWN) {
        return this.intentOutcomeUnknown(shown, error.message);
      }
      // A replacement master on the same port rejects the old token; `session_unreachable` here
      // means the request never left this device (see `ControlConnectionError.requestSent`).
      if (
        error instanceof CliError &&
        (error.code === "bad_token" || error.code === "session_unreachable")
      ) {
        return this.externalChanged(shown);
      }
      throw error;
    }
  }

  /** The intent left this device but its reply was lost: it may or may not exist on the master. */
  private async intentOutcomeUnknown(
    shown: ExternalMaster,
    detail: string,
  ): Promise<{ type: "error"; message: string }> {
    await this.probeExternal();
    const now = this.session.externalMaster;
    const was = `${shown.status.sessionId} at ${shown.status.listen}`;
    let next: string;
    if (now !== null && sameEndpoint(now.endpoint, shown.endpoint)) {
      next = `the master is still ${was}: /status lists its intents — look for this one there`;
    } else if (now === null) {
      next = `the master (${was}) no longer answers; it may have taken the intent before it went away`;
    } else {
      next =
        `this device now shows ${now.status.sessionId} at ${now.status.listen}; ` +
        `the intent may have reached the previous master (${was})`;
    }
    return {
      type: "error",
      message:
        "no reply after the intent was sent — it may have been accepted\n" +
        `${next}\n` +
        "sending it again could start the same work twice\n" +
        `(${detail})`,
    };
  }

  private async externalChanged(
    shown: ExternalMaster,
  ): Promise<{ type: "error"; message: string }> {
    await this.probeExternal();
    const now = this.session.externalStatus;
    const was = `${shown.status.sessionId} at ${shown.status.listen}, repo ${shown.status.repo}`;
    const next =
      now === null
        ? "no session master runs on this device now"
        : `now showing ${now.sessionId} at ${now.listen}, repo ${now.repo} — check /status and resend`;
    return {
      type: "error",
      message: `the session master on this device changed (was ${was}); the intent was not sent\n${next}`,
    };
  }

  /** The routed master's status for explaining a no_match: live, never a cached snapshot. */
  private async freshStatus(route: IntentRoute): Promise<SessionStatus | null> {
    if (route.kind === "own") return route.master.handle.status();
    if (route.kind !== "control") return null;
    return fetchSessionStatusAt(route.external.endpoint, PROBE_TIMEOUT_MS).catch(() => null);
  }

  private async statusCommand(): Promise<SlashResult> {
    const view = this.session.snapshot();
    const own = this.session.ownMaster;
    if (own !== null) {
      this.logStatus(own.handle.status());
      if (view.join !== null) this.log(`this shell is also joined as ${view.join.peerId}`);
      return { type: "ok" };
    }
    if (view.mode === "joined" || view.mode === "joining")
      return { type: "ok", message: this.joinStatus() };
    // No own flow: a master in another process on this device is the only other truth.
    await this.probeExternal();
    const status = this.session.externalStatus;
    if (status === null) {
      return { type: "ok", message: "no session on this device — /start a master or /join one" };
    }
    this.log("master runs in another process on this device");
    this.logStatus(status);
    return { type: "ok" };
  }

  /**
   * `/status` promises each item's full last result (SESSION-UX §2.1): result blocks are logged
   * with a wrapping tone, failures as errors, so nothing is cut at the terminal width (R8).
   */
  private logStatus(status: SessionStatus): void {
    for (const section of sessionStatusSections(status)) {
      const tone =
        section.kind === "failed" ? "error" : section.kind === "result" ? "warn" : "info";
      this.log(section.text, tone);
    }
  }

  private joinStatus(): string {
    const view = this.session.snapshot();
    if (view.join === null) return view.label;
    const lines = [
      `joined ${view.join.target} as ${view.join.peerId} (role ${view.join.role})`,
      view.linkSilentMs === null
        ? "master link: unknown"
        : `master last heard ${Math.floor(view.linkSilentMs / 1000)}s ago`,
      "",
      view.peers.length === 0 ? "peers: none reported yet" : "peers (as relayed by the master):",
      ...view.peers.map((peer) => {
        const progress = peer.progress;
        const state =
          progress === undefined ? peer.state : `${progress.phase} ${progress.percent}%`;
        return `  ${peer.peerId}  ${peer.device}  ${peer.role}  ${state}`;
      }),
      "",
      "intents and the full status live on the master's device",
    ];
    return lines.join("\n");
  }

  private buildCommands(): SlashCommand[] {
    const live = (ctx: ShellCtx): boolean => ctx.sessionLive === true;
    return [
      {
        name: "start",
        description: "start a local session master",
        usage: "[--listen host:port] [--advertise host:port] [--repo name] [--yes]",
        run: (_ctx, args) => this.startCommand(args),
      },
      {
        name: "join",
        description: "join a session (same machine or --host)",
        usage: "<code> <host:port> [--manual]",
        run: (_ctx, args) => this.joinCommand(args),
      },
      {
        name: "status",
        description: "show peers, the join code, and intents",
        run: () => this.statusCommand(),
      },
      {
        name: "intent",
        description: "send an intent to the session master",
        usage: "<text>",
        argsRequired: true,
        visible: live,
        run: (_ctx, args) => this.intentCommand(args),
      },
      {
        name: "agent",
        description: "agent CLI for this device's session items",
        usage: `[${AGENT_ORDER.join("|")}]`,
        run: (_ctx, args) => this.agentCommand(args),
      },
      {
        name: "undo",
        description: "put back the files a session item changed in this folder",
        usage: "<item> [--force]",
        argsRequired: true,
        run: (_ctx, args) => this.undoCommand(args),
      },
      {
        name: "top",
        description: "scroll to the first line of this session's output",
        run: () => {
          this.model.scrollToTop();
          return { type: "ok" };
        },
      },
      {
        name: "bottom",
        description: "follow the newest output again",
        run: () => {
          this.model.scrollToBottom();
          return { type: "ok" };
        },
      },
      {
        name: "mouse",
        description: "wheel via mouse reporting (on) or the terminal's arrows (off)",
        usage: "[on|off]",
        run: (_ctx, args) => this.mouseCommand(args),
      },
      {
        name: "clean",
        aliases: ["clear"],
        description: "end local session(s) and clear connection state (stay in shell)",
        run: () => this.clean(),
      },
      {
        name: "help",
        description: "list commands",
        run: (ctx) => ({ type: "ok", message: this.helpText(ctx) }),
      },
      {
        name: "quit",
        aliases: ["exit"],
        description: "leave the session and the shell",
        run: () => ({ type: "quit" }),
      },
    ];
  }

  private helpText(ctx: ShellCtx): string {
    const shown = this.commands.filter((command) => command.visible?.(ctx) ?? true);
    const labels = shown.map((command) =>
      command.usage === undefined ? `/${command.name}` : `/${command.name} ${command.usage}`,
    );
    const width = Math.max(...labels.map((label) => label.length));
    return [
      ...shown.map((command, i) => `${(labels[i] ?? "").padEnd(width)}  ${command.description}`),
      "text without / is sent as an intent to this device's session master (needs a joined peer)",
      "/start: different projects select separate homes and available ports automatically",
      "/start: --listen is the address to bind, --advertise the one peers dial (default: listen)",
      "/join: the agent edits this folder directly (no worktrees, no branches); auto by default",
      "  (master drives work, submit none: edits stay in the folder); --manual confirms each",
      "  item first; --submit commit|push|pr|mr|none|ask overrides device.toml",
      "/agent: which agent CLI items run; else --agent, SKEP_AGENT_CLI, AGENT.md, or PATH",
      "scroll: PgUp/PgDn, Shift+arrows, wheel or arrows (no menu open), Home/End; End follows",
      "advanced: `skep tui` opens the raw agent TUI",
    ].join("\n");
  }

  private async startCommand(args: string): Promise<SlashResult> {
    const own = this.session.ownMaster;
    if (own !== null) {
      return {
        type: "error",
        message: `a master already runs here (code ${own.joinCode ?? "none"})`,
      };
    }
    const flags = parseFlags(args, ["listen", "advertise", "repo", "device"], ["yes"]);
    const { listen, advertise, repo, device } = flags.values;
    const flow = await startMasterFlow(this.ctx, {
      ...(listen === undefined ? {} : { listen }),
      ...(advertise === undefined ? {} : { advertise }),
      ...(repo === undefined ? {} : { repo }),
      ...(device === undefined ? {} : { device }),
      ...(flags.switches.has("yes") ? { yes: true } : {}),
      acceptJoin: async ({ device: who, address, fingerprint }) => {
        const answer = await this.ask(
          `accept ${who} from ${address} fingerprint ${fingerprint}? [y/N]`,
        );
        return answer !== null && /^\s*y(es)?\s*$/i.test(answer);
      },
      onJoinCode: (code, expiresAtMs) => {
        // A rotated code invalidates the line pasted earlier, so the new one is printed in full.
        const own = this.session.ownMaster;
        const paste =
          own === null ? "" : `\npaste: ${formatJoinPaste({ host: own.advertise, code })}`;
        this.log(`join code: ${code}${expiry(expiresAtMs)}${paste}`, "event");
        this.sync();
      },
      onEvent: (event) => this.masterEvent(event),
    });
    this.session.setMaster(flow);
    flow.closed.then(
      () => this.masterEnded(flow, "session closed"),
      (error: unknown) => this.masterEnded(flow, `session closed: ${errorMessage(error)}`),
    );
    this.sync();
    return {
      type: "ok",
      message: `${startedText(flow)}intents need at least one joined peer working on the same repo`,
    };
  }

  /**
   * Master protocol events → transcript. Footer-only changes (progress) just redraw. The shell
   * scrolls, so a result is shown whole (`full`), not the plain-CLI cap (S2).
   */
  private masterEvent(event: { kind: string; message: string; full?: string }): void {
    const { kind } = event;
    const message = event.full ?? event.message;
    switch (kind) {
      case "progress":
        break;
      case "left": {
        // `Peer peer-2 (mac) left: heartbeat_timeout` → explain the reason, say how to rejoin.
        const at = message.lastIndexOf(": ");
        const text =
          at < 0 ? message : `${message.slice(0, at + 2)}${explainReason(message.slice(at + 2))}`;
        const own = this.session.ownMaster;
        const rejoin =
          own === null || own.joinCode === null
            ? "/join <code>"
            : formatJoinPaste({ host: own.advertise, code: own.joinCode });
        this.log(`${text}\nit can rejoin with the current code: ${rejoin}`, "error");
        break;
      }
      case "join-failed":
      case "error":
        this.log(message, "error");
        break;
      case "fingerprint":
        this.log(`fingerprint ${message}`, "event");
        break;
      case "planned":
        this.log(`intent ${message} planned`, "event");
        break;
      case "joined":
        this.log(message, "event");
        break;
      case "item-result":
        // `I-4 done · mac (app) · …` with the changed files: what the peer's agent produced.
        this.log(message, "event");
        break;
      case "item-failed":
        // Uncapped and wrapped: the cause and fix are the point (SESSION-UX §3.4).
        this.log(message, "error");
        break;
      case "item-pending":
      case "intent-waiting":
        // An agent waits for a human in its pane: not finished, and the focus command matters.
        this.log(message, "warn");
        break;
      case "intent-failed":
        this.log(message, "error");
        break;
      case "intent-done":
        this.log(message, "event");
        break;
      case "result-reject":
        this.log(`result rejected ${message}`, "error");
        break;
      default:
        this.log(`${kind} ${message}`, "event");
    }
    this.sync();
  }

  private masterEnded(flow: MasterFlow, message: string): void {
    if (!this.session.masterEnded(flow)) return;
    this.log(message, "event");
    this.sync();
    void this.probeExternal();
  }

  private async joinCommand(args: string): Promise<SlashResult> {
    const busy = this.session.ownJoin;
    if (busy !== null) {
      return {
        type: "error",
        message: `already joined (${busy.target}); /clean leaves the session, /quit leaves the shell`,
      };
    }
    if (this.session.joinBusy) {
      return { type: "error", message: "a join is already in progress; /clean cancels it" };
    }
    const parsed = parseJoinArgs(args);
    let code = parsed.code;
    let host = parsed.host;
    if (code === undefined) {
      if (host !== undefined) {
        return {
          type: "error",
          message: `/join: ${host} needs the master's join code too\n${JOIN_USAGE}`,
        };
      }
      // §4.1: no code means this device's own master.
      const own = this.session.ownMaster;
      if (own !== null) {
        code = own.joinCode ?? undefined;
        host = own.listen;
      } else {
        const status = await fetchSessionStatus(this.ctx);
        code = status.joinCode ?? undefined;
        host = status.listen;
      }
      if (code === undefined) {
        return { type: "error", message: "the local master has no join code; /join <code>" };
      }
    }
    for (const note of parsed.notes ?? []) this.log(`skep: ${note}`, "warn");
    const options: JoinFlowOptions = {
      code,
      role: parsed.role ?? "coding",
      ...(host === undefined ? {} : { host }),
      ...(parsed.repo === undefined ? {} : { repo: parsed.repo }),
      ...(parsed.device === undefined ? {} : { device: parsed.device }),
      ...(parsed.submit === undefined ? {} : { submit: parsed.submit }),
      ...(parsed.manual === true ? { manual: true } : {}),
      ...(parsed.agent === undefined ? {} : { agent: parsed.agent }),
      ...(parsed.view === undefined ? {} : { view: parsed.view }),
    };
    const generation = this.session.beginJoin(host ?? "this device's master");
    this.sync();
    const view = new ShellJoinView(this, generation);
    // A handshake `/clean` cancelled may still talk; it must not reach the screen or the prompt.
    const current = (): boolean => this.session.isJoinCurrent(generation);
    const pending = joinSessionFlow(this.ctx, options, {
      say: (data, human) => {
        const text = current() ? human() : "";
        if (text !== "") this.log(text, failedItem(data) ? "error" : "event");
      },
      ask: (question) => (current() ? this.ask(question.trim()) : Promise.resolve(null)),
      warn: (message) => {
        if (current()) this.log(`skep: ${message}`, "error");
      },
      createView: () => view,
    });
    const cancel = new Promise<null>((resolve) => {
      this.cancelJoin = () => resolve(null);
    });
    let flow: JoinFlow | null;
    try {
      flow = await Promise.race([pending, cancel]);
    } catch (error) {
      this.session.joinFailed(generation);
      this.sync();
      // The join is gone, but a master in another process may still run: find it again.
      void this.probeExternal();
      const text = joinFailureText(error);
      const home = this.ctx.paths?.home;
      const log = home === undefined ? null : await writeLastError(home, text).catch(() => null);
      return { type: "error", message: log === null ? text : `${text}\nfull text: ${log}` };
    } finally {
      this.cancelJoin = null;
    }
    if (flow === null) {
      // `/clean` cancelled the handshake: the queue moves on now, and a flow that still arrives
      // is closed (its generation is no longer current, so it never becomes the shell's join).
      pending.then(
        (late) => late.close().catch(() => undefined),
        () => undefined,
      );
      return { type: "ok" };
    }
    if (this.quitting !== null || !this.session.joinStarted(generation, flow)) {
      // The shell is leaving; it no longer wants this join.
      this.session.joinFailed(generation);
      await flow.close().catch(() => undefined);
      return { type: "ok" };
    }
    flow.closed.then(
      ({ reason }) => this.joinEnded(flow, reason),
      (error: unknown) => this.joinEnded(flow, errorMessage(error)),
    );
    this.sync();
    return { type: "ok" };
  }

  private joinEnded(flow: JoinFlow, reason: string): void {
    if (!this.session.joinEnded(flow)) return;
    const rejoin =
      this.quitting === null && reason !== "sub_closed"
        ? "\nthe join code is single-use: ask the master for its current code, then\n" +
          `/join <code> ${quoteSlashWord(flow.target)}`
        : "";
    this.log(`left the session (${explainReason(reason)})${rejoin}`, "event");
    this.sync();
    // A self-join of a master in another process can drop while that master lives on.
    void this.probeExternal();
  }

  /** One `/clean` at a time; a second one while it runs just waits for the first. */
  private clean(): Promise<SlashResult> {
    if (this.cleaning === null) {
      this.cleaning = this.cleanCommand().finally(() => {
        this.cleaning = null;
      });
    }
    return this.cleaning;
  }

  /**
   * Ends every session this shell holds and clears what is left of a dead one, staying in the
   * shell (docs/plans/tui-clean.md). Another process's live master is never stopped.
   */
  private async cleanCommand(): Promise<SlashResult> {
    const cleared: string[] = [];
    const problems: string[] = [];
    for (const question of this.questions.splice(0)) question.resolve(null);
    this.model.question = null;
    this.closePicker(false);
    // A handshake still running is refused by `joinStarted`, and `joinCommand` closes its flow.
    const dropped = this.session.abortJoin();
    if (dropped !== null) {
      this.cancelJoin?.();
      cleared.push(`cancelled join of ${dropped}`);
    }
    const join = this.session.ownJoin;
    if (join !== null) {
      await join.close().catch((error) => problems.push(errorMessage(error)));
      // Ended here rather than in `joinEnded`: the shell is idle once this returns.
      this.session.joinEnded(join);
      cleared.push(`left ${join.target} as ${join.handle.peerId}`);
    }
    const master = this.session.ownMaster;
    if (master !== null) {
      await master.close().catch((error) => problems.push(errorMessage(error)));
      this.session.masterEnded(master);
      cleared.push(`stopped master on ${master.listen}`);
    }
    this.session.clearExternal();
    let liveElsewhere: string | null = null;
    try {
      const stale = await clearStaleSessionFile(this.ctx, this.clock, {
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (stale.kind === "removed") {
        const was = stale.listen === null ? "unreadable" : `master at ${stale.listen} gone`;
        cleared.push(`removed stale session.json (${was})`);
      } else if (stale.kind === "live") {
        liveElsewhere = stale.listen;
      } else if (stale.kind === "replaced") {
        // Published while /clean ran: kept and shown, like any master in another process.
        liveElsewhere = "a newly published endpoint (it started while cleaning)";
      }
    } catch (error) {
      problems.push(`session.json: ${errorMessage(error)}`);
    }
    this.sync();
    const lines: string[] = [];
    if (cleared.length > 0) lines.push(`cleared: ${cleared.join("; ")} — session idle`);
    if (liveElsewhere !== null) {
      // Shown again so intents still have somewhere to go; it is not this shell's to stop.
      await this.probeExternal();
      lines.push(
        `a session master in another process still runs at ${liveElsewhere}; ` +
          "/clean does not stop other processes — quit that shell to end it",
      );
    }
    if (lines.length === 0) lines.push("nothing to clean — no session on this device");
    // Agents edit the project folder in place: there are no worktrees or branches to remove.
    lines.push("nothing left on disk: no worktrees or session branches; edits stay in your folder");
    if (problems.length > 0) {
      return {
        type: "error",
        message: [...lines, ...problems.map((p) => `problem: ${p}`)].join("\n"),
      };
    }
    return { type: "ok", message: lines.join("\n") };
  }

  /**
   * `/agent` shows or sets this device's agent CLI. It is persisted in this project's
   * `device.toml` `[agent] cli`, so it is a real setting rather than a session-only override
   * (SESSION-UX §2.1).
   */
  private async agentCommand(args: string): Promise<SlashResult> {
    const name = args.trim();
    const file = this.ctx.paths?.deviceToml;
    if (file === undefined) return { type: "error", message: "skep home is not resolved" };
    if (name === "") {
      const join = this.session.ownJoin;
      const saved = await loadAgentSetting(file, (message) => this.log(`skep: ${message}`, "warn"));
      const current =
        join?.agent != null
          ? `this join runs ${join.agent.cli}${saved === undefined ? "" : `; saved: ${saved}`}`
          : saved !== undefined
            ? `${saved} (saved in ${file})`
            : "not set; /join uses --agent, SKEP_AGENT_CLI, AGENT.md if present, else the first of " +
              `${AGENT_ORDER.join(", ")} on PATH`;
      return {
        type: "ok",
        message: `agent: ${current}\n/agent ${AGENT_ORDER.join("|")} sets it for this project`,
      };
    }
    if (!AGENT_ORDER.includes(name as AgentCli)) {
      return { type: "error", message: `/agent takes ${AGENT_ORDER.join(", ")}` };
    }
    await saveAgentSetting(file, name as AgentCli);
    const note = this.session.ownJoin === null ? "" : " (applies from the next /join)";
    return { type: "ok", message: `session items will run ${name}${note}; saved in ${file}` };
  }

  /**
   * Full mouse reporting scrolls with the wheel in terminals that do not turn it into arrows, but
   * native selection then needs Shift (§5.2), so it is opt-in and off by default.
   */
  private mouseCommand(args: string): SlashResult {
    const value = args.trim().toLowerCase();
    if (value === "") {
      const on = this.screen.mouseReporting;
      return {
        type: "ok",
        message: on
          ? "mouse reporting is on: the wheel scrolls; hold Shift to select text — /mouse off"
          : "mouse reporting is off: the wheel scrolls as arrow keys, selection works — /mouse on",
      };
    }
    if (value !== "on" && value !== "off")
      return { type: "error", message: "usage: /mouse [on|off]" };
    this.screen.setMouse(value === "on");
    return {
      type: "ok",
      message:
        value === "on"
          ? "mouse reporting on: the wheel scrolls; hold Shift to select text"
          : "mouse reporting off: native selection is back; the wheel arrives as arrow keys",
    };
  }

  private async undoCommand(args: string): Promise<SlashResult> {
    const flags = parseFlags(args, [], ["force"]);
    const [itemId, extra] = flags.positional;
    if (itemId === undefined || extra !== undefined) {
      return { type: "error", message: "usage: /undo <item> [--force], e.g. /undo I-1" };
    }
    const outcome = await undoItem(this.ctx, itemId, {
      ...(flags.switches.has("force") ? { force: true } : {}),
    });
    return { type: "ok", message: undoText(itemId, outcome) };
  }

  // -------------------------------------------------------------------------------------------
  // Questions (join prompts, submit choices) take the input box one at a time.

  ask(question: string): Promise<string | null> {
    // While `/clean` runs, the flows it is ending may still ask: a queued manual item question is
    // released by the very answer `/clean` gives the one in front of it. Nothing is asked then.
    if (this.quitting !== null || this.cleaning !== null) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.questions.push({ text: question, resolve });
      if (this.questions.length === 1) this.showQuestion();
    });
  }

  private showQuestion(): void {
    const next = this.questions[0];
    this.model.question = next?.text ?? null;
    if (next !== undefined) this.log(next.text, "event");
    this.refreshMenu();
    this.render();
  }

  // -------------------------------------------------------------------------------------------
  // Session state → header and bee footer.

  private shellCtx(): ShellCtx {
    return { sessionLive: this.session.snapshot().live };
  }

  /** Copies the controller's snapshot into the model: header, peers, footer, slash gating. */
  sync(): void {
    const view = this.session.snapshot();
    this.model.header = { ...this.model.header, session: view.live ? view.label : "no session" };
    this.model.sessionLive = view.live;
    this.model.peers = view.peers;
    this.model.link =
      view.linkSilentMs === null ? null : linkText(view.linkSilentMs, this.model.glyphs);
    this.refreshMenu();
    this.render();
    this.maybeTick();
  }

  /** A sub roster from the join flow with `generation`; dropped once that flow is not current. */
  joinRoster(generation: number, peers: ShellPeer[]): boolean {
    if (!this.session.joinRoster(generation, peers)) return false;
    this.sync();
    return true;
  }

  /**
   * Looks for a master in another process on this device (`session.json` + a live `status`).
   * Absent or unreachable means no session; the shell's own flows always win.
   */
  private async probeExternal(): Promise<void> {
    if (this.session.ownMaster !== null || this.session.joinBusy || this.quitting !== null) return;
    // Only the newest discovery applies: an older one finishing late must not undo newer truth.
    const generation = this.session.beginProbe();
    let found: ExternalMaster | null = null;
    try {
      const endpoint = await readControlEndpoint(this.ctx);
      if (endpoint !== null) {
        found = { endpoint, status: await fetchSessionStatusAt(endpoint, PROBE_TIMEOUT_MS) };
      }
    } catch {
      // A stale file, a dead port or a bad reply all mean the same thing: nothing to attach to.
      found = null;
    }
    const before = this.session.externalMaster;
    if (!this.session.applyProbe(generation, found)) return;
    if (found !== null && (before === null || !sameEndpoint(before.endpoint, found.endpoint))) {
      const status = found.status;
      this.log(
        `a session master runs in another process on this device (${status.sessionId} at ` +
          `${status.listen}, repo ${status.repo}); intents typed here go to it`,
        "event",
      );
    } else if (before !== null && found === null) {
      this.log(`the session master at ${before.status.listen} went away`, "event");
    }
    this.sync();
  }

  /** Animation and the master's peer refresh run while a session is live. */
  private maybeTick(): void {
    if (!this.model.sessionLive || this.ticker !== null || this.quitting !== null) return;
    const controller = new AbortController();
    this.ticker = controller;
    const tick = async (): Promise<void> => {
      try {
        while (this.model.sessionLive && this.quitting === null) {
          try {
            await this.clock.sleep(TICK_MS, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            throw error;
          }
          if (this.animate && this.model.animating()) this.model.beat += 1;
          this.ticks += 1;
          if (this.session.externalStatus !== null && this.ticks % EXTERNAL_POLL_TICKS === 0) {
            await this.probeExternal();
          }
          // Presence and the master's own status are read live every tick.
          if (this.screen.isActive) this.sync();
        }
      } finally {
        if (this.ticker === controller) this.ticker = null;
      }
    };
    tick().catch((error: unknown) => this.log(`display: ${errorMessage(error)}`, "error"));
  }

  // -------------------------------------------------------------------------------------------
  // Terminal.

  log(text: string, tone: ShellTone = "info", gutter?: string): void {
    this.model.append(text, tone, gutter);
    this.render();
  }

  render(): void {
    if (!this.screen.isActive) return;
    const { columns, rows } = this.screen.size();
    this.screen.draw(this.model.frame(columns, rows));
  }

  /** A PTY agent run takes the terminal until {@link resumeScreen}. */
  suspendScreen(): void {
    this.unlisten();
    this.screen.suspend();
  }

  resumeScreen(): void {
    if (this.quitting !== null) return;
    this.screen.resume();
    this.listen();
    this.render();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.io.stdin.on("data", this.onData);
  }

  private unlisten(): void {
    if (!this.listening) return;
    this.listening = false;
    this.io.stdin.off("data", this.onData);
  }

  /** A throw while handling a key restores the terminal before it propagates. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.unlisten();
      this.screen.close();
      throw error;
    }
  }

  private async shutdown(): Promise<void> {
    this.session.invalidateProbes();
    this.log("leaving…", "muted");
    for (const question of this.questions.splice(0)) question.resolve(null);
    this.model.question = null;
    this.closePicker(false);
    const problems: string[] = [];
    const join = this.session.ownJoin;
    const master = this.session.ownMaster;
    if (join !== null) await join.close().catch((error) => problems.push(errorMessage(error)));
    if (master !== null) await master.close().catch((error) => problems.push(errorMessage(error)));
    this.ticker?.abort();
    this.escapeWait?.abort();
    this.unlisten();
    this.screen.close();
    // The terminal is the user's again; anything that went wrong while leaving is said there.
    for (const problem of problems) this.ctx.stderr.write(`skep: ${problem}\n`);
    this.finish();
  }
}

/**
 * The shell as a session `JoinView`: the roster feeds the bee footer, agent states and new tail
 * lines go to the scrollback, and a PTY run suspends the screen.
 */
export class ShellJoinView implements JoinView {
  private readonly states = new Map<string, string>();
  private readonly tails = new Map<string, { seen: string; partial: string }>();

  constructor(
    private readonly shell: Shell,
    private readonly generation: number,
  ) {}

  update(model: JoinViewModel): void {
    // A view of a join the shell no longer owns must not touch the screen (stale peer rows).
    if (!this.shell.joinRoster(this.generation, model.peers)) return;
    const { item, agent } = model;
    if (item === null) return;
    const key = `${item.itemId}-e${item.epoch}`;
    if (agent !== null) {
      const watch =
        agent.focusCommand === undefined ? "" : `; watch with: ${agent.focusCommand.join(" ")}`;
      const line = `${item.itemId}: agent ${agent.cli} (${agent.view}) ${agent.state}${watch}`;
      if (this.states.get(key) !== line) {
        this.states.set(key, line);
        this.shell.log(line, agent.state === "failed" ? "error" : "event");
      }
    }
    const terminal = agent?.state === "done" || agent?.state === "failed";
    // A finished run brings its whole local output; the 4000-character tail is only its end (S3).
    const output = model.transcript ?? model.tail;
    for (const line of this.newTailLines(key, output, terminal || model.transcript !== undefined)) {
      this.shell.log(line, "muted", `${item.itemId} │ `);
    }
  }

  async chooseSubmit(): Promise<"commit" | "pr" | "mr" | "push" | "none" | null> {
    const answer =
      (await this.shell.ask("submit this item? [commit/push/pr/mr/none/skip]"))?.trim() ?? "";
    return SUBMIT_CHOICES.find((value) => value === answer.toLowerCase()) ?? null;
  }

  async suspend(): Promise<void> {
    this.shell.suspendScreen();
  }

  resume(): void {
    this.shell.resumeScreen();
  }

  /** The shell outlives a join; it owns the screen. */
  close(): void {}

  /**
   * Complete lines of `tail` not shown yet. The tail is a sliding window, so a new one is matched
   * after the last line already shown; an unfinished last line waits unless the run ended.
   */
  private newTailLines(key: string, tail: string, flush: boolean): string[] {
    const previous = this.tails.get(key) ?? { seen: "", partial: "" };
    let text: string;
    if (tail.startsWith(previous.seen)) {
      text = previous.partial + tail.slice(previous.seen.length);
    } else {
      // Resume after the last complete line shown; the held partial line is in what follows.
      const complete = previous.seen.split("\n").slice(0, -1);
      const lastLine = complete[complete.length - 1] ?? "";
      const at = lastLine === "" ? -1 : tail.lastIndexOf(`${lastLine}\n`);
      text = at < 0 ? tail : tail.slice(at + lastLine.length + 1);
    }
    const lines = text.split("\n");
    let partial = lines.pop() ?? "";
    if (flush && partial !== "") {
      lines.push(partial);
      partial = "";
    }
    this.tails.set(key, { seen: tail, partial });
    return lines.filter((line) => line.trim() !== "");
  }
}

function linkText(silentMs: number, glyphs: string): string {
  const seconds = Math.floor(silentMs / 1000);
  if (silentMs >= QUIET_AFTER_MS) return `master quiet ${seconds}s`;
  return `master ${glyphs === "nerd" ? "♥" : "hb"} ${seconds}s`;
}

function sameEndpoint(left: ControlEndpoint, right: ControlEndpoint): boolean {
  return left.listen === right.listen && left.token === right.token;
}

/**
 * A finished item the peer's own scrollback shows as an error (it carries cause and fix): a
 * failing check, the agent's included, or a submit that failed after the agent succeeded.
 */
function failedItem(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const event = data as {
    event?: unknown;
    checks?: { status?: unknown }[];
    submit?: { state?: unknown };
  };
  return (
    event.event === "item-result" &&
    ((Array.isArray(event.checks) && event.checks.some((check) => check.status === "fail")) ||
      event.submit?.state === "failed")
  );
}

function isNoMatch(error: unknown): boolean {
  if (error instanceof CliError) return error.code === "no_match";
  return error instanceof Error && error.name === "NoMatchError";
}

function expiry(expiresAtMs: number | null): string {
  return expiresAtMs === null ? "" : ` (expires ${isoUtc(expiresAtMs)})`;
}

function displayPath(dir: string, home: string | undefined): string {
  if (home === undefined || home === "") return dir;
  if (dir === home) return "~";
  return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
