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

## Fix round

Date: October 10, 2026. Reviewer: My Codex. Reviewed `c6cb3cf..f5179ff` on
`feat/tui-session-reliability`: `3b1a9dc`, `4d0f0eb`, `d649f64`, `00ebacb`, and `f5179ff`.
Re-read the prior blockers, implementation brief/plan, complete fix diff, regression tests,
READY hand-off, and CHANGELOG. This appendix is the only repository change; no source edits,
merge, publication, or version bump.

### Prior blockers

| Finding | Fix verdict | Evidence and tests |
| --- | --- | --- |
| B1 — external intents target a different master from the displayed one | **FIXED** | `ExternalMaster` couples the discovered endpoint/token with its status; the intent route carries that identity (`src/cli/shell/session-controller.ts:39`, `src/cli/shell/session-controller.ts:255`). The shell checks the published identity and submits to the captured endpoint, not a newly read destination (`src/cli/shell/run.ts:368`, `src/cli/commands/session.ts:2382`). Replacement-file and old-token regressions are in `src/cli/shell/run.test.ts:565` and `src/cli/shell/run.test.ts:587`. Independent in-memory production-shell checks confirm that A-to-B replacement with a different repo sends to neither master, refreshes the view to B, and routes only an intentional resend to B; same-port token replacement also rejects the old action. This closes wrong-master routing, but its new connection-error messaging has the separate R1 blocker below. |
| B2 — a failed/ended join permanently forgets a live external master | **FIXED** | Join failure, join closure, and own-master closure now trigger fresh discovery (`src/cli/shell/run.ts:658`, `src/cli/shell/run.ts:689`, `src/cli/shell/run.ts:595`), rather than restoring a cached snapshot. `src/cli/shell/run.test.ts:599` covers a rejected self-join and a subsequent successful external intent; `src/cli/shell/run.test.ts:613` covers a self-join heartbeat disconnect. Independent in-memory production-shell checks pass both transitions without `/status`, including restored intent routing after rejection. |
| B3 — older discovery results overwrite newer truth | **FIXED** | `beginProbe`/`applyProbe` accept only the latest generation; master/join acquisition and shutdown invalidate pending discovery (`src/cli/shell/session-controller.ts:78`, `src/cli/shell/session-controller.ts:89`, `src/cli/shell/session-controller.ts:134`, `src/cli/shell/run.ts:875`). The production probe uses this guard and a two-second status deadline (`src/cli/shell/run.ts:767`). `src/cli/shell/session-controller.test.ts:164` tests both older-result orders, ownership transitions, and shutdown; `src/cli/shell/run.test.ts:625` holds startup discovery across `/start`. The controller tests pass. Independent in-memory production-shell checks also pass older-failure-after-newer-success, older-success-after-newer-miss, a failed-join transition, and shutdown. |

The added socket regressions are present and target the right scenarios, but cannot complete
against real loopback sockets in this sandbox. The independent checks replace file reads and
sockets in memory, exercise production code, and create no source/test files; they do not
substitute for a real TCP/LAN gate.

### Remaining blocker

#### R1 — P2: A lost intent reply is falsely reported as non-delivery, inviting duplicate work

**Evidence:** `src/cli/shell/run.ts:379`, `src/cli/shell/run.ts:391`,
`src/cli/commands/session.ts:286`, `src/cli/commands/session.ts:311`,
`src/cli/commands/session.ts:2330`, `src/session/master.ts:314`.

The new `sendExternalIntent` treats every `session_unreachable` as an identity change and calls
`externalChanged`. However, that code includes a connection closing **after** the request was
written, an acknowledgement timeout, and a malformed control-result. None proves that the
master did not accept the intent. The master starts `submitIntent` before sending its reply;
losing the control connection does not cancel the accepted intent. Nevertheless, the shell
unconditionally says `the intent was not sent` and, after successful rediscovery, advises
`check /status and resend` even when it has rediscovered the **same** master.

**Deterministic reproduction:** Run the production `Shell`, `startMaster`, and `connectSub`
with paired in-memory Duplex streams, a parked injected Clock, and virtual session-file reads.
Allow the master to accept `add a health check`, but drop its successful control reply and
close that control stream. Keep status replies and the peer link working. Assertions confirm:

