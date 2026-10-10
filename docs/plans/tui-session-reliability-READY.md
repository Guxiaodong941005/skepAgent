# READY: TUI / session reliability (post-0.1.6)

Branch: `feat/tui-session-reliability` (from `main` @ `d4095f9`). Plan:
`docs/plans/tui-session-reliability.md`.

> **Do not publish.** No version bump, no tag, no `npm publish`, not merged to `main`. The parent
> decides the release (changes are under `CHANGELOG.md` `[Unreleased]`).

Gate on the final commit: `npm run lint && npm test && npm run build` are green here (30 test
files, 530 tests). Several tests (shell external-master cases, `master.presence.test.ts`, CLI
work-item tests) need loopback listeners; the reviewer's sandbox denied `listen` (`EPERM`), so
run the gate where `127.0.0.1` listeners are allowed.

## Fix round (review `docs/reviews/tui-session-reliability.md`, verdict FAIL)

| Finding | Fix | Commit | Regression tests |
| --- | --- | --- | --- |
| B1 — external intents not bound to the displayed master | The controller stores an external master as `{ endpoint: { listen, token }, status }`. Intents go to exactly that endpoint (`submitIntentAt`). Before sending, `session.json` must still name the same endpoint; a changed file, a `bad_token` (replacement on the same port) or an unreachable endpoint sends nothing, re-discovers, and reports `the session master on this device changed (was …); the intent was not sent` plus what is shown now. A `no_match` is explained from a fresh status of the routed endpoint. | `4d0f0eb` | `run.test.ts`: "never sends an intent to a replacement master…" (A→B swap, different repo; resend goes to B on purpose), "rejects an intent when the shown master's endpoint stopped accepting its token" |
| B2 — failed/ended join forgets a live external master | `probeExternal()` runs after a failed join, an ended join and an ended own master. It reads `session.json` and a fresh `status`; the old snapshot is never restored. | `4d0f0eb` | `run.test.ts`: external → join rejected → external; external → self-joined → `heartbeat_timeout` → external |
| B3 — concurrent probes overwrite newer truth | `beginProbe()` / `applyProbe(generation, found)`: only the newest discovery applies; `setMaster`, `beginJoin` and shutdown call `invalidateProbes()`. Discovery uses a 2 s status timeout. | `4d0f0eb` | `session-controller.test.ts`: older-fail-after-newer-success, older-success-after-newer-miss, probe across `/start` and across a failed join, shutdown; `run.test.ts`: held startup probe completing after `/start` |

Non-blocking notes taken: repeated `--host`/`--code` are rejected (`3b1a9dc`); host-only `/join`
errors show the usage list; `JOIN_USAGE` documents that a code is one word (dashes allowed,
spaces not — the shell splits arguments on whitespace and has no quoting). The CHANGELOG no
longer claims the views "can no longer disagree". Not taken (follow-ups): heartbeat-reset and
real 30 s timeout tests with a firing clock, sleep/wake and rejoin-after-expiry tests, and a
specific diagnosis of which git callback failed in `callback_error`.

## Bugs addressed

| # | Bug | Fix | Commit | Files |
| --- | --- | --- | --- | --- |
| 1 | Header `no session` while a peer row shows; free text says `no session` | `SessionController` is the only session state; the model copies its snapshot. Rosters carry a join generation and are dropped once that join ended/failed; peers are cleared with their flow. A master in another process (found via `session.json` + live `status`) is attached: header `master (other process) · code …`, peers polled every 2 s, intents go to it. Leaving explains the reason so the old `peer … idle 0%` line no longer looks like a live strip. | `c27e9e1` | `src/cli/shell/session-controller.ts`, `run.ts`, `model.ts` |
| 2 | `/intent` → `Unable to route the session intent` / `no_match` with no peers | Shell refuses intents when no peer joined, before contacting the master, with the `/join <code> --host <listen>` line to share. A `no_match` names each peer's repo. A joined-only shell says intents belong in the master's shell. The master's `NoMatchError`/control error is descriptive. Control `intent` timeout 40 s (> 30 s datalist wait). | `0571db4`, `c27e9e1` | `src/session/master.ts`, `src/cli/commands/session.ts`, `src/cli/shell/session-controller.ts`, `run.ts` |
| 3 | `/join 192.168.30.182:7419 8632-1727-0308` → `--code must be 12 digits` | `parseJoinArgs` classifies positionals by shape; four forms accepted, everything else rejected with the usage list. | `2d045f1` | `src/cli/shell/join-args.ts`, `flags.ts` |
| 4 | Peers disappear; session feels flaky | Master emits `Peer peer-2 (mac) left: <reason>` (shell adds an explanation and the rejoin command) and `join-failed`; control-request closes no longer emit noise. Sub-side `error` events are shown. Heartbeat display: `hb Ns` per peer on the master, `master hb Ns` on a peer, `quiet Ns` after 20 s. | `0571db4`, `c27e9e1` | `src/session/{channel,master,sub,index}.ts`, `src/cli/commands/session.ts`, `src/cli/shell/*` |

