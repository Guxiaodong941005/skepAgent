# Plan: pasteable `/join` line and peer auto mode

Status: implemented on `feat/join-paste-auto`. Target release: next patch (do **not** bump yet).

## Problem

Trial use showed two gaps.

1. The master printed `on another device: skep → /join <code> --host <listen>`. A peer still had
   to add `--repo`. The line also named the **bind** address, which is wrong when peers reach the
   master through another one (NAT, a public IP, a relay).
2. A joined peer had no stated control mode. The peer should not have to confirm master-driven
   work at the skep layer, and the human should know what the device will still ask.

## Behaviour

### Pasteable join line

`formatJoinPaste({ host, code, repo })` in `src/cli/commands/session.ts` returns exactly

```text
/join --host <host:port> --code <NNNN-NNNN-NNNN> --repo <repo>
```

`formatJoinCli` returns its twin, `skep session join --host … --code … --repo …`. `joinHint`
prints both lines.

Repo names are free text (`RepoRefSchema`; the default is the checkout's directory name), so
the line quotes them. The slash parser (`src/cli/shell/flags.ts`) understands `"…"` with `\"`
and `\\` escapes; a word that starts with a quote is always a value, never an option.
`quoteSlashWord` is its inverse: safe words stay bare, everything else is quoted, so
`formatJoinPaste` → `parseJoinArgs` round-trips spaces, option-like text and metacharacters.
The CLI twin is POSIX single-quoted (`quoteShellWord`). A repo with control characters cannot
be typed into the input box; the paste line then leaves `--repo` out and a note says to join
from that checkout. Every place that tells a human how to join uses them:

* `/start` and `skep session start`, through the shared `startedText` banner;
* code rotation: the shell's `onJoinCode` log and the CLI's `join-code` line;
* `noPeersText`, when an intent finds no peer (own or external master);
* the master's "peer left" line ("it can rejoin with the current code: /join --host …").

The peer's own "left the session" line cannot know the master's new code. It prints
`/join --host <target> --code <code> --repo <repo>` with the host and repo already filled in.

`JOIN_USAGE` leads with the paste form. The positional forms still parse.

### `--advertise`

`/start --advertise <host:port>` and `skep session start --advertise <host:port>` set the address
**peers dial**. `--listen` stays the **bind** address. The paste line uses advertise when it is
set, else listen; the banner adds `peers dial <advertise>` only when the two differ. Advertise is
validated exactly as `--listen` by `concreteHostPort` / `hostProblem`, before any master
starts: host:port, where the host is an IP that Node's `net.isIPv4` / `net.isIPv6` accepts, or
a hostname whose dot-separated labels are each valid DNS labels (no empty labels). An IPv6
zone id is split off first, and unspecified addresses (`0.0.0.0`, `::` in any spelling, also
`::ffff:0.0.0.0`, with or without a zone) are refused as wildcards, as is `*`. It is kept on
`MasterFlow.advertise`, so rotation lines and `noPeersText` stay correct. `--machine` output
reports `advertise` in the `started` event.

A master in another process does not publish its advertise address. The shell then falls back
to that master's `listen`.

### Peer control mode (`auto` / `manual`)

Discovery: in the join/item path, the only skep-level peer prompt was the submit question.
It is `ItemWorker.ask` / `JoinView.chooseSubmit`, used only when the policy is `ask`. Claiming
and running items never asked. Auto mode is therefore the existing behaviour, now named and
announced:

* **auto** (default): master-driven items run without a skep prompt. Submit asks only when the
  policy (`--submit`, else `device.toml` `submit.method`, default `ask`) says `ask`.
* **manual** (`/join … --manual`, `skep session join --manual`): before each item is checked out,
  the peer is asked `Run item I-1 (app): <title>? [Y/n]`. Empty or `y` runs it. `n` or no answer
  (EOF, `/clean`) declines it. A declined item is reported to the master with
  `checks: [{ name: "peer", status: "skip" }]` and submit state `skipped`; no branch or
  worktree is created. The question waits for the terminal like a PTY run, so it never prompts
  while an agent owns the screen. A closing join (abort signal) asks nothing more, and the shell
  asks nothing while `/clean` runs: answering the front question would otherwise release the
  next queued one into an idle shell.

The joined line names the mode, e.g.
`joined session S-1 at host:port as peer-2 (auto: master drives work; submit still asks unless
--submit / device policy says otherwise)`. The `--machine` `joined` event carries `control` and
`submit`.

`/join` also gained `--submit pr|mr|push|none|ask`, so the hint in that line can be acted on in
the shell.

Neither mode touches agent CLI approval UIs (D29). If Claude/Codex still ask for tool approval,
that is the agent's own setting. skep adds no `-y` / `--dangerously-*` flags.

`device.toml` is **not** extended. `DeviceConfigSchema` is a strict core schema owned elsewhere,
and the join flag is enough to opt out.

## Files

* `src/cli/commands/session.ts`: `formatJoinPaste`, `formatJoinCli`, `joinHint`, `startedText`,
  `--advertise` (`concreteHostPort`, `MasterFlow.advertise`), `JoinControl`, `controlText`,
  `--manual`, `ItemWorker.confirmItems`, `confirmItem`, `JoinFlow.repo` / `control`.
* `src/cli/shell/run.ts`: `/start --advertise`, banner, rotation paste line, peer-left and rejoin
  hints, `/join --manual --submit`.
* `src/cli/shell/join-args.ts`: `--manual`, `--submit`, `JOIN_USAGE`.
* `src/cli/shell/flags.ts`: double-quoted words, `quoteSlashWord`.
* `src/cli/shell/session-controller.ts`: `SessionView.master.advertise`,
  `noPeersText(host, code, repo)`.
* Tests: `join-args.test.ts`, `run.test.ts`, `session-controller.test.ts`, `session.test.ts`.
* `CHANGELOG.md` `[Unreleased]`.

## Tests

* the paste helper's exact format (`noPeersText`, `/start`, CLI start);
* `/start` without advertise pastes the listen host; with advertise it pastes the advertise host
  and reports the bind; rotation reprints the paste line; wildcard/malformed advertise refused;
* `noPeersText` includes repo and uses the advertise address;
* join is auto by default (joined line, `--machine` `control`, no per-item question);
  `--manual` asks, Enter runs, `n` declines without a checkout; `--manual --ui` refused;
* existing submit-ask tests still pass;
* review fixes: paste-line round-trips (spaces, option-like text, shell metacharacters, quotes,
  control characters), the CLI twin read back by a real `sh`, invalid `--advertise`/`--listen`
  never reaching `startMaster` (CLI and `/start`), and two concurrent manual items with `/clean`
  during the first question leaving no question and a working `/help`.

## Out of scope

Result relay to the master TUI, changing the submit default from `ask`, a `device.toml` control
key, `--manual` with `--ui`, publishing advertise in `session.json` for other-process masters,
version bump, publish.
