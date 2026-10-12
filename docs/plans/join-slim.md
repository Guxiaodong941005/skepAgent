# Plan: slim `/join` paste — code + host only (JOIN-SLIM)

Status: implemented on `feat/join-slim`. Brief: [`join-slim-BRIEF.md`](join-slim-BRIEF.md).
Supersedes the paste-line format in [`join-paste-auto.md`](join-paste-auto.md).

## Problem

Up to v0.1.11 the paste line was `/join --host <host:port> --code <code> --repo <repo>`. The repo
and the device are already discovered on the joining side, so the flag only made the line longer
and made users think they had to type it.

## Behaviour

| Where | Text |
|---|---|
| Paste line (`formatJoinPaste`) | `/join <NNNN-NNNN-NNNN> <host:port>` |
| CLI twin (`formatJoinCli`) | `skep session join --code <NNNN-NNNN-NNNN> --host <host:port>` |
| Hint (`joinHint`, `startedText`, `noPeersText`) | `on another device, from a checkout of <repo>, paste into skep: <paste>` then `or from a shell: <twin>` |
| Code rotation (shell and CLI) | the paste line with the new code |
| Peer left (master) / own join ended (peer) | `/join <code> <host:port>` |

The host is quoted with `quoteSlashWord` when needed (a bracketed IPv6 address becomes one
quoted word), and the twin with `quoteShellWord`, so both round-trip through their parsers. The
master's repo appears only as prose, JSON-quoted when it is not a plain name, so a repo with
spaces or control characters no longer needs a special case in the paste line.

`JOIN_USAGE` leads with the slim form, then `/join --code … --host …`, the swapped positional
form and the bare `/join`; `--repo`, `--device`, `--role`, `--agent`, `--view`, `--submit` and
`--manual` are listed as optional. `parseJoinArgs` is unchanged: it still accepts all flags and
classifies positionals by shape, so old paste lines keep working.

## Defaults on the joining side

| Field | When omitted |
|---|---|
| `repo` | basename of `git rev-parse --show-toplevel` in the cwd (`defaultRepo`); outside a git checkout the join fails with `repo_required: not inside a git repository; pass --repo <name>` |
| `device` | hostname, lower-cased and coerced to `^[a-z0-9][a-z0-9-]{0,62}$` (`defaultDevice`) |
| `role` | `coding` |
| `agent` / `view` / `submit` | `/agent` / `SKEP_AGENT_CLI` / AGENT.md / PATH; `native`; device.toml, else `none` |

## Wire (unchanged)

No change to `src/session/messages.ts` or `src/core` schemas.

* Handshake: the sub's first frame is `join { v, device, pub, nonce }`. The device name travels
  here and is bound into the handshake; the join code itself never travels in clear.
* Repo, head and role travel after the handshake, in the sub's `capability` reply to each
  intent (from `describe()`), and the master shows them in its roster (`status.peers[].repo`).
* Routing still matches an intent's repos against the peer's described repo, so a peer whose
  checkout directory name differs from the master's repo must pass `--repo <name>`.

## Acceptance

- [x] The paste form is exactly `/join <NNNN-NNNN-NNNN> <host:port>`
  (`join-args.test.ts` "is just the code and the host").
- [x] The CLI twin is exactly `skep session join --code <NNNN-NNNN-NNNN> --host <host:port>`, and
  a POSIX shell reads it back (`session.test.ts` "shell-quotes the CLI twin").
- [x] Paste lines round-trip through `parseJoinArgs` for IPv4, IPv6 and DNS hosts.
- [x] No printed hint carries `--repo`; the master's repo is named in prose
  (`session-controller.test.ts`, `run.test.ts`, `session.test.ts`).
- [x] `skep session join --code X --host Y` from a git checkout advertises the checkout's
  basename as repo and the hostname as device (`session.test.ts` "joins with only --code and
  --host").
- [x] TUI `/join <code> <host>` from a git checkout does the same (`run.test.ts` "joins with
  just the slim paste").
- [x] Without a git checkout and without `--repo` the join fails with `repo_required` before
  connecting.
- [x] `JOIN_USAGE` leads with the slim form and lists the overrides as optional.
- [x] `npm run lint && npm test && npm run build` green.
