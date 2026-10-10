/**
 * Frame layout of the unified shell: header, scrollback, slash menu, input, bee footer, hint
 * (docs/plans/unified-tui-shell.md §2–§3). Visual chrome from feat/unified-tui-shell-ui;
 * controller API kept for run.ts.
 */

import type { JoinViewModel } from "../commands/session.js";
import { bold, fg, type Role, type Span } from "../theme.js";
import {
  beeLane,
  chip,
  chrome,
  column,
  displayWidth,
  fitSpans,
  type Glyphs,
  type Line,
  MIN_ROWS,
  progressBar,
  truncate,
} from "../tui.js";
import { SKEP_VERSION } from "../version.js";
import { logoLine, welcomeLines } from "./logo.js";
import { QUIET_AFTER_MS } from "./session-controller.js";
import type { SlashCommand } from "./slash.js";

export const SCROLLBACK_CAP = 1_000;
export const MAX_BEE_ROWS = 3;
export const MAX_MENU_ROWS = 6;
/** Below this the shell cannot show the input and footer, so only a notice is drawn. */
export const SHELL_MIN_ROWS = Math.min(10, MIN_ROWS);

export type ShellTone = "info" | "event" | "error" | "muted";
/** A footer row; `silentMs` is the time since the peer was last heard from, when known. */
export type ShellPeer = JoinViewModel["peers"][number] & { silentMs?: number };

export interface ShellHeader {
  device: string;
  cwd: string;
  /** e.g. `no session`, `master · code 4821-0937-5520`, `joined · peer-2`. */
  session: string;
}

const TONE_ROLES: Record<ShellTone, Role> = {
  info: "on-surface",
  event: "secondary",
  error: "error",
  muted: "on-surface-variant",
};

export class ShellModel {
  header: ShellHeader = { device: "-", cwd: "-", session: "no session" };
  scrollback: { text: string; tone: ShellTone }[] = [];
  /** Lines scrolled up from the bottom (PgUp/PgDn). */
  scroll = 0;
  input = "";
  menu: SlashCommand[] = [];
  menuIndex = 0;
  peers: ShellPeer[] = [];
  sessionLive = false;
  /** A joined shell's link to its master, e.g. `master heard 3s ago`. */
  link: string | null = null;
  glyphs: Glyphs = "nerd";
  beat = 0;
  /** A pending question takes the input; the prompt shows it. */
  question: string | null = null;
  version: string | null = SKEP_VERSION;

  /** Appends one or more lines; a multi-line text becomes several scrollback lines. */
  append(text: string, tone: ShellTone = "info"): void {
    for (const line of text.replace(/\n+$/, "").split("\n")) {
      this.scrollback.push({ text: line, tone });
    }
    if (this.scrollback.length > SCROLLBACK_CAP) {
      this.scrollback.splice(0, this.scrollback.length - SCROLLBACK_CAP);
    }
    if (this.scroll > 0) this.scroll = Math.min(this.scroll + 1, this.scrollback.length);
  }

  animating(): boolean {
    return this.peers.some((peer) => {
      const phase = peer.progress?.phase ?? peer.state;
      return phase === "working" || phase === "blocked";
    });
  }

  frame(columns: number, rows: number): Line[] {
    if (rows < SHELL_MIN_ROWS) {
      return [
        {
          spans: [
            fg(
              "error",
              `terminal too small: ${columns}x${rows}; resize to at least ${SHELL_MIN_ROWS} rows`,
            ),
          ],
        },
      ];
    }
    const g = chrome(this.glyphs);
    const sessionLabel =
      this.header.session === "no session" ? "" : this.header.session.replace(/^session\s+/i, "");
    const context =
      sessionLabel === ""
        ? ""
        : sessionLabel.startsWith("session")
          ? sessionLabel
          : `session ${sessionLabel}`;
    const info = [
      `device  ${this.header.device}`,
      `cwd  ${this.header.cwd}`,
      ...(this.sessionLive ? [`peers ${this.peers.length}`] : ["no session"]),
      ...(this.sessionLive && this.link !== null ? [this.link] : []),
    ];
    const lines: Line[] = [
      logoLine(columns, this.glyphs, context, this.version),
      { spans: [fg("on-surface-variant", `  ${info.join(g.sep)}`)] },
    ];
    const bee = this.beeRows(columns);
    const hint = this.hintLine();
    const prompt = this.question === null ? "> " : `${this.question} `;
    const input = this.inputLine(columns, prompt);
    const rule: Line = {
      spans: [fg("outline", `  ${g.rule.repeat(Math.max(0, columns - 2))}`)],
    };
    const bodyRows = Math.max(0, rows - lines.length - 1 - 1 - bee.length - 1);
    const body = this.bodyLines(bodyRows);
    const menu = bodyRows === 0 ? [] : this.menuLines().slice(-bodyRows);
    body.splice(body.length - menu.length, menu.length, ...menu);
    const out = [...lines, ...body, input, rule, ...bee, hint];
    return out.map((line) =>
      typeof line === "string"
        ? truncate(line, columns)
        : { ...line, spans: fitSpans(line.spans, columns) },
    );
  }

