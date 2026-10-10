# TUI/session reliability review

Date: October 10, 2026. Reviewer: My Codex.
Branch: `feat/tui-session-reliability`; reviewed `main...HEAD`, all six commits from
`d4095f9` to `929f0ab`. Re-read the implementation plan and READY hand-off, including their
explicit no-publish and no-automatic-reconnect boundaries. This review changes no source files.

## Architecture summary

`SessionController` now owns the in-process master, pending/current join, generation-checked
sub roster, and cached status of a master in another process. `Shell.sync()` copies its snapshot
into the header, session flag, peer footer, and link-age display
(`src/cli/shell/session-controller.ts:36`, `src/cli/shell/run.ts:683`). Own-master intents call
the handle directly; joined-only shells refuse intents; external-master intents use the control
client. `/status` distinguishes these modes (`src/cli/shell/run.ts:326`,
`src/cli/shell/run.ts:361`).

The protocol change is observational, not a reconnect redesign: `SessionWire` exposes local
monotonic silence age, master/sub handles expose presence, master leave events identify the
peer, and sub callback errors reach scrollback. No wire-schema change or dependency was added.
The important remaining seam is external attachment: cached display state and the control
endpoint used for actions are still independent.

## Per-bug verdicts

| Bug | Verdict | Evidence and limitation |
| --- | --- | --- |
| 1. `no session` with visible peers / blocked free text | **PARTIAL** | Owned-flow state is substantially fixed: one snapshot drives the model (`src/cli/shell/run.ts:683`), ended/stale joins cannot repopulate the roster (`src/cli/shell/session-controller.ts:98`, `src/cli/shell/session-controller.ts:106`), and non-live frames hide peers (`src/cli/shell/model.ts:180`). Startup external attachment works on the happy path (`src/cli/shell/run.ts:147`). However, failed/ended joins erase an external master, and overlapping probes can overwrite newer truth: B2/B3 recreate `no session` and blocked text while a local master still runs. B1 can instead display one session while acting on another. |
| 2. `/intent` gives opaque `no_match` with zero peers | **FIXED** | The shell refuses a zero-peer master before submitting and supplies the shareable join command (`src/cli/shell/session-controller.ts:222`, `src/cli/shell/session-controller.ts:229`, `src/cli/shell/run.ts:327`). Own-master submission avoids the control-file detour (`src/cli/shell/run.ts:331`). Real `NoMatchError` messages now cross the control port (`src/session/master.ts:320`); shell repo explanations name peers (`src/cli/shell/session-controller.ts:238`). The control intent deadline is 40 seconds (`src/cli/commands/session.ts:64`). This verdict covers the reported empty-session path, not B1's stale external-session routing. The separate Commander intent command still records an empty-session `no_match`, with clearer text; the plan only promises prevention in the shell. |
| 3. `/join host:port code` parsed as a code | **FIXED** | Positionals are classified as code or host and combined with validated flags (`src/cli/shell/join-args.ts:30`). All four requested forms, reversed positionals, equals flags, and bracketed IPv6 have unit coverage (`src/cli/shell/join-args.test.ts:5`); the shell integration test checks the originally failing host-first form (`src/cli/shell/run.test.ts:382`). Repeated flags and space-separated codes remain grammar/documentation holes, noted below. |
| 4. Peers disappear / flaky presence | **PARTIAL** | Named leave events and suppression of routine control-close noise are implemented (`src/session/master.ts:443`). Silence age updates on received session frames and renders as heartbeat/quiet text (`src/session/channel.ts:149`, `src/cli/shell/model.ts:230`, `src/cli/shell/run.ts:683`). Sub-side errors are forwarded (`src/cli/commands/session.ts:2012`), and leave messages explain manual rejoin (`src/cli/shell/run.ts:630`). This improves visibility, but the original real-device disconnect cause remains unproven; transport behavior and the 30-second drop policy are unchanged. B2 also loses the external-master view after a self-peer disconnect. Automatic reconnect is explicitly out of scope, not a blocker by itself. |

## Blocking findings

### B1 — P1: External intents are not bound to the displayed master

