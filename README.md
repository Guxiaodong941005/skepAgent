# Skep

**Cross-device collaboration for AI coding agents via live join-code sessions.**

Skep lets AI coding agents on different machines (laptop, GPU rig, always-on server) work together
through an encrypted session channel. Bare `skep` opens the Skep shell. Credentials never leave
the device that owns them.

> **v0.1.11 — session UX rethink.** Agents edit the project folder in place (no worktrees),
> join requires a real agent CLI (no AGENT.md gate, no fake dry-run), results show file
> deltas, and `/undo` restores an item. Wire unchanged from 0.1.10.

## Install

```bash
npm install -g @skepagent/skep@0.1.11
```

Requires Node.js ≥ 22.12 (macOS & Linux).

## Quick start

```text
$ skep                      # in any git checkout: the Skep shell (logo, scrollback, input)
> /start                    # master: prints the join code into the scrollback
> /join <code> <ip:port>   # in `skep` on another device or directory (any checkout)
> refactor the auth middleware    # with a master here: sent as an intent
> /quit
```

Type `/` for the command menu (`/start`, `/join`, `/status`, `/intent`, `/agent`, `/help`,
`/quit`). Peer progress (the bee strips) shows under the input while a session is live. Item
output from the agents appears in the scrollback; plain `skep` never hands the terminal to an
agent's own TUI. `skep tui` still opens the raw agent TUI (claude / codex / pi) when you want it.

Scripts and the old flow keep working:

```bash
skep session start          # master: prints join code
skep session join --code <code> --host <ip:port>   # peer on another device or directory
skep ui                     # full-screen session monitor
```

Same-machine peers: start a master in one project directory, join with the code from another.

The master prints the exact line to paste, e.g. `/join 1234-5678-9012 203.0.113.7:7419`. Join
from a checkout of the master's repo: the peer's repo defaults to its git top level's
directory name and its device to the hostname. `--repo`, `--device`, `--role`, `--agent`,
`--view`, `--submit` and `--manual` are optional overrides.

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