- The master already has `intent-1` in state `planned`, and the sub receives work item `I-1`.
- The shell rediscovers the unchanged session yet says `the intent was not sent` and suggests
  resending.
- Following that hint creates `intent-2`, also `planned`, with identical text; the same sub
  receives distinct work item `I-2`. Both plans survive the lost acknowledgement.

This reproduction passes through the real control client, master/sub handshake, routing, and
plan delivery; only the listener/socket transport and file reads are faked. No kernel listener,
real network, or agent CLI is involved. The new tests cover pre-send replacement and explicit
`bad_token`, not this post-send uncertainty. CHANGELOG's new “stops answering … not sent
anywhere” claim and READY's unreachable-endpoint guarantee are consequently too strong.

**Required fix/test:** Distinguish known pre-send non-delivery or explicit token rejection from
an unknown post-send outcome. Re-probing is appropriate, but connection loss/timeout must say
that the intent **may have been accepted**, advise inspecting `/status`, and not claim a master
change when identity is unchanged or imply that retry is safe. Add a regression where an intent
is accepted and its reply is lost; preserve the existing replacement/token tests. Idempotent
retry would require additional design, but is not necessary to fix the false assurance.

### Other notes and documentation

- Repeated valued flags are now rejected, with repeated `--host`/`--code` tests; host-only
  `/join` errors include accepted forms. The one-word code limitation is acknowledged in READY.
- Discovery's two-second request deadline makes READY's revised approximately 2–4-second
  disappearance expectation consistent with the polling path. The replacement checklist now
  acknowledges that a poll can deliberately reattach before the user types.
- The previous heartbeat-reset, real 30-second expiry, sleep/wake, rejoin-after-expiry, and
  callback-diagnostic follow-ups remain explicitly deferred. No two-device Mac/LAN trial was
  performed. These are notes, not the reason for the fix-round failure.

### Fix-round validation

- `npm run lint && npm test`: lint **PASS**; full suite **FAIL**, with **25 files passed / 5
  failed; 480 tests passed / 50 failed; 11 unhandled errors**. Loopback listeners still fail
  with `listen EPERM: operation not permitted 127.0.0.1`; the six socket-based shell tests
  consequently time out. The unchanged subprocess tests again receive empty child stdout,
  and CLI work-item tests fail in this environment. The reported 530-test green READY gate
  is not reproduced here; these failures alone do not establish a fix-round regression.
- Focused controller/parser/model tests: **34/34 PASS**, including all discovery-generation
  and duplicate-flag cases.
- Shell tests excluding the six listener-dependent cases: **16 PASS / 6 skipped**.
- Independent in-memory production-shell checks: **eight B1–B3 checks PASS**. A separate
  production-master/sub check confirms R1 by observing two planned intents and two delivered
  work items after the shell's resend hint.

B1–B3 are resolved, but R1 remains a correctness blocker for reliability sign-off. Re-run the
complete gate where loopback listeners and subprocess output work, and perform the READY
two-device checks after fixing R1. No release action is authorized by this review.

**Fix verdict: FAIL.**

## Fix round 2 (R1)

Date: October 10, 2026. Reviewer: My Codex. Reviewed `30ba79b..a011670` on
`feat/tui-session-reliability`, including `2f8db19` and `a011670`, against the R1 finding above.
This appendix is the only repository change; no source edits, merge, publication, or version
bump.

### R1 — FIXED

- `ControlConnectionError.requestSent` distinguishes failure before the socket write from an
  uncertain outcome after it (`src/cli/commands/session.ts:258`). Close, transport error, and
  reply timeout retain that distinction; malformed frames, JSON, and control-results are also
  treated conservatively (`src/cli/commands/session.ts:273`). For intents, post-send failures
  become `intent_outcome_unknown`, not `session_unreachable`
  (`src/cli/commands/session.ts:2362`). An `ok` result with an unreadable intent ID also takes
  the uncertainty path (`src/cli/commands/session.ts:2432`). Read-only status failures remain
  ordinary reachability errors.
