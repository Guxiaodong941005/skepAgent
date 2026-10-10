import { bold, fg, type Span } from "../theme.js";
import {
  chrome,
  displayWidth,
  fitSpans,
  type Glyphs,
  type Line,
  NF_MD_BEE,
  truncate,
} from "../tui.js";
import { SKEP_VERSION } from "../version.js";

export function logoSpans(glyphs: Glyphs): Span[] {
  return [
    { text: "  " },
    ...(glyphs === "nerd" ? [fg("primary", `${NF_MD_BEE}  `)] : []),
    bold("skep", "primary"),
  ];
}

export function logoLine(
  columns: number,
  glyphs: Glyphs,
  context = "",
  version: string | null = SKEP_VERSION,
): Line {
  const brand = logoSpans(glyphs);
  const label = version === null ? "" : truncate(`v${version}`, columns);
  const versionWidth = displayWidth(label);
  const leftWidth = Math.max(0, columns - (label === "" ? 0 : versionWidth + 2));
  const left = fitSpans(
    [...brand, ...(context === "" ? [] : [fg("on-surface-variant", `   ${context}`)])],
    leftWidth,
  );
  const used = left.reduce((width, span) => width + displayWidth(span.text), 0);
  return {
    spans: [
      ...left,
      ...(label === ""
        ? []
        : [{ text: " ".repeat(Math.max(0, columns - used - versionWidth)) }, fg("outline", label)]),
    ],
  };
}

export function welcomeLines(glyphs: Glyphs): Line[] {
  const separator = chrome(glyphs).sep;
  return [
    "",
    { spans: [fg("on-surface", "  Welcome. Type a goal, or / for commands.")] },
    {
      spans: [
        fg("primary", "  /start        "),
        fg("on-surface-variant", "start a local session master"),
      ],
    },
    {
      spans: [
        fg("primary", "  /join [code]  "),
        fg("on-surface-variant", "join a session (same machine or --host)"),
      ],
    },
    { spans: [fg("primary", "  /help         "), fg("on-surface-variant", "list commands")] },
    { spans: [fg("outline", `  Input stays available${separator}output appears here`)] },
  ];
}