Tests: `src/cli/shell/join-args.test.ts`, `session-controller.test.ts`, `model.test.ts` (frame
goldens in `__snapshots__/`), `run.test.ts` (shell with fake session API and a fake control port),
`src/session/master.presence.test.ts` (real sockets on loopback).

## Reconnect expectations (documented, not changed)

There is **no automatic reconnect**. A join code is single-use and rotates once proved, so a
dropped peer (laptop sleep, Wi-Fi, `heartbeat_timeout` after 30 s of silence) must `/join` again
with the master's **current** code. Both sides now say so: the master logs the leave with
`it can rejoin with the current code: /join <code>`; the peer logs `left the session (<reason>: …)`
and `the join code is single-use: /join again with the master's current code`. Items assigned to
the dropped peer are marked failed by the master (unchanged protocol behavior).

## Manual verification on two devices

Same skep build on both (e.g. `npm run build && npm link` from this branch). Mac = master,
peer = second machine on the same LAN, both inside a checkout of the **same repo name**.

1. **Master:** `skep` → `/start` → note `join code` and `listen`. Header shows
   `master · code … · <listen>`, footer `(no peers yet)`, info line `peers 0`.
2. **Bug 2:** on the master type `add a health check`. Expect `no peers joined yet — …` and the
   `/join … --host …` line. `/status` shows `intents: none` (nothing recorded as `no_match`).
3. **Bug 3:** on the peer: `skep` → `/join <listen> <code>` (host first). Expect the fingerprint,
   `joined session … as peer-N`, header `joined <listen> as peer-N · coding`. Also try
   `/join <listen> nope` → error with the four accepted forms.
4. Master accepts with `y`. Master footer shows the peer row with `hb Ns`; peer info line shows
   `master hb Ns`; seconds stay below ~10 (heartbeats every 10 s).
5. On the master, type an intent; expect `intent intent-N routed: …`, then plan/claim events.
   From the peer, typing text says intents belong in the master's shell.
6. **Bug 4:** sleep the peer (or disable Wi-Fi) for > 30 s. Master: the row shows `quiet 2Xs`,
   then `Peer peer-N (<device>) left: heartbeat_timeout: no heartbeat for 30 s …` and the rejoin
   line; footer back to `(no peers yet)`. Peer, on wake: `left the session (…)` + rejoin hint,
   header `no session`, no leftover strip. `/join <listen> <new code>` works again.
7. **Bug 1:** on the master device run `skep session start --yes` in one terminal, then open
   `skep` in another. Expect `a session master runs in another process on this device (…)`,
   header `master (other process) · code …`, `/status` showing the session, peers in the footer.
   Stop the master: within about 2–4 s (2 s poll plus up to 2 s probe timeout) the shell says `the session master at … went away`, header
   `no session`.
9. **B1 (master replacement):** with the shell attached as in 7, stop that master and start
   another one (ideally `--repo other`) in the other terminal *before* typing anything. Type an
   intent: expect `the session master on this device changed (was …); the intent was not sent`
   and `now showing …`. The new master's `skep session status` shows no intent. Typing again
   sends to the new master.
10. **B2 (rejected self-join):** with the shell attached as in 7, `/join` and answer `n` on the
    master's prompt. Expect the rejection, then the header back to `master (other process)`
    without `/status`. Repeat with `y`, then kill the self-join's link (or wait for a timeout):
    the shell returns to `master (other process)`.
11. **B3:** while attached, run `/status` several times quickly while the master is slow or
    briefly stopped/restarted; the header must end in the state the last answer reported.
8. Repo mismatch: join from a checkout of a different repo name, send an intent on the master.
   Expect `no connected peer works on repo <repo> (peer-N <device>: repo <other>)`.

## Open questions / residual risks

1. **Auto-rejoin.** Needs a protocol change (resumable peer identity / resume token). Not done.
2. **External master attach** sends intents to a master owned by another process and polls its
   status over the control port every 2 s (each poll is one loopback TCP request). If the parent
   prefers a read-only notice instead, drop `probeExternal`'s attach and keep the notice.
3. **Repo strictness.** Intents still route only to peers whose repo name equals the master's
   repo (or `--repo`). No fallback to "any peer".
4. A peer's repo is only known after its first capability reply, so a repo mismatch is explained
   after the `no_match`, not prevented before it.
5. **Role** is advertised but not a routing input; a "role mismatch" cannot cause `no_match`.
6. Presence ages are local monotonic readings at the time of each 250 ms tick; they are not a
   network RTT. `quiet` starts at 20 s (two missed heartbeats); the protocol drops at 30 s.
7. The actual trial disconnect cause was not reproduced. Candidates, now all visible in the
   scrollback with explanations: `heartbeat_timeout` (sleep/Wi-Fi power saving),
   `connection_closed`/`transport_error`, and `callback_error` (the peer's `git rev-parse HEAD`
   or `git ls-files` failing, e.g. a repo without commits).
8. `skep session join` (Commander) still requires `--code`; only the shell's `/join` grammar
   changed.
9. `MasterHandle.presence` and `SubHandle.silenceMs` are optional interface members; the shell
   shows no heartbeat age when a backend omits them.
