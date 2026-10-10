# Plan: TUI / session reliability (post-0.1.6)

Status: **plan → implementation on `feat/tui-session-reliability`.** No version bump, no publish,
no merge to `main`. Brief: `docs/plans/tui-session-reliability-BRIEF.md`.

Code read for this plan (0.1.6 @ `d4095f9`): `src/cli/shell/{run,model,slash,input}.ts`,
`src/cli/commands/session.ts` (flows, control, status), `src/session/{master,sub,channel,index}.ts`,
`docs/plans/unified-tui-shell.md`.

---

## 1. Root causes

### Bug 1 — header `no session` while a peer row is visible; free text says `no session`

The shell has **three independent notions of "a session"** and none of them is authoritative:

| Truth | Where | Used by |
| --- | --- | --- |
| `this.master` / `this.join` handles | `Shell` fields, `run.ts` | `freeText`, `shellCtx().sessionLive`, `startCommand`, `joinCommand` |
| `model.sessionLive`, `model.header.session` | `ShellModel`, set only in `Shell.sessionChanged()` | header, info line, footer gating |
| `model.peers` | written by `ShellJoinView.update → Shell.setPeers` and `refreshMasterPeers` | bee footer |
| `~/.skep/session.json` + control port | `fetchSessionStatus`, `submitIntent` (`session.ts` `control()`) | `/status`, every intent |

Concrete split-brain paths in 0.1.6:

1. **Master in another process.** `skep session start` (or a second `skep` shell) owns the master;
   a newly opened shell starts with `master = join = null` → header `no session`, free text →
   `no session — /start or /join first` (`Shell.freeText`), yet `/status` (which reads
   `session.json`) shows a live session with peers. The shell never looks at what the device
   actually runs.