  private bodyLines(count: number): Line[] {
    const source: Line[] =
      this.scrollback.length === 0
        ? welcomeLines(this.glyphs)
        : this.scrollback.map((entry) => ({
            spans: [fg(TONE_ROLES[entry.tone], `  ${entry.text}`)],
          }));
    const end = Math.max(0, source.length - this.scroll);
    const visible = source.slice(Math.max(0, end - count), end);
    return [...Array<Line>(Math.max(0, count - visible.length)).fill(""), ...visible];
  }

  private menuLines(): Line[] {
    const shown = this.menu.slice(0, MAX_MENU_ROWS);
    return shown.map((command, index) => {
      const usage = command.usage === undefined ? "" : ` ${command.usage}`;
      return {
        spans: [
          { text: "  " },
          bold(`/${command.name}`, "primary"),
          fg("secondary", usage),
          fg("on-surface-variant", `  ${command.description}`),
        ],
        selected: index === this.menuIndex,
        fill: true,
      };
    });
  }

  private inputLine(columns: number, prompt: string): Line {
    const characters = [...this.input];
    const available = Math.max(0, columns - displayWidth(prompt) - 1);
    const shown = truncate(characters.join(""), available);
    return {
      spans: [
        bold(prompt, "primary"),
        { text: shown },
        { text: "_", role: "primary", inverse: true },
      ],
    };
  }

  private beeRows(columns: number): Line[] {
    if (!this.sessionLive) {
      return [{ spans: [fg("on-surface-variant", "  (no session — /start or /join)")] }];
    }
    if (this.peers.length === 0) return [{ spans: [fg("on-surface-variant", "  (no peers yet)")] }];
    const overflow = this.peers.length > MAX_BEE_ROWS;
    const shown = this.peers.slice(0, overflow ? MAX_BEE_ROWS - 1 : MAX_BEE_ROWS);
    const deviceWidth = Math.min(
      12,
      Math.max(6, ...shown.map((peer) => displayWidth(peer.device))),
    );
    const roleWidth = Math.min(10, Math.max(6, ...shown.map((peer) => displayWidth(peer.role))));
    const lines: Line[] = shown.map((peer) => {
      const progress = peer.progress;
      const phase = progress?.phase ?? "idle";
      const spans: Span[] = [
        { text: `  ${column(peer.device, deviceWidth)}  ` },
        fg("on-surface-variant", `${column(peer.role, roleWidth)}  `),
        fg("primary", `${beeLane(phase, this.beat, this.glyphs)} `),
      ];
      if (progress === undefined) {
        spans.push(chip(peer.state), { text: "  " }, ...this.presence(peer));
      } else {
        const failed = progress.phase === "done" && progress.failed > 0;
        if (columns >= 60) {
          spans.push(
            fg("outline", "["),
            fg(failed ? "error" : "primary", progressBar(progress.percent, this.glyphs)),
            fg("outline", "] "),
          );
        }
        spans.push(bold(`${progress.percent}%`));
        if (columns >= 70) {
          spans.push(fg("on-surface-variant", ` ${progress.done}/${progress.total}`));
        }
        spans.push({ text: " " }, chip(phase), { text: "  " });
        spans.push(...this.presence(peer));
        if (failed) spans.push(fg("error", `(${progress.failed} failed)  `));
        spans.push({ text: progress.summary });
      }
      return { spans };
    });
    if (overflow) {
      lines.push({
        spans: [fg("on-surface-variant", `  +${this.peers.length - shown.length} more`)],
      });
    }
    return lines;
  }

  /** Heartbeat display: when the peer was last heard from; quiet links are flagged. */
  private presence(peer: ShellPeer): Span[] {
    if (peer.silentMs === undefined) return [];
    const seconds = Math.floor(peer.silentMs / 1000);
    if (peer.silentMs >= QUIET_AFTER_MS) return [fg("error", `quiet ${seconds}s  `)];
    return [fg("on-surface-variant", `${this.glyphs === "nerd" ? "♥" : "hb"} ${seconds}s  `)];
  }

  private hintLine(): Line {
    const separator = chrome(this.glyphs).sep;
    const keys =
      this.question !== null
        ? ["enter answer", "ctrl+c clear"]
        : this.menu.length > 0
          ? [
              this.glyphs === "nerd" ? "↑↓ select" : "up/down select",
              "tab/enter accept",
              "esc close",
            ]
          : ["/ commands", "enter send", "pgup/pgdn scroll", "ctrl+c clear", "/quit"];
    return { spans: [fg("on-surface-variant", `  ${keys.join(separator)}`)] };
  }
}
