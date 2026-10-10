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
  AGENT_VIEWS,
  type AgentCli,
  type AgentView,
  type ControlEndpoint,
  checkIntent,
  fetchSessionStatus,
  fetchSessionStatusAt,
  type JoinFlow,
  type JoinFlowOptions,
  type JoinView,
  type JoinViewModel,
  joinSessionFlow,
  type MasterFlow,
  readControlEndpoint,
  renderSessionStatus,
  type SessionCliContext,
  type SessionStatus,
  selectAgentView,
  startMasterFlow,
  submitIntentAt,
} from "../commands/session.js";
import { CliError } from "../output.js";
import { createTheme, detectColorLevel, detectScheme } from "../theme.js";
import { detectGlyphs, type ProcessHooks, Screen, type ScreenIo, TICK_MS } from "../tui.js";
import { parseFlags } from "./flags.js";
import { backspace, decodeShellKeys, insertText, menuQuery, type ShellKey } from "./input.js";
import { JOIN_USAGE, parseJoinArgs } from "./join-args.js";
import { ShellModel, type ShellPeer, type ShellTone } from "./model.js";
import {
  type ExternalMaster,
  explainReason,
  type IntentRoute,
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

/** Lines PgUp/PgDn move the scrollback. */
const PAGE_LINES = 10;
const SUBMIT_CHOICES = ["pr", "mr", "push", "none"] as const;
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
  private agentCli: AgentCli | null = null;
  private readonly questions: Question[] = [];
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

  private readonly onData = (chunk: Buffer | string): void => {
    for (const key of decodeShellKeys(chunk)) this.guard(() => this.onKey(key));
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
    );
    this.commands = this.buildCommands();
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
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

  /** Leaves the session (if any), restores the terminal, and ends {@link run}. */
  quit(): Promise<void> {
    this.quitting ??= this.shutdown();
    return this.quitting;
  }

  // -------------------------------------------------------------------------------------------
  // Keys.

  private onKey(key: ShellKey): void {
    const model = this.model;
    if (key.name !== "interrupt") this.interruptArmed = false;
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
        }
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
        model.scroll = Math.min(model.scroll + PAGE_LINES, model.scrollback.length);
        break;
      case "pageDown":
        model.scroll = Math.max(0, model.scroll - PAGE_LINES);
        break;
      default:
        return;
    }
    this.refreshMenu();
    this.render();
  }

  private onEnter(): void {
    const selected = this.selectedMenuCommand();
    if (selected !== null && selected.argsRequired === true) {
      this.acceptMenu();
      return;
    }
    const text = selected === null ? this.model.input : `/${selected.name}`;
    this.model.input = "";
    this.model.scroll = 0;
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
    if (args === "") return { type: "error", message: "usage: /intent <text>" };
    return this.sendIntent(args);
  }

  private async sendIntent(text: string): Promise<SlashResult> {
    const route = this.session.intentRoute();
    if (route.kind === "refused") return { type: "error", message: route.message };
    try {
      let intentId: string;
      if (route.kind === "own") {
        // The shell owns the master: no detour through session.json and the control port.
        checkIntent(text, undefined);
        ({ intentId } = await route.master.handle.submitIntent(text));
      } else {
        const sent = await this.sendExternalIntent(route.external, text);
        if (sent.type === "error") return sent;
        intentId = sent.intentId;
      }
      return { type: "ok", message: `intent ${intentId} routed: ${text}` };
    } catch (error) {
      if (isNoMatch(error)) {
        const status = await this.freshStatus(route);
        const repos = [status?.repo ?? "?"];
        return {
          type: "error",
          message: status === null ? errorMessage(error) : noMatchText(status, repos),
        };
      }
      throw error;
    } finally {
      this.sync();
    }
  }

  /**
   * An intent for the master in another process that the shell displays, sent to exactly the
   * endpoint (and token) it was discovered at. If `session.json` now names another master, or the
   * shown one is gone, nothing is sent: the shell re-discovers and says what it shows now.
   */
  private async sendExternalIntent(
    shown: ExternalMaster,
    text: string,
  ): Promise<{ type: "ok"; intentId: string } | { type: "error"; message: string }> {
    const published = await readControlEndpoint(this.ctx).catch(() => null);
    if (published === null || !sameEndpoint(published, shown.endpoint)) {
      return this.externalChanged(shown);
    }
    try {
      const { intentId } = await submitIntentAt(shown.endpoint, text);
      return { type: "ok", intentId };
    } catch (error) {
      // A replacement master on the same port rejects the old token; a gone one does not answer.
      if (
        error instanceof CliError &&
        (error.code === "bad_token" || error.code === "session_unreachable")
      ) {
        return this.externalChanged(shown);
      }
      throw error;
    }
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
      const joined = view.join === null ? "" : `\nthis shell is also joined as ${view.join.peerId}`;
      return { type: "ok", message: `${renderSessionStatus(own.handle.status())}${joined}` };
    }
    if (view.mode === "joined" || view.mode === "joining")
      return { type: "ok", message: this.joinStatus() };
    // No own flow: a master in another process on this device is the only other truth.
    await this.probeExternal();
    const status = this.session.externalStatus;
    if (status === null) {
      return { type: "ok", message: "no session on this device — /start a master or /join one" };
    }
    return {
      type: "ok",
      message: `master runs in another process on this device\n${renderSessionStatus(status)}`,
    };
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
        usage: "[--listen host:port] [--repo name] [--yes]",
        run: (_ctx, args) => this.startCommand(args),
      },
      {
        name: "join",
        description: "join a session (same machine or --host)",
        usage: "[<code>] [<host:port>|--host host:port] [--role role] [--agent view]",
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
    const flags = parseFlags(args, ["listen", "repo", "device"], ["yes"]);
    const { listen, repo, device } = flags.values;
    const flow = await startMasterFlow(this.ctx, {
      ...(listen === undefined ? {} : { listen }),
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
        this.log(`join code: ${code}${expiry(expiresAtMs)}`, "event");
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
    const code = flow.joinCode ?? "none";
    return {
      type: "ok",
      message:
        `session master listening on ${flow.listen} (repo ${flow.repo})\n` +
        `join code: ${code}${expiry(flow.joinCodeExpiresAtMs)}\n` +
        `on another device: skep → /join ${code} --host ${flow.listen}\n` +
        "intents need at least one joined peer working on the same repo",
    };
  }

  /** Master protocol events → scrollback. Footer-only changes (progress) just redraw. */
  private masterEvent({ kind, message }: { kind: string; message: string }): void {
    switch (kind) {
      case "progress":
        break;
      case "left": {
        // `Peer peer-2 (mac) left: heartbeat_timeout` → explain the reason, say how to rejoin.
        const at = message.lastIndexOf(": ");
        const text =
          at < 0 ? message : `${message.slice(0, at + 2)}${explainReason(message.slice(at + 2))}`;
        const code = this.session.ownMaster?.joinCode ?? "<code>";
        this.log(`${text}\nit can rejoin with the current code: /join ${code}`, "error");
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
      return { type: "error", message: `already joined (${busy.target}); /quit to leave` };
    }
    if (this.session.joinBusy) return { type: "error", message: "a join is already in progress" };
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
    const requested = parsed.agent;
    if (requested !== undefined && !AGENT_VIEWS.includes(requested as AgentView)) {
      return { type: "error", message: `--agent must be ${AGENT_VIEWS.join(", ")}` };
    }
    const options: JoinFlowOptions = {
      code,
      role: parsed.role ?? "coding",
      ...(host === undefined ? {} : { host }),
      ...(parsed.repo === undefined ? {} : { repo: parsed.repo }),
      ...(parsed.device === undefined ? {} : { device: parsed.device }),
      ...this.agentOptions(requested as AgentView | undefined),
    };
    const generation = this.session.beginJoin(host ?? "this device's master");
    this.sync();
    const view = new ShellJoinView(this, generation);
    let flow: JoinFlow;
    try {
      flow = await joinSessionFlow(this.ctx, options, {
        say: (_data, human) => {
          const text = human();
          if (text !== "") this.log(text, "event");
        },
        ask: (question) => this.ask(question.trim()),
        warn: (message) => this.log(`skep: ${message}`, "error"),
        createView: () => view,
      });
    } catch (error) {
      this.session.joinFailed(generation);
      this.sync();
      // The join is gone, but a master in another process may still run: find it again.
      void this.probeExternal();
      throw error;
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

  /** `--agent` wins; a CLI chosen with /agent runs natively so the terminal stays the shell's. */
  private agentOptions(requested: AgentView | undefined): Pick<JoinFlowOptions, "agent" | "cli"> {
    if (requested !== undefined) {
      return { agent: requested, ...(this.agentCli === null ? {} : { cli: this.agentCli }) };
    }
    if (this.agentCli === null) return {};
    const view = selectAgentView(undefined, this.ctx.env);
    return { agent: view === "dry" ? "native" : view, cli: this.agentCli };
  }

  private joinEnded(flow: JoinFlow, reason: string): void {
    if (!this.session.joinEnded(flow)) return;
    const rejoin =
      this.quitting === null && reason !== "sub_closed"
        ? "\nthe join code is single-use: /join again with the master's current code"
        : "";
    this.log(`left the session (${explainReason(reason)})${rejoin}`, "event");
    this.sync();
    // A self-join of a master in another process can drop while that master lives on.
    void this.probeExternal();
  }

  private agentCommand(args: string): SlashResult {
    const name = args.trim();
    if (name === "") {
      return {
        type: "ok",
        message: `agent: ${this.agentCli ?? "from AGENT.md (dry unless SKEP_SESSION_EXEC=1)"}`,
      };
    }
    if (!AGENT_ORDER.includes(name as AgentCli)) {
      return { type: "error", message: `/agent takes ${AGENT_ORDER.join(", ")}` };
    }
    this.agentCli = name as AgentCli;
    const note = this.session.ownJoin === null ? "" : " (applies from the next /join)";
    return { type: "ok", message: `session items will run ${name}${note}` };
  }

  // -------------------------------------------------------------------------------------------
  // Questions (join prompts, submit choices) take the input box one at a time.

  ask(question: string): Promise<string | null> {
    if (this.quitting !== null) return Promise.resolve(null);
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

  log(text: string, tone: ShellTone = "info"): void {
    this.model.append(text, tone);
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
    const problems: string[] = [];
    const join = this.session.ownJoin;
    const master = this.session.ownMaster;
    if (join !== null) await join.close().catch((error) => problems.push(errorMessage(error)));
    if (master !== null) await master.close().catch((error) => problems.push(errorMessage(error)));
    this.ticker?.abort();
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
    for (const line of this.newTailLines(key, model.tail, terminal)) {
      this.shell.log(`${item.itemId} │ ${line}`, "muted");
    }
  }

  async chooseSubmit(): Promise<"pr" | "mr" | "push" | "none" | null> {
    const answer = (await this.shell.ask("submit this item? [pr/mr/push/none/skip]"))?.trim() ?? "";
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
