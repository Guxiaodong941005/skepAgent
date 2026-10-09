import { describe, expect, it } from "vitest";
import {
  bold,
  type ColorLevel,
  contrastRatio,
  createTheme,
  detectColorLevel,
  detectScheme,
  dim,
  fg,
  inverse,
  PALETTE,
  REFERENCE_BACKGROUND,
  type Role,
  rgb,
  type Scheme,
} from "./theme.js";

const ROLES = Object.keys(PALETTE.dark) as Role[];
const SCHEMES: Scheme[] = ["dark", "light"];

describe("detectColorLevel", () => {
  it.each([
    [{ SKEP_TUI_COLOR: "never", COLORTERM: "truecolor" }, true, "none"],
    [{ SKEP_TUI_COLOR: "0" }, true, "none"],
    [{ SKEP_TUI_COLOR: "16" }, false, "16"],
    [{ SKEP_TUI_COLOR: "256", NO_COLOR: "1" }, true, "256"],
    [{ SKEP_TUI_COLOR: "24bit" }, false, "truecolor"],
    [{ SKEP_TUI_COLOR: "auto", COLORTERM: "truecolor" }, true, "truecolor"],
    [{ NO_COLOR: "1", FORCE_COLOR: "3" }, true, "none"],
    [{ NO_COLOR: "", COLORTERM: "truecolor" }, true, "truecolor"],
    [{ FORCE_COLOR: "0", COLORTERM: "truecolor" }, true, "none"],
    [{ FORCE_COLOR: "1" }, false, "16"],
    [{ FORCE_COLOR: "2" }, false, "256"],
    [{ FORCE_COLOR: "3" }, false, "truecolor"],
    [{ COLORTERM: "truecolor" }, false, "none"],
    [{ TERM: "dumb", COLORTERM: "truecolor" }, true, "none"],
    [{ COLORTERM: "24bit", TERM: "xterm" }, true, "truecolor"],
    [{ TERM: "tmux-256color" }, true, "256"],
    [{ TERM: "xterm-kitty" }, true, "256"],
    [{ TERM: "xterm" }, true, "16"],
    [{}, true, "16"],
  ] as const)("%j (tty %s) → %s", (env, tty, level) => {
    expect(detectColorLevel(env, tty)).toBe(level);
  });
});

describe("detectScheme", () => {
  it.each([
    [{ SKEP_TUI_THEME: "light", COLORFGBG: "15;0" }, "light"],
    [{ SKEP_TUI_THEME: "dark", COLORFGBG: "0;15" }, "dark"],
    [{ SKEP_TUI_THEME: "auto", COLORFGBG: "0;15" }, "light"],
    [{ COLORFGBG: "15;0" }, "dark"],
    [{ COLORFGBG: "0;15" }, "light"],
    [{ COLORFGBG: "0;default;15" }, "light"],
    [{ COLORFGBG: "0;7" }, "light"],
    [{ COLORFGBG: "garbage" }, "dark"],
    [{}, "dark"],
  ] as const)("%j → %s", (env, scheme) => {
    expect(detectScheme(env)).toBe(scheme);
  });
});

describe("Theme.sgr", () => {
  it("emits the code for each level", () => {
    const at = (level: ColorLevel) => createTheme({ level, scheme: "dark" });
    expect(at("truecolor").sgr({ role: "primary" })).toBe("\x1b[38;2;255;196;48m");
    expect(at("256").sgr({ role: "primary" })).toBe("\x1b[38;5;221m");
    expect(at("16").sgr({ role: "primary" })).toBe("\x1b[93m");
    expect(at("none").sgr({ role: "primary" })).toBe("\x1b[1m");
    expect(at("16").sgr({ role: "outline" })).toBe("\x1b[2m");
    expect(at("none").sgr({ role: "on-surface" })).toBe("");
    expect(at("truecolor").sgr({ role: "on-surface" })).toBe("");
    expect(at("truecolor").sgr({ role: "error", bold: true })).toBe("\x1b[38;2;255;138;128;1m");
    expect(at("none").sgr({ inverse: true })).toBe("\x1b[7m");
    expect(at("none").sgr({})).toBe("");
  });

  it("never emits a color code without color", () => {
    for (const scheme of SCHEMES) {
      const theme = createTheme({ level: "none", scheme });
      for (const role of [...ROLES, undefined]) {
        for (const flags of [0, 1, 2, 3, 4, 5, 6, 7]) {
          const code = theme.sgr({
            ...(role === undefined ? {} : { role }),
            bold: (flags & 1) !== 0,
            dim: (flags & 2) !== 0,
            inverse: (flags & 4) !== 0,
          });
          // biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR
          expect(code).toMatch(/^(|\x1b\[[127](;[127])*m)$/);
        }
      }
    }
  });

  it("builds spans with the helpers", () => {
    expect(fg("success", "done")).toEqual({ text: "done", role: "success" });
    expect(bold("37%")).toEqual({ text: "37%", bold: true });
    expect(bold("q", "primary")).toEqual({ text: "q", role: "primary", bold: true });
    expect(dim("hint")).toEqual({ text: "hint", dim: true });
    expect(inverse("> row")).toEqual({ text: "> row", inverse: true });
  });
});

describe("palette", () => {
  it("pins the WCAG formula", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBe(21);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(() => rgb("red")).toThrow("not a #RRGGBB color");
  });

  it.each(SCHEMES)("meets the contrast targets on %s", (scheme) => {
    for (const role of ROLES) {
      const hex = PALETTE[scheme][role].hex;
      if (hex === null) continue;
      const ratio = contrastRatio(hex, REFERENCE_BACKGROUND[scheme]);
      expect(ratio, `${scheme} ${role}`).toBeGreaterThanOrEqual(role === "outline" ? 3 : 4.5);
    }
  });

  it.each(SCHEMES)("uses the nearest xterm-256 index on %s", (scheme) => {
    for (const role of ROLES) {
      const { hex, x256 } = PALETTE[scheme][role];
      expect(x256, `${scheme} ${role}`).toBe(hex === null ? null : nearest256(hex));
    }
  });
});

/** Nearest xterm-256 color, over the 6×6×6 cube and the gray ramp (0–15 vary by terminal). */
function nearest256(hex: string): number {
  const levels = [0, 95, 135, 175, 215, 255];
  const target = rgb(hex);
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 16; index < 256; index++) {
    const n = index - 16;
    const color =
      index < 232
        ? [levels[Math.floor(n / 36)], levels[Math.floor(n / 6) % 6], levels[n % 6]]
        : [8 + 10 * (index - 232), 8 + 10 * (index - 232), 8 + 10 * (index - 232)];
    const distance = color.reduce(
      (sum: number, value, i) => sum + ((value ?? 0) - (target[i] ?? 0)) ** 2,
      0,
    );
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
