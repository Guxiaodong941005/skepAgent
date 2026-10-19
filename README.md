# Skep

**Cross-device collaboration for AI coding agents via live join-code sessions.**

**Website:** https://skepagent.com

Skep lets AI coding agents on different machines (laptop, GPU rig, always-on server) work together
through an encrypted session channel. Bare `skep` opens the Skep shell. Skep does not actively
detect, record, or upload provider keys or tokens.

> **v0.3.0 — Reach & Recovery.** Retry lost work, hold staged runs when a required provider is
> lost, connect across networks with SSH, export offline Markdown/JSON reports, and send separate
> role briefs to peers sharing a repo. Skills remain available with `generic` as the default.

## Install

```bash
npm install -g @skepagent/skep@0.3.0
```

Requires Node.js ≥ 22.12 (macOS & Linux).

## Skills

The default skill is `generic`, which keeps the standard refine and dispatch workflow.
Run `/skills` to see available bundles, then `/skill use <id>` to select one. For example,
`/start --skill iot-ble-feature` selects the packaged IoT scene skill for C++ device, HTTP
server and app work; it is an example, not the CLI default. Join peers with `--role device`,
`--role server`, `--role ios`, `--role android` or `--role h5` as appropriate.

The master drafts a shared contract, waits for device/server results, then dispatches client
work with those results. `/skill` shows bindings; `/skill bind <role> <peer|repo>` overrides
matching. Required unbound roles block dispatch; optional roles are reported skipped.
`/skill use <id> --default` saves a project default; `/skill off --default` clears it.
`/intent` stays raw and `/orchestrate off` ignores the active skill. Mode hints never change
the orchestration mode automatically. Scripts can use `skep session start --skill <id>`;
a shell attaching to that local master inherits its selection.

Packaged skills are built into Skep. User bundles live in `~/.skep/skills/`
(`SKEP_SKILLS_HOME` overrides this); project bundles live in `.skep/skills/`, using
`skill.toml` plus Markdown. Project bundles shadow user and packaged copies and need
`/skill trust <id>` after review, once per content digest. `/skill show <id>` displays the
manifest and text; `packaged:<id>` selects a packaged copy explicitly. Skills supply prompt
text and roles, without changing agent tools or approvals. Peer reports and file lists inform
the consistency summary; real-device BLE bench testing remains a human follow-up.

## Quick start

```text
$ skep                      # in any git checkout: the Skep shell (logo, scrollback, input)
> /start                    # master: prints the join code into the scrollback
> /join <code> <ip:port>   # in `skep` on another device or directory (any checkout)
> refactor the auth middleware    # with a master here: sent as an intent
> /quit
```

Type `/` for the command menu (`/start`, `/join`, `/status`, `/intent`, `/agent`, `/help`,
`/retry`, `/skip`, `/report`, `/quit`). Peer progress (the bee strips) shows under the input while a session is live. Item
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

## Across networks

SSH can carry sessions across NAT without a public Skep listener. Install OpenSSH locally,
configure key authentication, and test `ssh [user@]host` first (Skep uses batch mode; an SSH
config alias can supply a custom port). Both helpers carry **already end-to-end encrypted
session bytes**; join codes, fingerprint checks and local control tokens still apply.

To reach a master from an SSH host:

```sh
skep session join --code <code> --host 127.0.0.1:7419 --via-ssh user@gateway
# In Skep: /join <code> 127.0.0.1:7419 --via-ssh user@gateway
```

`--host` is resolved from the SSH server; it can also name another master reachable there.
To expose a master behind NAT:

```sh
skep session start --via-ssh user@gateway
# In Skep: /start --via-ssh user@gateway
```

This binds locally to loopback by default and allocates a remote loopback port using `ssh -N -R`.
Copy the printed join line, including `--via-ssh`, on another device that can SSH to the same
server. No public server port or `GatewayPorts` setting is needed; the server must permit TCP
forwarding. The master labels its approval prompt and peer list “via ssh”; check the fingerprint
because the observed source address is loopback. Ending the session stops its SSH process; a
tunnel failure ends the session. `--advertise` and `--via-ssh` are mutually exclusive.

With Tailscale or WireGuard, bind `--listen <vpn-ip>:7419` and have peers join that VPN address.
With router port forwarding, bind a concrete local address and pass
`--advertise <public-host>:<forwarded-port>` so the printed join line uses the reachable address.
There is no hosted relay, TURN/STUN or hole-punching service in 0.3.0.


## Recovery and reports

`/retry <I-id|intent-id|O-id> [--peer peer-N]` sends lost or failed items again, reusing their original brief and
requiring a connected peer with the same repo and role. Use `--peer` to select a particular replacement with that binding. Run it in the shell that owns
the master; targets must already advertise their repo and role.
Retries create new item/intent IDs; earlier attempts remain in the orchestration ledger. A peer
that disconnects aborts its agent and prints the checkout path and item state so you can recover
local edits. A peer with running items warns at 20 seconds of silence and is dropped at 30 seconds.

Staged skills **hold** at `awaiting-retry` when a required role is lost. The next stage does not
start until the retry settles, or you deliberately `/skip <O-id>`. Later-stage input and synthesis
name skipped roles. `/retry` may redo work that completed just before a link loss; a late result
from the old peer ID is rejected. Session resume and automatic reconnect are not available.

Export recorded orchestrations offline:

```sh
skep session report                    # latest record, Markdown
skep session report O-<ledger-id>       # one record (full ID from /history)
skep session report --last 5 --json     # validated JSON records, newest first
# In Skep: /report [O-id|--last N] [--json]
```

Reports contain the request, refined and dispatched briefs, skill/contract, stages, per-peer
verdicts (including lost and deliberately skipped work), changed files, summaries and synthesis.
They read only the existing local orchestration ledger. Raw `/intent` traffic and join/leave
history are not persisted; there is no session JSONL or HTML timeline. `--last` accepts 1..100
(default 1). A short ID such as `O-1` works only when it is unambiguous in this project's ledger.

## License

Copyright 2026 Skep contributors.

Licensed under the [Apache License, Version 2.0](LICENSE)
(<https://www.apache.org/licenses/LICENSE-2.0>).