- The shell handles the unknown outcome before its known-non-delivery branch
  (`src/cli/shell/run.ts:383`). It says **“it may have been accepted”**, warns **“sending it
  again could start the same work twice”**, and re-probes without retrying the intent. An
  unchanged endpoint/token says **“the master is still …”** and points to `/status`; a gone
  or replacement master retains uncertainty about the previous master
  (`src/cli/shell/run.ts:399`). None of those cases claims “not sent”, an identity change for
  the unchanged master, or a safe resend.
- Known pre-send replacement, refused connection, and explicit `bad_token` still take the
  non-delivery path and say **“the intent was not sent”** (`src/cli/shell/run.ts:375`,
  `src/cli/shell/run.ts:388`). A resend hint remains confined to that known-failure path.
- The added shell regression records one received intent, drops its reply, and asserts the
  uncertainty warning, unchanged identity, `/status` guidance, and absence of “not sent”,
  “changed”, and “resend” (`src/cli/shell/run.test.ts:610`). The new control-client tests cover
  refused connection, post-write close, malformed successful ID, token rejection, and lost
  status reply (`src/cli/commands/session.control.test.ts:46`). READY and CHANGELOG now
  distinguish known non-delivery from lost acknowledgements rather than promising that every
  unreachable master received nothing.

### B1–B3 preservation

- **B1 remains FIXED:** the published endpoint/token pre-check and submission to the captured
  displayed endpoint remain intact (`src/cli/shell/run.ts:375`). Existing replacement/token
  tests are preserved (`src/cli/shell/run.test.ts:576`, `src/cli/shell/run.test.ts:598`).
  Independent checks confirm no accepted intent on either master for pre-send replacement,
  refusal, or token rejection, and no automatic submission to a replacement after a lost reply.
- **B2 remains FIXED:** failed/ended join and ended own-master recovery still trigger fresh
  discovery (`src/cli/shell/run.ts:634`, `src/cli/shell/run.ts:697`,
  `src/cli/shell/run.ts:733`); those paths and their regressions are unchanged by this diff.
- **B3 remains FIXED:** controller generations, ownership/shutdown invalidation, and the guarded
  production probe are unchanged (`src/cli/shell/run.ts:802`). The focused controller suite
  passes both stale-result orders and ownership/shutdown cases
  (`src/cli/shell/session-controller.test.ts:164`).

### Validation and notes

- `npm run lint && npm test`: lint **PASS**; full suite **FAIL** in this sandbox: **25 test
  files passed / 6 failed; 480 tests passed / 58 failed; 19 unhandled errors**. Loopback
  listeners fail with `listen EPERM: operation not permitted 127.0.0.1`, blocking the seven
  external-shell tests and all seven new control-client tests. The previously observed
  subprocess-output and CLI work-item failures also recur. This is not a green release gate,
  but these environment failures do not establish an R1 regression.
- Focused controller/parser/model tests: **34/34 PASS**. Shell tests excluding listener-dependent
  cases: **16 PASS / 7 skipped**.
- Independent, inline in-memory checks: **16/16 PASS** through production `Shell`, control
  client, `startMaster`, and `connectSub`. Nine accepted-intent cases cover lost reply with
  unchanged/gone/replacement discovery, post-write transport error, reply timeout, malformed
  JSON/frame/control-result, and malformed successful ID. Each leaves exactly one additional
  planned intent and one delivered sub work item, with uncertainty wording and no automatic
  retry. Three known-non-delivery cases accept no intent; direct-client checks confirm unknown
  outcome, refused connection, token rejection, and subsequent readable status. Only transport,
  session-file reads, and clocks are faked; no kernel listener or filesystem write is involved.
- Non-blocking follow-up: make timeout, malformed wire reply, and gone/replacement unknown-outcome
  cases permanent regression tests. Re-run the complete gate where loopback and subprocess
  output work, then perform the READY two-device checks; no Mac/LAN or real agent CLI trial was
  performed here. Idempotent retry remains outside this fix, not an implied guarantee.

R1's false non-delivery assurance is resolved, with B1–B3 preserved. The notes concern validation
limits and durable coverage, not an outstanding R1 correctness blocker. No release action is
authorized by this review.

**Fix verdict: PASS_WITH_NOTES.**
