/**
 * Frame layout of the unified shell: header, scrollback, slash menu, input, bee footer, hint
 * (docs/plans/unified-tui-shell.md §2–§3). Pure: `run.ts` owns the terminal and the session.
 *
 * TODO(merge feat/unified-tui-shell-ui): temporary stub so `run.ts` compiles before the UI branch
 * lands. Replace with the UI branch's `model.ts` and adapt `run.ts` to its API.
 */

import type { JoinViewModel } from "../commands/session.js";
import { bold, fg, type Role } from "../theme.js";
import { beeLane, chip, type Glyphs, type Line, progressBar } from "../tui.js";
import { SKEP_VERSION } from "../version.js";
import { logoSpans, welcomeLines } from "./logo.js";
import { commandLabel, type SlashCommand } from "./slash.js";

export const SCROLLBACK_CAP = 1_000;
const MAX_BEE_ROWS = 3;
const MAX_MENU_ROWS = 6;
/** Below this the shell cannot show the input and footer, so only a notice is drawn. */
export const SHELL_MIN_ROWS = 10;

export type ShellTone = "info" | "event" | "error" | "muted";
export type ShellPeer = JoinViewModel["peers"][number];

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
  glyphs: Glyphs = "nerd";
  beat = 0;
  /** A pending question takes the input; the prompt shows it. */
  question: string | null = null;

  /** Appends one or more lines; a multi-line text becomes several scrollback lines. */
  append(text: string, tone: ShellTone = "info"): void {
    for (const line of text.replace(/\n+$/, "").split("\n")) {
      this.scrollback.push({ text: line, tone });
    }
    if (this.scrollback.length > SCROLLBACK_CAP) {
      this.scrollback.splice(0, this.scrollback.length - SCROLLBACK_CAP);
    }
    // New output while scrolled back keeps the view where the human left it.
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
      return [`skep needs at least ${SHELL_MIN_ROWS} rows (terminal has ${rows})`];
    }
    const { device, cwd } = this.header;
    const header: Line[] = [
      {
        spans: [
          { text: "  " },
          ...logoSpans(this.glyphs),
          fg("on-surface-variant", `   ${this.header.session}`),
          fg("on-surface-variant", `   v${SKEP_VERSION}`),
        ],
      },
      { spans: [fg("on-surface-variant", `  device ${device} · cwd ${cwd}`)] },
    ];
    const bee = this.beeRows();
    const hint: Line = {
      spans: [
        fg(
          "on-surface-variant",
          this.question !== null
            ? "  enter answer · ctrl+c clear"
            : "  / commands · enter send · pgup/pgdn scroll · ctrl+c clear · /quit",
        ),
      ],
    };
    const prompt = this.question === null ? "> " : `${this.question} `;
    const input: Line = { spans: [bold(prompt, "primary"), { text: `${this.input}_` }] };
    const ruleChar = this.glyphs === "nerd" ? "─" : "-";
    const rule: Line = { spans: [fg("outline", ruleChar.repeat(columns))] };
    const bodyRows = Math.max(0, rows - header.length - 3 - bee.length);
    const body = this.bodyLines(bodyRows);
    const menu = bodyRows === 0 ? [] : this.menuLines().slice(-bodyRows);
    body.splice(body.length - menu.length, menu.length, ...menu);
    return [...header, ...body, input, rule, ...bee, hint];
  }

  private bodyLines(count: number): Line[] {
    const source: Line[] =
      this.scrollback.length === 0
        ? ["", ...welcomeLines().map((line) => `  ${line}`)]
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
      const label = commandLabel(command).padEnd(22);
      const text = `  ${label} ${command.description}`;
      return index === this.menuIndex
        ? { spans: [{ text }], selected: true }
        : { spans: [bold(`  ${label}`), fg("on-surface-variant", ` ${command.description}`)] };
    });
  }

  private beeRows(): Line[] {
    if (!this.sessionLive) return [];
    if (this.peers.length === 0) return [{ spans: [fg("on-surface-variant", "  (no peers yet)")] }];
    const overflow = this.peers.length > MAX_BEE_ROWS;
    const shown = this.peers.slice(0, overflow ? MAX_BEE_ROWS - 1 : MAX_BEE_ROWS);
    const lines: Line[] = shown.map((peer) => {
      const progress = peer.progress;
      const phase = progress?.phase ?? "idle";
      return {
        spans: [
          { text: `  ${peer.device.padEnd(10).slice(0, 10)} ` },
          fg("on-surface-variant", `${peer.role.padEnd(9).slice(0, 9)} `),
          fg("primary", `${beeLane(phase, this.beat, this.glyphs)} `),
          ...(progress === undefined
            ? [chip(peer.state)]
            : [
                { text: `[${progressBar(progress.percent, this.glyphs)}] ` },
                { text: `${progress.percent}% ${progress.done}/${progress.total} ` },
                chip(phase),
                fg("on-surface-variant", `  ${progress.summary}`),
              ]),
        ],
      };
    });
    if (overflow) {
      lines.push({
        spans: [fg("on-surface-variant", `  +${this.peers.length - shown.length} more`)],
      });
    }
    return lines;
  }
}