**Evidence:** `src/cli/shell/session-controller.ts:201`, `src/cli/shell/run.ts:336`,
`src/cli/commands/session.ts:2286`.

The intent gate reads cached external status, but returns only `{ kind: "control" }`. The
subsequent `submitIntent(ctx, text)` re-reads `session.json` for the endpoint and token. There
is no check that this is the master whose session, repo, and peers the user is seeing.

**Reproduction:** Attach the shell to master A, with a connected peer. Stop A and start master B
on the same device before the next status poll, potentially for a different repo. Submit text.
An inline fake-socket reproduction through the production shell/control client displayed
`session-A app-A`, sent the intent to B's port `7420` with B's token, accepted
`B-intent-1`, and still displayed A afterward. No files or real sockets were needed.

**Impact:** An apparently successful intent can start work in the wrong session/repository.
This is the session split-brain the controller was supposed to eliminate, not merely a delayed
peer count. The cached status can also overwrite a current `no_match` with a misleading repo
explanation (`src/cli/shell/run.ts:340`).

**Required fix/test:** Bind external actions to the discovered endpoint/token/session identity;
reject or explicitly reattach when that identity changes. Test replacement of the control file
between attachment and submission, including a different repo. The new external integration
test uses one unchanging master (`src/cli/shell/run.test.ts:435`) and misses this case.

### B2 — P2: A failed or ended join permanently forgets a live external master

**Evidence:** `src/cli/shell/session-controller.ts:75`,
`src/cli/shell/session-controller.ts:91`, `src/cli/shell/session-controller.ts:98`,
`src/cli/shell/run.ts:601`, `src/cli/shell/run.ts:630`, `src/cli/shell/run.ts:730`.

`beginJoin()` clears `external`. Neither join failure nor join closure restores or re-probes
it. `sync()` therefore switches to `none`, and automatic discovery stops: the ticker only runs
while live, and it only probes when `externalStatus !== null`
(`src/cli/shell/run.ts:745`).

**Reproduction:** Open a shell attached to a master running in another terminal. Attempt a
self-join that is declined or uses a wrong, well-formed code. The production shell with a fake
rejecting `connectSub` changed to `no session`, cleared its external status, and refused the next
intent with `no session on this device`; it issued no recovery control request. The same
transition follows a successful self-join that later drops, even if the master and other peers
remain connected. Explicit `/status` happens to recover the attachment.

**Impact:** The reported false no-session/free-text failure returns during ordinary retry and
disconnect handling. Users may be told to `/start` even though a master already exists.

**Required fix/test:** Re-discover the local external master when an owned join fails or ends,
without reusing an unvalidated stale snapshot. Cover external -> joining -> failed and external
-> self-joined -> disconnected, with the master still alive. The existing leave regression uses
a remote join with no external master (`src/cli/shell/run.test.ts:404`).

### B3 — P2: Concurrent external probes can overwrite newer session truth

**Evidence:** `src/cli/shell/run.ts:151`, `src/cli/shell/run.ts:371`,
`src/cli/shell/run.ts:706`, `src/cli/shell/session-controller.ts:119`.

Startup, `/status`, and ticker probes are not single-flight or generation-checked. The state
captured as `before` is only used for messages; every completed request can apply its result.
Join roster generations do not protect external discovery.

**Reproduction:** Keep the startup probe pending, run `/status`, let that newer probe succeed,
then fail the older probe. An inline fake-socket reproduction changed the mode from `external`
to `none` and `sessionLive` to false. Because polling is gated on that cleared state, recovery
requires another explicit `/status`. Reversing the outcomes lets an old success resurrect a
master that a newer request already found absent.

**Impact:** A transient older connection failure can clear a healthy master and its peers after
the user just confirmed it was live. The failure can remain indefinitely, rather than for one
poll interval.

**Required fix/test:** Serialize/coalesce discovery or apply only the current probe generation,
also invalidating in-flight probes on ownership changes and shutdown. Add deterministic tests
for both response orders, plus a probe completing across a join/start transition. Current
controller tests only exercise synchronous `setExternal` (`src/cli/shell/session-controller.test.ts:146`).

