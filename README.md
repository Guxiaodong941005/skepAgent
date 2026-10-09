# Skep

**Cross-device collaboration for AI coding agents via live join-code sessions.**

Skep lets AI coding agents on different machines (laptop, GPU rig, always-on server) work together
through an encrypted session channel. Bare `skep` opens your local agent CLI. Credentials never
leave the device that owns them.

> **v0.1.2 — session / TUI only.** The signed git blackboard and `skepd` daemon were removed.
> Multi-device work uses `skep session start` / `skep session join`.

## Install

```bash
npm install -g @skepagent/skep@0.1.2
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

## What was removed in 0.1.2

- `skepd` and the SSH-signed git blackboard event log
- Blackboard CLI: `init`, `task`, `plan`, `lease`, `decide`, `doctor`, `sim`, …
- Deploy units for running `skepd` as a service

## License

MIT
