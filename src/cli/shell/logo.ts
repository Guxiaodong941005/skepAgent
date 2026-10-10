/**
 * Logo and welcome lines of the unified shell (docs/plans/unified-tui-shell.md §2.1).
 *
 * TODO(merge feat/unified-tui-shell-ui): temporary stub so `run.ts` compiles before the UI branch
 * lands. Replace with the UI branch's `logo.ts`.
 */

import { bold, fg, type Span } from "../theme.js";
import { type Glyphs, NF_MD_BEE } from "../tui.js";

export function logoSpans(glyphs: Glyphs): Span[] {
  return glyphs === "nerd" ? [fg("primary", `${NF_MD_BEE}  `), bold("skep")] : [bold("skep")];
}

export function welcomeLines(): string[] {
  return [
    "Welcome. Type a goal, or / for commands.",
    "/start          start a local session master",
    "/join <code>    join a session (same machine or --host)",
    "/help           list commands",
  ];
}