## Non-blocking notes

- **Join grammar:** `parseFlags` overwrites repeated valued flags
  (`src/cli/shell/flags.ts:25`). Reproduced: `--host a:7419 --host b:7419 --code 123456789012`
  silently selects `b:7419`; two `--code` flags also select the last. Positional conflicts are
  rejected, but flag/flag conflicts bypass the plan's two-host/two-code rule. Reject duplicates
  or document last-value-wins explicitly and test it.
- **Spaces and usage:** The plan says spaces in codes are optional, but splitting argv on
  whitespace (`src/cli/shell/flags.ts:14`) rejects `--code 1234 5678 9012`; quotes are not parsed
  either. Document contiguous/dashed codes unless supporting this syntax. Host-only `/join`
  errors also omit the accepted-form list (`src/cli/shell/run.ts:559`). None of these prevents
  the four requested happy-path forms.
- **Presence coverage:** The new presence clock only skips time without firing sleepers
  (`src/session/master.presence.test.ts:33`, `src/session/master.presence.test.ts:86`). Tests
  demonstrate ages and explicit close events, not heartbeat resets, the actual 30-second timeout,
  sleep/wake, or rejoining after expiry. The shell timeout test injects the close reason rather
  than exercising the wire timer (`src/cli/shell/run.test.ts:422`). Add these follow-up cases.
- **Docs/diagnostics:** The READY expectation of disappearance within about two seconds is
  optimistic: the tick awaits a status request whose timeout is ten seconds
  (`src/cli/shell/run.ts:745`, `src/cli/commands/session.ts:59`). Callback failures are visible
  but still generic (`src/session/sub.ts:110`), not a diagnosis of the failing git operation.
  Qualify the changelog's claim that views/actions can no longer disagree until B1-B3 are fixed.
- **Style/scope:** The controller, direct own-master routing, generation guard, Clock-based ages,
  and focused file boundaries are sound choices. No source changes are requested in this review
  checkout; no version bump, merge, tag, or publication was performed.

## Validation

- `npm run lint`: **PASS**; Biome and `tsc --noEmit` succeed.
- `npm run lint && npm test`: lint passes; the full test command exits 1. Results:
  **25 test files passed / 5 failed; 473 tests passed / 45 failed; 6 unhandled errors**.
  Socket-dependent failures include `listen EPERM: operation not permitted 127.0.0.1`, verified
  with focused reruns of presence and CLI work-item tests. The seven failures in the unchanged
  `src/util/exec.test.ts` include empty child stdout where output is expected. These results
  do not independently establish source regressions, but this checkout's full gate is not green
  in this restricted environment; the READY report of 518 passing tests was not reproduced here.
- Focused parser/controller/model suite: **27/27 PASS**.
- Shell suite excluding the sandbox-blocked external-listener case: **16 PASS / 1 skipped**.
- Additional inline, in-memory fake-socket/controller checks reproduce B1-B3 and duplicate flag
  acceptance through production code. They create no source/test files and use no real network.
- No two-device Mac/LAN trial or real agent CLI run was possible here. Re-run the complete suite
  in an environment permitting loopback listeners before treating the hand-off gate as verified.

## Two-device Mac + LAN risk

**Overall: not ready for reliability sign-off.** The direct Mac-shell `/start` plus second-device
host-first `/join` path is substantially improved: empty-peer intents fail helpfully, owned
session display is coherent, and disconnects are identifiable. For an uninterrupted LAN, the
remaining risk is moderate pending real-device verification. Repo names must still match.

Risk is high when the Mac uses multiple terminals or restarts its master: B1 can send work to a
replacement session, and B2/B3 can strand the shell in a false no-session state. Sleep, Wi-Fi
interruption, and firewalls can still drop peers after 30 seconds; a fresh single-use join code
and manual `/join` are expected, not transparent recovery. Fix B1-B3, add their regression
tests, then run the READY two-device checklist, including rejected self-join, master replacement,
and concurrent `/status` during discovery. The environment-limited test failures alone do not
drive this verdict; the independently reproduced correctness failures do.

**Verdict: FAIL.**