2. **Join flow ended (bug 4) but the screen keeps the evidence.** `joinEnded` sets `join = null`
   → header `no session`, but the scrollback still ends with the per-phase line
   `peer peer-2 idle 0/0 (0%)` (from `joinSessionFlow`'s `say` in `onProgress`) — which looks
   exactly like a peer strip. Nothing tells the user *why* the session went away.
3. **Late view updates.** `ShellJoinView.update` calls `setPeers` unconditionally. Updates that
   arrive while `joinSessionFlow` is still awaiting (`onProgress` "may fire before connectSub
   resolves", `src/session/index.ts`), after a failed join, or after `joinEnded` repopulate
   `model.peers` for a flow the shell does not own. The footer currently hides them only because
   `beeRows` re-checks `sessionLive` — a fragile coincidence, not a rule.
4. `/status` always goes through `session.json`, even when the shell owns the master in-process
   (works, but is a second path to the same truth) and fails with `no session master is running
   (…session.json not found)` on a **sub** device that is in fact joined.

### Bug 2 — `/intent` → `Unable to route the session intent` / `no_match` with no peers

`Shell.sendIntent` → `submitIntent` (control TCP) → `SessionMaster.submitIntent`
(`src/session/master.ts`). With zero peers `intent.waiting` is empty, so `route()` runs at once,
finds no candidate, records the intent as `no_match` and rejects with `NoMatchError`. The control
handler replaces that with the generic `controlError("no_match", "Unable to route the session
intent")`, so the shell shows an opaque error, and `/status` now lists a dead `no_match` intent.

* The shell never checks the peer count before sending, though it owns (or can read) it.
* Repo mismatch looks identical: routing matches `intent.repos` (default: the master's repo)
  against each peer's `capability.repo` (`matchSub`, `src/session/state.ts`). A peer in a
  differently-named repo is never a candidate. A peer's repo is only known *after* its first
  capability reply, so the shell cannot pre-check it; it must explain the `no_match` afterwards.
* Role is **not** a routing input (only advertised); "role mismatch" cannot cause `no_match`.
* A latent timing bug: `control()` uses `CONTROL_TIMEOUT_MS = 10 s`, but the master may wait up
  to `datalistTimeoutMs = 30 s` for capabilities before answering an `intent` op. A slow peer makes
  the CLI report `session_unreachable` although the intent was accepted.

### Bug 3 — `/join 192.168.30.182:7419 8632-1727-0308` → `--code must be 12 digits`

`Shell.joinCommand` does `code = flags.values.code ?? flags.positional[0]`, so the first
positional is always the code; `host:port` reaches `normalizeJoinCode` and fails. The second
positional is silently ignored. The error does not show the accepted forms.

### Bug 4 — peers disappear; session feels flaky

The protocol drops a peer on any wire close: `heartbeat_timeout` (30 s of silence,
`SessionWire.received`), `transport_error`/`connection_closed` (Wi-Fi, laptop sleep),
`protocol_error`, or the sub's own `callback_error` bye (e.g. `describe()`'s `git rev-parse HEAD`
fails in a repo without commits). What makes it *feel* flaky is the UI:

* The master's wire `onClose` emits `event("disconnected", reason)` with **only the reason**,
  no peer id/device (`master.ts` `attach`). Every control request (`/status`, intents) also closes
  a wire and emits `disconnected control_complete` — the shell logs that noise into scrollback.
* `joinSessionFlow` does not pass `onEvent` to `connectSub`, so a sub-side `callback_error` (the
  sub hanging up on purpose) is never shown; the shell only prints `left the session (callback_error)`.
* No liveness is visible: neither side shows when it last heard from the other.
* There is no reconnect: join codes are single-use and rotate; nobody tells the user that a dropped
  peer must `/join` again with the master's *current* code.

---

## 2. Target architecture: one `SessionController`

```text
                          ┌────────────────────────── Shell (run.ts) ─────────────────────────┐
 keys / slash commands ──▶│ dispatch ─▶ SessionController  ◀── flow callbacks (onEvent,       │
                          │                 │  owns:            onJoinCode, closed, view.update)│
                          │                 │  master: MasterFlow | null   (in-process)        │
                          │                 │  join:   JoinFlow  | null    (+ join generation)  │
                          │                 │  external: status of a master in another process│
                          │                 ▼                                                  │
                          │           snapshot(): SessionView  ──▶ header, info line, footer, │
                          │                                         slash gating, /status,    │
                          │                                         intent gate               │
                          └───────────────────────────────────────────────────────────────────┘
```

`src/cli/shell/session-controller.ts` (new) is the **only** holder of session state. The shell
never keeps its own `master`/`join` fields, and `ShellModel` gets header/peers/live **only** by
copying `controller.snapshot()` in `Shell.sync()`.

`SessionView`:

```ts
{ mode: "none" | "joining" | "master" | "joined" | "external";
  master: { listen, repo, joinCode, external: boolean } | null;
  join: { target, role, peerId } | null;      // mode "joined" (may coexist with master)
  peers: ShellPeer[];                          // with optional silentMs (heartbeat display)
  live: boolean;                               // master || join || external
  linkSilentMs: number | null }                // sub: time since the master was last heard
```

Rules (what the UI may show when):

| Device state | header | footer peers come from | free text / `/intent` |
| --- | --- | --- | --- |
| nothing | `no session` | nothing (`(no session)`) | refused: `/start` or `/join` |
| own master (this shell) | `master · code … · listen …` | `master.handle.status()` + `presence()` each tick | `handle.submitIntent` directly; refused with join hint when 0 peers |
| own master + own join | `master · code … · joined …` | the sub roster (live relays) | as own master |
| joined only | `joined <host> as peer-N · role` | the sub's `onProgress` roster (generation-checked) | refused: "intents are sent from the master's shell (<host>)" |
| `joining` (handshake in flight) | `joining <host>…` | roster updates accepted for this generation | refused |
| external master (other process, found via `session.json` + live `status`) | `master (other process) · listen …` | control `status` polled every 2 s; cleared on first failure | via control (`submitIntent`), same 0-peer gate |

Invariants:

* Peers are cleared whenever the flow that produced them ends; roster updates carry a join
  generation and are ignored unless that generation is current.
* The footer never renders peers unless `live`.
* The external probe runs at shell start and after an owned master ends; it never runs while the
  shell owns a flow. A probe failure (no file, connection refused) means `none`, not an error.

Protocol-side presence (small, backward compatible — no wire change):

* `SessionWire` records `lastReceivedMs` (Clock monotonic) and exposes `silenceMs()`.
* `MasterHandle.presence?()` → `[{ peerId, silentMs }]`; `SubHandle.silenceMs?()`.
  Optional members so existing test doubles still type-check.
* Master emits `left` events naming the peer: `Peer peer-2 (mac) left: heartbeat_timeout`.
  Control-connection closes emit nothing. Failed handshakes emit `join from <addr> failed: <reason>`.

---

## 3. `/join` grammar

```text
/join                                         own master (in-process or this device's session.json)
/join <code>                                  local master file on this machine
/join <code> --host <host:port>
/join --host <host:port> --code <code>
/join <host:port> <code>                      either order of the two positionals
/join … [--role r] [--agent dry|pty|herdr|native] [--repo name] [--device name]
```

`<code>` = 12 digits, dashes/spaces optional (`8632-1727-0308`). `<host:port>` = `parseHostPort`
(`[v6]:port` allowed). Each positional is classified as code or host; two codes, two hosts, a
positional that is neither, or a positional that conflicts with `--code`/`--host` is rejected with:

```text
/join: <problem>
usage: /join <NNNN-NNNN-NNNN> [--host host:port]
       /join <host:port> <NNNN-NNNN-NNNN>
       /join --host <host:port> --code <NNNN-NNNN-NNNN>
```

Pure function `parseJoinArgs` in `src/cli/shell/join-args.ts`.

---

## 4. Intent routing UX

| Situation | Before | After |
| --- | --- | --- |
| no session | `no session — /start or /join first` | `no session on this device — /start a master or /join one` |
| joined only | `no session master on this device …` | `this device is a peer of <host>; type intents in the master's shell` |
| master, 0 peers | intent recorded `no_match`, `Unable to route the session intent` | not sent; `no peers joined yet — on another device: skep → /join <code> --host <listen>` |
| master, peers but none in repo | `Unable to route …` | `no connected peer works on repo <repo> (peer-1: repo api, peer-2: repo ?) — peers must /join from a checkout of <repo>` |
| routed | `intent N: text` | `intent N routed: text` (plan/items follow as events) |

Master side (`master.ts` control handler): the `no_match` control error carries the
`NoMatchError` message, which now names the repos and the connected peer count, so
`skep session intent` also improves. Control requests with `op: "intent"` wait up to 40 s
(> datalist timeout) instead of 10 s.

---

## 5. File-by-file changes

| File | Change |
| --- | --- |
| `src/cli/shell/session-controller.ts` (new) | `SessionController`, `SessionView`, intent gate, leave-reason text, external probe/poll |
| `src/cli/shell/join-args.ts` (new) | `parseJoinArgs` + `JOIN_USAGE` |
| `src/cli/shell/run.ts` | drop `master`/`join` fields; route through the controller; `sync()` copies the snapshot; `/status` by mode; generation-checked `ShellJoinView`; filtered master events; presence ticks |
| `src/cli/shell/model.ts` | info line and footer from the snapshot (`no session` vs `(no peers yet)`), per-peer `♥ Ns`/`quiet Ns`, link silence for subs |
| `src/cli/commands/session.ts` | forward sub `error` events in `joinSessionFlow`; longer control timeout for `intent`; `/join` usage hint text unchanged for the CLI |
| `src/session/channel.ts` | `SessionWire.silenceMs()` |
| `src/session/master.ts` | `presence()`, named `left` events, no event for control closes, descriptive `NoMatchError` |
| `src/session/sub.ts`, `src/session/index.ts` | `SubHandle.silenceMs?()`, `MasterHandle.presence?()` |
| `CHANGELOG.md` | `[Unreleased]` notes |

## 6. Tests

* `join-args.test.ts`: all four forms, both positional orders, `=` flags, conflicts, garbage.
* `session-controller.test.ts`: transitions none → joining → joined → none; stale generation
  ignored; peers cleared on end; external probe success/failure; intent gate messages; leave
  reasons.
* `run.test.ts` (shell integration with the fake session API): `/join host:port code`; zero-peer
  intent refused without touching the master; external master detected at startup (control
  server fake) → header + intent via control; late roster after leave does not resurrect peers;
  peer-left event logged with device and reason; `/status` while joined-only.
* `model.test.ts` (frame goldens, ASCII, 80×24): no session; master with 0 peers; master with a
  quiet peer.
* `src/session` tests: `presence()` and named `left` event over a socket pair; `NoMatchError`
  text.

## 7. Out of scope

Website, npm publish, tagging, version bump, blackboard, automatic reconnect/resume of a sub
(needs a protocol change: resumable peer identity), Grok-style visual polish.

## 8. Open questions for the parent

1. Should a dropped sub **auto-rejoin**? Today a join code is single-use, so it cannot without a
   protocol change (resume token). This pass only explains and shows the current code.
2. Should the shell *attach* to an external master (send intents through it), or only report it?
   This plan attaches (intents via control, peers via 2 s polling) because that is what the
   user expected on the trial.
3. Should intents with no matching repo fall back to "any peer" (ignore repo)? Kept strict.
