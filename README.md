# Skep

**Cross-device collaboration for AI coding agents via live join-code sessions.**

Skep lets AI coding agents on different machines (laptop, GPU rig, always-on server) work together
through an encrypted session channel. Bare `skep` opens your local agent CLI. Credentials never
leave the device that owns them.

> **v0.1.5 — session / TUI only.** Peers now see each other's progress in the session screen.
> The signed git blackboard and `skepd` daemon were removed in 0.1.2; multi-device work uses
> `skep session start` / `skep session join`.

## Install

```bash
npm install -g @skepagent/skep@0.1.5
```

Requires Node.js ≥ 22.12 (macOS & Linux).

## Quick start

```bash
# in any git checkout — opens the local agent (claude / codex / pi)
skep

# multi-device session
skep session start          # master: prints join code
skep session join <code>    # peer on another device or directory
skep ui                     # full-screen session TUI
```

Same-machine peers: start a master in one project directory, join with the code from another.

## Session screen

`skep ui` (on the master) and `skep session join --ui` (on a sub) show the peers with live
progress, the selected item, its agent and the output tail. The footer lists only the keys
that act now.

| Variable | Values | Effect |
|---|---|---|
| `SKEP_TUI_GLYPHS` | `nerd`, `ascii` | Glyph set. The default is `nerd` when a Nerd Font has the bee icon, otherwise `ascii`. `SKEP_TUI_ASCII=1` is a legacy alias for `ascii`. |
| `SKEP_TUI_COLOR` | `auto`, `never`, `16`, `256`, `truecolor` | Color level. `auto` detects it from `NO_COLOR`, `FORCE_COLOR`, `COLORTERM` and `TERM`. |
| `SKEP_TUI_THEME` | `auto`, `dark`, `light` | Palette. `auto` reads `COLORFGBG` and falls back to `dark`. |
| `SKEP_TUI_ANIMATE` | `1`, `0` | `0` stops the bee animation. |

## What was removed in 0.1.2

- `skepd` and the SSH-signed git blackboard event log
- Blackboard CLI: `init`, `task`, `plan`, `lease`, `decide`, `doctor`, `sim`, …
- Deploy units for running `skepd` as a service

## License

MIT
