# Join slim: code + host only (JOIN-SLIM)

Status: implement on `feat/join-slim`. Do **not** bump version or publish.

## Problem

v0.1.11 paste lines still look like:

```text
/join --host 203.0.113.7:7419 --code 1234-5678-9012 --repo app
skep session join --host … --code … --repo app
```

Users must type or paste `--repo` (and sometimes `--device`). Those values are already
discovered locally at join (`defaultRepo` = git toplevel basename, `defaultDevice` =
hostname) and already travel on the handshake / join request. The CLI flags are optional
today; the *paste UX* still requires them.

## Goal

Pasteable join is only **code + host**:

```text
/join <NNNN-NNNN-NNNN> <host:port>
```

CLI twin:

```text
skep session join --code <NNNN-NNNN-NNNN> --host <host:port>
```

(also accept the long form `/join --code … --host …` and the existing positional swaps).

`--repo`, `--device`, `--role`, `--agent`, `--view`, `--submit`, `--manual` stay as
**optional overrides**. They must not be required for a successful join from a git cwd.

## Defaults (unchanged semantics)

| Field | Default when omitted |
|---|---|
| `device` | hostname coerced to `^[a-z0-9][a-z0-9-]{0,62}$` (`defaultDevice`) |
| `repo` | basename of git toplevel of cwd (`defaultRepo`); fail with actionable message if not in a git repo and no `--repo` |
| `role` | coding (existing) |
| `agent` / `view` / `submit` | existing env / PATH / device.toml / policy defaults |

## Wire

No protocol change. Handshake / join request already carries `device` (and join accept /
roster already show repo). Keep `src/session/messages.ts` and schemas untouched.

## Do not

- Reintroduce worktrees or AGENT.md gates
- Change session wire schemas
- Bump `package.json` / `version.ts` or `npm publish`
- Merge to main

## Files (stay inside these + colocated tests + docs)

- `src/cli/commands/session.ts` — `formatJoinPaste`, `formatJoinCli`, `joinHint`,
  `startedText`, rotation paste lines; drop `--repo` from paste/CLI twin; prefer
  `/join <code> <host>` as the canonical paste string (positional; already accepted by
  `parseJoinArgs`)
- `src/cli/shell/join-args.ts` — `JOIN_USAGE` leads with slim form; keep optional flags
- `src/cli/shell/session-controller.ts` — `noPeersText` / peer-left / rejoin hints without
  `--repo`
- `src/cli/shell/run.ts` — any hardcoded paste hints that still embed `--repo`
- Tests that assert the old paste string (`session.test.ts`, `run.test.ts`,
  `session-controller.test.ts`, `join-args.test.ts`)
- `README.md` quick start / join examples
- `CHANGELOG.md` under `[Unreleased]`
- `docs/plans/join-slim.md` (short plan + acceptance) and this BRIEF

## Acceptance

1. Exact paste form documented: `/join <code> <host>`
2. `skep session join --code X --host Y` (no `--repo`/`--device`) from a git cwd joins and
   advertises correct repo (cwd basename) and device (hostname) to the master
3. TUI `/join <code> <host>` accepts the slim form
4. Brief note what still travels on the wire at handshake (device in key material /
   join request; repo on accept/roster as today)
5. `npm run lint && npm test && npm run build` green
