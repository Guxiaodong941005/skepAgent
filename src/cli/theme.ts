/**
 * Semantic color tokens for the session screen (docs/plans/tui-material-redesign.md §3–§4).
 *
 * Material 3 ideas in a terminal: one honey source color, *roles* instead of raw colors, and
 * foreground-only styling (the terminal's own background is the surface). The model in `tui.ts`
 * only ever names roles; the {@link Theme} turns them into SGR codes for one color level, so
 * color never changes a frame's plain text and wire text can never pick a style.
 *
 * Pure: every detector takes the environment as an argument (no `process.env` here).
 */

export type ColorLevel = "none" | "16" | "256" | "truecolor";
export type Scheme = "dark" | "light";
export type Role =
  | "primary"
  | "on-surface"
  | "on-surface-variant"
  | "outline"
  | "secondary"
  | "tertiary"
  | "success"
  | "warning"
  | "error";

/** A run of text in one style. `text` may come from the wire; the screen strips its controls. */
export interface Span {
  text: string;
  role?: Role;
  bold?: boolean;
  dim?: boolean;
  inverse?: boolean;
}

export interface Token {
  /** Truecolor value; null means the terminal's default foreground. */
  hex: string | null;
  /** xterm-256 index nearest to `hex`. */
  x256: number | null;
  /** SGR parameter used with 16 colors (`2` is dim, not a hue). */
  x16: string | null;
  /** What remains without color, so hierarchy survives NO_COLOR (§3.2 "none"). */
  attr?: "bold" | "dim";
}

/**
 * §3.2. Contrast is pinned by `theme.test.ts`: text roles ≥ 4.5:1 and `outline` ≥ 3:1 against
 * {@link REFERENCE_BACKGROUND}; the 256 indices are the nearest xterm-256 colors to the hex.
 */
export const PALETTE: Record<Scheme, Record<Role, Token>> = {
  dark: {
    primary: { hex: "#FFC430", x256: 221, x16: "93", attr: "bold" },
    "on-surface": { hex: null, x256: null, x16: null },
    "on-surface-variant": { hex: "#A8ADB3", x256: 145, x16: "2", attr: "dim" },
    outline: { hex: "#80868B", x256: 102, x16: "2", attr: "dim" },
    secondary: { hex: "#7FD3F7", x256: 117, x16: "96" },
    tertiary: { hex: "#D7A6E8", x256: 182, x16: "95" },
    success: { hex: "#8BD49E", x256: 115, x16: "92" },
    warning: { hex: "#FF9E57", x256: 215, x16: "33", attr: "bold" },
    error: { hex: "#FF8A80", x256: 210, x16: "91", attr: "bold" },
  },
  light: {
    primary: { hex: "#7A5900", x256: 94, x16: "93", attr: "bold" },
    "on-surface": { hex: null, x256: null, x16: null },
    "on-surface-variant": { hex: "#4A4F55", x256: 239, x16: "2", attr: "dim" },
    outline: { hex: "#757A80", x256: 243, x16: "2", attr: "dim" },
    secondary: { hex: "#00658A", x256: 24, x16: "96" },
    tertiary: { hex: "#7A3E8F", x256: 96, x16: "95" },
    success: { hex: "#1E6B34", x256: 23, x16: "92" },
    // Not the plan's #9A4600: that maps to 94 in 256 colors, the same index as light primary.
    warning: { hex: "#A84300", x256: 130, x16: "33", attr: "bold" },
    error: { hex: "#B3261E", x256: 124, x16: "91", attr: "bold" },
  },
};

/** Backgrounds the contrast targets are measured against (§3.1). */
export const REFERENCE_BACKGROUND: Record<Scheme, string> = { dark: "#1E1E1E", light: "#FFFFFF" };

export interface Theme {
  readonly level: ColorLevel;
  readonly scheme: Scheme;
  /** SGR prefix for a span's style; "" when nothing applies. Never contains wire text. */
  sgr(style: Omit<Span, "text">): string;
}

export function fg(role: Role, text: string): Span {
  return { text, role };
}

export function bold(text: string, role?: Role): Span {
  return role === undefined ? { text, bold: true } : { text, role, bold: true };
}

export function dim(text: string): Span {
  return { text, dim: true };
}

export function inverse(text: string): Span {
  return { text, inverse: true };
}

/**
 * §4.2, first match wins. An explicit `SKEP_TUI_COLOR` beats `NO_COLOR` (no-color.org lets
 * user-level configuration override it); `FORCE_COLOR` follows the Node/chalk convention.
 */
export function detectColorLevel(env: NodeJS.ProcessEnv, isTty: boolean): ColorLevel {
  const forced = env.SKEP_TUI_COLOR?.toLowerCase();
  if (forced === "never" || forced === "none" || forced === "0") return "none";
  if (forced === "16" || forced === "256") return forced;
  if (forced === "truecolor" || forced === "24bit") return "truecolor";
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const force = env.FORCE_COLOR;
  if (force === "0") return "none";
  if (force === "1") return "16";
  if (force === "2") return "256";
  if (force === "3") return "truecolor";
  if (!isTty) return "none";
  const term = env.TERM ?? "";
  if (term === "dumb") return "none";
  const colorterm = env.COLORTERM?.toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "truecolor";
  if (/256color|kitty|wezterm|alacritty/.test(term)) return "256";
  return "16";
}

/**
 * §4.3. Reading the real background (OSC 11) is asynchronous and unreliable through tmux/ssh,
 * so the scheme is a guess: the override, else `COLORFGBG`'s background field, else dark.
 */
export function detectScheme(env: NodeJS.ProcessEnv): Scheme {
  const forced = env.SKEP_TUI_THEME?.toLowerCase();
  if (forced === "dark" || forced === "light") return forced;
  const background = env.COLORFGBG?.split(";").at(-1);
  return background === "7" || background === "15" ? "light" : "dark";
}

export function createTheme(opts: { level: ColorLevel; scheme: Scheme }): Theme {
  const { level, scheme } = opts;
  return {
    level,
    scheme,
    sgr(style) {
      const codes: string[] = [];
      if (style.inverse === true) codes.push("7");
      let boldOn = style.bold === true;
      let dimOn = style.dim === true;
      const token = style.role === undefined ? undefined : PALETTE[scheme][style.role];
      if (token !== undefined) {
        if (level === "none") {
          if (token.attr === "bold") boldOn = true;
          if (token.attr === "dim") dimOn = true;
        } else if (level === "16") {
          if (token.x16 === "2") dimOn = true;
          else if (token.x16 !== null) codes.push(token.x16);
        } else if (level === "256") {
          if (token.x256 !== null) codes.push(`38;5;${token.x256}`);
        } else if (token.hex !== null) {
          const [r, g, b] = rgb(token.hex);
          codes.push(`38;2;${r};${g};${b}`);
        }
      }
      if (boldOn) codes.push("1");
      if (dimOn) codes.push("2");
      return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
    },
  };
}

/** No color, attributes only: the default when a caller does not pass a theme. */
export const PLAIN_THEME: Theme = createTheme({ level: "none", scheme: "dark" });

/** WCAG 2.x contrast ratio between two `#RRGGBB` colors (1 to 21). */
export function contrastRatio(fgHex: string, bgHex: string): number {
  const [hi, lo] = [luminance(fgHex), luminance(bgHex)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function rgb(hex: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`not a #RRGGBB color: ${hex}`);
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
}
