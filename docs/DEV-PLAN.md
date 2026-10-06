# Skep MVP — Development Plan

> Companion to `docs/ARCHITECTURE.md` (design) and `docs/PRD-v0.4.md` (requirements).
> Tasks are sized for one coding agent in one git worktree (≈ 30–90 min each). Tasks in the same
> wave touch **disjoint files** and depend only on earlier waves, so they can run in parallel and
> merge without conflicts. Every task must leave `npm run lint` and `npm test` green.
>
> Assignment rule: **codex** = core/complex logic (reducer, lease protocol, git write path,
> signing, sync, adapter runtime, daemon). **pi** = scaffolding, test utilities, fixtures, docs,
> CLI plumbing, smaller well-specified tasks.
>
> Status values: `todo` · `in progress` · `review` · `done` · `done (architect)`.

## Conventions for every task

* Branch: `task/<ID>-<short-slug>` (e.g. `task/SK-101-reducer-core`), one worktree per task.
* Only touch the files listed in "Files/area" (plus colocated `*.test.ts`). If you must touch
  anything else, stop and note it in the PR/commit body instead.
* Done = acceptance criteria met + `npm run lint` + `npm test` pass + committed on the task branch.
* Shared contracts live in `src/core/**` (scaffold). Do not change a contract file owned by
  another task; if a contract is wrong, note it and implement against it anyway.

---

## Wave 0 — scaffold (architect)

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-000 | Repo scaffold & toolchain | – | architect | `package.json`, `tsconfig*.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.editorconfig`, `.nvmrc`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `src/bin/*` stubs | `npm ci && npm run lint && npm test && npm run build` pass | done (architect) |
| SK-001 | Protocol freeze: schemas & shared contracts | SK-000 | architect | `src/core/{ids,canonical,principal,log}.ts`, `src/core/schemas/*`, `src/core/reducer/state.ts`, `src/util/{clock,random}.ts`, `src/adapter/types.ts`, `src/runtime/types.ts`, `test/helpers/log-builder.ts` | Envelope + all 20 MVP event payloads, plan/review/report/snapshot/heartbeat/genesis/config schemas compile and have tests; `LogEntry` and `State` contracts documented | done (architect) |
| SK-002 | Architecture + dev plan | SK-001 | architect | `docs/ARCHITECTURE.md`, `docs/DEV-PLAN.md` | Documents exist and match the scaffold | done (architect) |

## Wave 1 — independent foundations (parallel)

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-101 | Reducer core: replay, structural rules, authz, preconditions, task & plan handlers | SK-001 | codex | `src/core/reducer/{genesis,structural,authz,preconditions,apply,replay,index}.ts`, `src/core/reducer/handlers/*.ts` (+ tests) | See task brief. Replay of builder logs is deterministic; every structural violation is a no-op `invalid`; authz matrix enforced; task/plan lifecycle (solo + team) reaches `executing`; `npx vitest run src/core/reducer` green | done |
| SK-102 | Git layer: runner, trust root, SSH signer, plumbing commits, signature verification | SK-001 | codex | `src/git/{runner,trust,signer,commit,verify}.ts` (+ tests), `test/helpers/git-fixture.ts` | See task brief. Real `git`+`ssh-keygen` tests: good/unsigned/unknown-key/tampered commits classified correctly using only the local allowed_signers; `npx vitest run src/git` green | done |
| SK-103 | Sim primitives: seeded RNG, virtual time & fake clock, backoff | SK-001 | pi | `src/sim/rng.ts`, `src/sim/fake-clock.ts`, `src/util/backoff.ts` (+ tests) | See task brief. Same seed ⇒ same sequence; suspend freezes monotonic time only; timers fire in deterministic order; `npx vitest run src/sim src/util` green | done |
| SK-104 | CLI skeleton: Commander program, all MVP commands stubbed, `--machine` output, paths | SK-000 | pi | `src/cli/{program,output,language}.ts`, `src/cli/commands/*.ts`, `src/config/paths.ts`, `src/bin/skep.ts` (+ tests) | See task brief. `skep --help` lists every MVP command; argument validation; stubs exit 4 with `not_implemented`; `--machine` errors are JSON; `npx vitest run src/cli src/config` green | done |

## Wave 2 — reducer completion, log reader, local plumbing

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-201 | Reducer: lease & delivery handlers | SK-101 | codex | `src/core/reducer/handlers/{lease,work,merge,barrier}.ts` (+ tests) | See task brief. Fills the SK-101 stubs; adds the shared barrier-settlement helper `handlers/barrier.ts`. lease.claimed/released/revoked, work.delivered/failed, item.merged, task.verified per ARCHITECTURE §5.5: epoch increments, `fenced`/`epoch_mismatch`/`max_parallel`/`retry_budget`/`bad_branch` rejections, dependents unblocked, task → delivered → done; stale-holder delivery after revoke is rejected | done |
| SK-202 | Reducer: replan, barrier, checkpoint handlers | SK-101, SK-201 (`handlers/barrier.ts`) | codex | `src/core/reducer/handlers/replan.ts` (+ tests) | Uses `settleBarrier` from `handlers/barrier.ts` (SK-201, do not edit it); replan.requested opens barrier `B<seq>`, flags leases, blocks claims; coalescing in interrupting/replanning; checkpoints settle barrier ⇒ replanning; barrier.closed ⇒ missing items unknown; 3rd request with budget 2 ⇒ escalated; daemon request without evidence ⇒ `missing_evidence`. **D16:** a barrier checkpoint sets the item `interrupted` and **keeps** its lease (with `interrupt` set) as a parked lease; do not change `activeLeaseCount` in `handlers/lease.ts`. Test: holder with `max_parallel_items: 1` checkpoints in task A ⇒ its claim in task B is accepted, while a flagged lease that has not checkpointed yet still yields `max_parallel` | done (PASS) |
| SK-203 | Git log reader → `LogEntry[]` (incremental) | SK-102 | codex | `src/git/log-reader.ts` (+ tests) | See task brief. Builds on `GitRunner` and `verifyCommits` from `src/git`. `readLog(git, dir, trustPath, {from?})` walks `rev-list --first-parent --reverse main`; parents, name-status, added-file contents (size-capped, UTF-8 checked), signatures in one `git log` pass; merge commits/multi-file/oversized files represented faithfully; reducer replay over a real repo equals replay over equivalent builder log | done |
| SK-204 | Reducer views + `statusView` | SK-101 | pi | `src/core/reducer/views.ts` (+ tests) | `claimableItems`, `leasesHeldBy`, `isOwner`, `pendingReviews`, `barrierStatus`, `statusView` (stable JSON, sorted keys) with unit tests over builder logs. **D16:** `claimableItems` uses `activeLeaseCount` from `handlers/lease.ts` (never its own count); `leasesHeldBy` marks parked leases (item `interrupted`) separately from active ones. **D14:** `statusView` shows `escalation.reason` (incl. `verification_failed`) and `verified` | done (PASS_WITH_NOTES) |
| SK-205 | exec/fs utilities + run journal | SK-001 | pi | `src/util/{exec,fs}.ts`, `src/exec/journal.ts` (+ tests) | See task brief. `execFileChecked` (shell:false, timeout, maxBuffer, env passthrough), `atomicWrite`, `appendFsync`, `safeJoin` (rejects `..`/absolute/symlink escape); journal append/read/`unfinishedAttempts()` with fsync; torn last line tolerated | done |
| SK-206 | Config loaders: device.toml, AGENT.md, checks.toml parsing | SK-104 | pi | `src/config/{device,agent-md,errors}.ts`, `src/exec/checks-file.ts` (+ tests, fixtures under `test/fixtures/config/`) | See task brief. Parse + validate with the scaffold schemas; helpful error messages with file/line; AGENT.md body extracted; repo allowlist lookup by name/url | done |
| SK-207 | Adapter spike: pinned Codex CLI | SK-001 | codex | `docs/spikes/adapter-codex.md`, `src/adapter/codex.ts` (+ opt-in test `test/integration/adapter-codex.test.ts`) | Report: exact flags for non-interactive run, output schema, last-message file, JSON events, interrupt behaviour (SIGINT), approval policy, usage fields, version string; `CodexAdapter` implements `AgentAdapter`; decision Codex vs Claude fallback recorded; **D19:** documents how the CLI authenticates from the agent user's local config with no credentials passed by the daemon. See the Wave 2b brief | done (PASS_WITH_NOTES after fix round) |
| SK-208 | Reducer: plan-mode routing (D13) | SK-101 | codex | `src/core/reducer/handlers/plan.ts`, `src/core/reducer/handlers/plan.test.ts` | ARCHITECTURE §5.5 "Plan mode decides routing": reviewers, post-proposal status and `plan.locked` gating use the current **plan's** mode; team task + solo plan ⇒ `invalid_plan`; solo plan with ≠ 1 item ⇒ `invalid_plan`; `activatePlan` sets `task.mode = plan.mode`. Tests: solo task + 2-item team plan ⇒ `reviewing` ⇒ lock ⇒ approve ⇒ `executing` with `task.mode` team; rejected/unapproved team plan leaves `task.mode` solo; after the switch a solo plan is rejected; existing solo/team lifecycles unchanged. **D15:** branch from `main` at or after the SK-209 commit and keep the status derivation at the end of `activatePlan` (D15 tests in `handlers/merge.test.ts` stay green). `npx vitest run src/core/reducer` green | done (PASS) |
| SK-209 | Reducer: close SK-201 protocol gaps D14–D16 | SK-201 | architect | `src/core/reducer/handlers/{merge,plan,lease}.ts` (+ `merge.test.ts`, `lease.test.ts`) | ARCHITECTURE D14–D16: `task.verified{passed:false}` ⇒ `escalated` (`verification_failed`); `activatePlan` ⇒ `done`/`delivered`/`executing` from the rebuilt items; `max_parallel` counts only `leased` items (`activeLeaseCount`). See "Protocol gap closure" below | done (architect) |

## Wave 3 — write path, sync, heartbeats, runtime

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-301 | Blackboard clone + publisher write loop + genesis bootstrap | SK-101, SK-102, SK-203, SK-103 | codex | `src/blackboard/{clone,publisher,genesis}.ts`, `src/core/intents.ts` (types + draft helper) (+ integration tests) | fetch→reset→recompute→push, never rebase; stable event_id; ambiguous push resolved via `seen_event_ids`; dropped intents; 8 concurrent publishers on one bare remote all land exactly once with linear history; genesis created human-signed | done (PASS after fix round) |
| SK-302 | Sync poller + state cache | SK-101, SK-203, SK-301, SK-308 | codex | `src/blackboard/sync.ts` (+ tests) | Fetch main + hb/*; incremental replay from cached tip == full replay; `observeNow()`; jittered adaptive interval via Clock; freshness metadata. **D18:** takes a `HintChannel` (default `NullHintChannel`); a `tip` hint triggers an early cycle at most once per 2 s (FakeClock test: 100 hints in 1 s ⇒ ≤ 1 extra fetch); a forged hint for an unknown sha changes nothing; `ls-remote` short-circuit skips the fetch when `main` and `hb/*` are unchanged | done (PASS after fix round) |
| SK-303 | Heartbeat writer/reader + liveness tracker | SK-102, SK-103 | codex | `src/blackboard/{heartbeat,liveness}.ts` (+ tests) | Orphan signed commit per beat, `--force-with-lease`; reader verifies principal matches agent device; `main` untouched; liveness live/stale/lost/unknown on observer monotonic clock; suspend reset; duplicate boot_id alarm | done (PASS_WITH_NOTES) |
| SK-304 | Reducer invariants + property tests | SK-201, SK-202, SK-208, SK-209 | pi | `src/core/reducer/invariants.ts`, `src/core/reducer/replay.property.test.ts`, `test/helpers/random-log.ts` | Seeded random log generator (valid + forged entries, incl. `task.verified{passed:false}`, `human.decided` after it, and replans that carry over every item); 1,000 logs: full == incremental, invariants 2–4, 6 (**per transition, D20**), **8 (status agrees with items, D14/D15) and 9 (`max_parallel` via `activeLeaseCount`, D16)** hold, forged entries are no-ops | done (PASS_WITH_NOTES after fix round) |
| SK-305 | Golden replay fixtures | SK-201, SK-202, SK-208, SK-209, SK-304 | pi | `test/fixtures/golden/*.json`, `test/integration/golden.test.ts`, `test/helpers/golden.ts` | ≥ 6 golden logs (solo, team, replan, escalate, forged, **verify-fail ⇒ escalate ⇒ resume ⇒ delivered ⇒ done**, D14/D15) with expected state hashes; update via `SKEP_UPDATE_GOLDEN=1` documented | done (PASS_WITH_NOTES) |
| SK-306 | Native runtime backend + interrupt ladder | SK-205 | codex | `src/runtime/native.ts`, `src/exec/interrupt.ts` (+ tests) | Detached spawn, pgid, start token (Linux /proc, macOS ps), group signals, `isAlive` guards PID reuse; ladder SIGINT→grace→SIGTERM→SIGKILL with injected Clock; tests kill a child tree | done (PASS_WITH_NOTES) |
| SK-307 | Structured output runner, prompts, fake adapter | SK-001 | codex | `src/adapter/{structured,prompts,fake}.ts` (+ tests) | JSON extraction (fenced/unfenced), Zod validation, exactly one repair; prompt builders for plan/review/work/fixup; fake adapter scripts (success, invalidJson, wrongEvidence, hang, slow, permissionPrompt, replanRequest, crash) | done (PASS_WITH_NOTES) |
| SK-308 | Transport interface: wake-up hints (D18) | SK-001 | codex | `src/transport/{types,null-hint,fake-hint}.ts` (+ tests) | ARCHITECTURE §17.3: `Hint` Zod schema (strict, ≤ 1 KiB, only `tip`/`wake`, unknown kinds and extra keys rejected); `HintChannel` interface; `NullHintChannel` (start/publish/stop are no-ops, `health()` disconnected); `FakeHintChannel` in `fake-hint.ts` for SK-302 tests; no mailbox or payload channel (dropped with D17, §17.2); no secrets in any hint field (D19) | done (PASS) |

## Wave 4 — simulation harness and lease safety

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-401 | Sim world, scheduler, faulty git, invariant checker, `empty` scenario | SK-301, SK-302, SK-303, SK-304 | codex | `src/sim/{world,faulty-git,invariants,runner}.ts`, `src/sim/scenarios/{index,empty}.ts`, `test/integration/sim/empty.test.ts`, `test/fixtures/keys/*`, `.gitleaks.toml` (fixed test keys moved here from SK-402) | 2 sim daemons on local bare repos with fixed test keys; seeded interleavings reproducible (same seed ⇒ same final tip sha); invariants checked every step | done (PASS_WITH_NOTES) |
| SK-402 | `skep sim run` command | SK-401, SK-104 | pi | `src/cli/commands/sim.ts` | (Keys moved to SK-401.) `skep sim run --seed 42 --scenario empty` prints result JSON with `--machine` | done (PASS_WITH_NOTES) |
| SK-403 | Lease intents, reverify, suspend detection | SK-201, SK-302 | codex | `src/core/intents.ts` (claim/release/revoke/deliver/fail/checkpoint builders), `src/lease/{reverify,suspend}.ts` (+ tests) | Intents return null when no longer valid; the claim intent returns null when `activeLeaseCount` (D16) reaches `max_parallel_items`; reverify does a fresh observation; suspend gap marks leases unverified | done (PASS) |
| SK-404 | Protocol scenarios | SK-401, SK-403, SK-406 | codex | `src/sim/scenarios/{claim-race,lost-ack,fetch-flaky,forged-commits,sleep-wake-revoke,duplicate-boot,clock-skew}.ts` + tests | Each scenario passes for 50 seeds (`SKEP_SIM_SEEDS=50`; `npm test` defaults to 3 seeds per scenario plus the seed-42 outcome tests); sleep-wake-revoke: stale holder never delivers, new holder delivers once | done (PASS_WITH_NOTES; seed-tiering follow-up PASS) |
| SK-405 | Wave 2b/3 polish: tests and fixtures | SK-304, SK-305, SK-307 | pi | `src/core/reducer/{invariants.ts,replay.property.test.ts}`, `test/integration/golden.test.ts`, `test/fixtures/golden/*`, `test/helpers/golden-scenarios.ts`, `src/adapter/structured.{ts,test.ts}`, `src/transport/fake-hint.ts` | Follow-ups F1–F6 below: negative tests for `replan_budget`/`replan_budget_settle`; `checkInvariants` doc comment on caller state; seventh golden fixture `review-resume` (D20) and `example.invalid` PR URLs (one deliberate `SKEP_UPDATE_GOLDEN=1` run); golden update outside test collection; `extractJson` stray-brace fallback with a test; provider-transform round-trip tests (`toCodexOutputSchema` ⇒ nulls ⇒ normalize ⇒ Zod) for Plan/Review/WorkReport; `FakeHintChannel` publish-before-start documented | done (PASS_WITH_NOTES) |
| SK-406 | Wave 2b/3 polish: runtime, adapter, reducer, liveness | SK-202, SK-207, SK-303, SK-306 | codex | `src/exec/interrupt.{ts,test.ts}`, `src/adapter/codex.{ts,test.ts}`, `src/core/reducer/handlers/replan.{ts,test.ts}`, `src/blackboard/liveness.{ts,test.ts}` | Follow-ups F7–F10 below: ladder returns `killed` once SIGTERM was needed (contract in `adapter/types.ts`); `outputSchema: "off"` stops appending the schema to the prompt (prompts own it); coalesced `replan.requested` validates `payload.item` and `barrier.closed` throws on an impossible missing item (before the first live blackboard; golden hashes must stay unchanged or be regenerated deliberately); observer-side boot-id flip-flop alarm. **Must merge before SK-504** | done (PASS) |

## Wave 5 — execution core

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-501 | Code mirror, worktrees, sanitized agent env | SK-205, SK-206 | codex | `src/exec/{worktree,sandbox-env}.ts` (+ tests) | Mirror per allowlisted repo; worktree from base or predecessor SHA; env strips GIT_*, SSH_AUTH_SOCK, GH_TOKEN, credential helpers; optional uid/gid | done (PASS_WITH_NOTES) |
| SK-502 | Trusted checks runner, evidence verifier, secret scan | SK-501 | codex | `src/exec/{checks,evidence,secret-scan}.ts` (+ tests) | Checks only from `base_commit`; CheckRun + journal; file_span/command_run/check_run verification; gitleaks wrapper (skip with warning if absent in tests) | done (PASS after fix round; B1 secret-scan bypass fixed) |
| SK-503 | Code host interface, fake host, gh host | SK-205 | pi | `src/codehost/{types,fake,gh}.ts` (+ tests) | Interface per ARCHITECTURE §11.5; fake enforces one PR per head; gh implementation via `gh` JSON output (unit-tested with a stub runner) | done (PASS_WITH_NOTES) |
| SK-504 | Attempt pipeline + mechanical snapshot | SK-306, SK-307, SK-403, SK-406, SK-502, SK-503, SK-506 | codex | `src/exec/{attempt,snapshot}.ts` (+ tests) | Journaled steps per ARCHITECTURE §9.7; one fix-up; code first then record; reverify before PR and before `work.delivered`; snapshot from verifiable facts. **D19:** adapter output, check logs and journal records go through the `Redactor` (SK-506); before any publication `findSecrets` runs next to gitleaks and a hit ⇒ `work.failed{secret_detected}` with nothing published; the daemon adds no credentials to any agent, check, git or gh environment | todo |
| SK-506 | Pattern-based secret redactor (D19 defence in depth) | SK-205 | codex | `src/exec/redact.ts`, `src/exec/journal.ts` (optional `redactor` constructor option) (+ tests) | ARCHITECTURE §16: `Redactor` with built-in rules for common key/token formats (provider-style API keys, GitHub tokens, private-key blocks, `*_KEY=`/`*_TOKEN=`/`*_SECRET=` assignments with high-entropy values) replacing matches with `[REDACTED:<rule>]`, including matches split across streamed chunks; `findSecrets(text)` for the pre-publication scan; journal records pass through the redactor before the fsync'd write (test: a record with a fake key such as `sk-test-…` never reaches disk); default no-op keeps SK-205 behaviour; Skep never loads provider credentials to redact (D19), so the redactor is pattern-based only; fixtures use obviously fake values allowlisted in gitleaks | done (PASS_WITH_NOTES) |
| SK-505 | Restart reconciliation + crash scenario | SK-504, SK-401 | codex | `src/exec/reconcile.ts`, `src/sim/scenarios/crash-every-step.ts` (+ tests) | Crash at every journal step ⇒ no duplicate events, executions or PRs | todo |

## Wave 6 — daemon, flows, CLI

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-601 | Daemon tick loop, slots, duties, plan validator | SK-504, SK-302, SK-303 | codex | `src/daemon/{daemon,slots,duties,lock}.ts`, `src/exec/plan-validator.ts`, `src/bin/skepd.ts` | Owner plans, reviewer reviews, assignee claims & executes; single-daemon lock; scenarios `solo-happy`, `team-stacked` pass. Claim duty uses `claimableItems` (D16: a parked lease in an escalated/replanning task does not stop the slot from claiming elsewhere); a `delivered` task may appear directly after an activation (D15) and must trigger the owner's verification duty (SK-606). **D18:** daemon wires a `HintChannel` (null by default) into sync and publishes a `tip` hint after each accepted publish; nothing in the daemon requires inbound connectivity | todo |
| SK-602 | IPC protocol, server, client with sign callback | SK-301 | pi | `src/ipc/{protocol,client}.ts`, `src/daemon/ipc-server.ts` (+ tests) | NDJSON frames per ARCHITECTURE §12; sign_request/sign_result round trip; version mismatch error; socket perms 0600 | todo |
| SK-603 | CLI write commands (task, plan, lease, decide, replan, cancel) | SK-602, SK-403 | pi | `src/cli/commands/{task,plan,lease,decide,replan}.ts` | Each command builds the intent, publishes via daemon or in-process fallback, prints accepted/rejected with `#seq`; language guard on `task new` | todo |
| SK-604 | `skep status`, `skep log`, `skep plan show` rendering | SK-204, SK-602 | pi | `src/cli/commands/{status,log}.ts`, `src/cli/render-status.ts` | Matches PRD §15.1 layout; `--machine` stable JSON; revoke suggestions for stale holders; shows sync freshness and hint-channel health (D18); shows nothing about providers (D19) | todo |
| SK-605 | Coarse replan flow in the daemon | SK-601 | codex | `src/daemon/replan.ts`, scenarios `replan-once`, `replan-escalate`, `missing-checkpoint` | Interrupt ladder → snapshot → WIP push → checkpoint; barrier deadline ⇒ barrier.closed; third replan escalates | todo |
| SK-606 | Stacked delivery, task.verified, merge observation & retarget | SK-601, SK-209 | codex | `src/daemon/delivery.ts` (+ scenario test) | W2 starts from W1 delivered SHA, PR base = W1 branch; top-of-stack verification; merged PRs ⇒ item.merged, next PR retargeted. **D14:** owner duty runs when the task is `delivered` ∧ `verified == null` (also after a D15 re-activation); runs every item's acceptance checks once at the top-of-stack SHA; publishes `task.verified{passed, check_runs}` — on failure `passed: false` (**never** `work.failed`, no automatic re-run) and notifies the human. Scenario: failing combined check ⇒ `escalated` (`verification_failed`); `skep decide --resume` ⇒ `delivered` ⇒ re-verify passes ⇒ merges ⇒ `done` | todo |
| SK-607 | `skep init`, `skep doctor`, ntfy notifier | SK-301, SK-206 | pi | `src/cli/commands/{init,doctor}.ts`, `src/notify/ntfy.ts` | init writes device.toml, generates daemon key, prints allowed_signers line, optional genesis; doctor runs PRD §13.3 pre-flight + full replay + invariants. **D18:** no step assumes Tailscale or inbound SSH; doctor checks outbound reachability of the blackboard and code remotes only, and reports the optional relay as a warning, never an error | todo |
| SK-608 | Service units + runbook | SK-601 | pi | `deploy/{skepd.service,com.skepagent.skepd.plist}`, `docs/RUNBOOK.md` | Setup, key rotation, revoke, re-genesis procedures documented. **D18:** provisioning without Tailscale: run `skep init` on the device's own console/shell, copy the printed key line to the controller, install the trust root by any channel with fingerprint comparison (manual until SK-702); **D19:** configure each device's agent CLIs locally on that device — the runbook states that Skep never copies provider credentials or configs; all examples use generic hosts (`example.invalid`) | todo |
| SK-609 | Real two-device run & metrics | all | codex | `docs/MVP-RUN-REPORT.md` | PRD §16.5 acceptance criteria verified or gaps documented | todo |
| SK-610 | First public release v0.1.0 | SK-609 | codex (human sign-off) | `package.json` (release fields), `CHANGELOG.md`, `README.md` (quickstart), `docs/RELEASE.md` (checklist + name decision) | See "SK-610 — First public release v0.1.0": SemVer 0.x policy; Keep-a-Changelog `CHANGELOG.md`; README quickstart; npm name availability checked with `npm view` (no publish) and decision recorded; package.json `name`/`bin`/`files`/`engines`/`license`/`repository`; release notes drafted; every pre-release checklist item true; tag and publish only on explicit human go | todo |

## Wave 7 — transport without a mesh VPN (MVP+, D18)

Starts after Wave 6; none of these block the MVP acceptance run (SK-609). SK-701 is V1 (optional
relay). Provider-config sync (former D17 tasks) was withdrawn and must not be reintroduced (D19).

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-701 | Hint relay (V1): worker + client | SK-308, SK-302 | codex | `relay/` (worker source + its own deploy config, outside the npm workspace), `src/transport/relay.ts` (+ tests against an in-process fake relay) | §17.3/§17.4: topic derivation; optional bearer token; hint fan-out within a topic only; frames that are not valid `Hint`s are dropped; no storage and no payload logging in the relay; client reconnect with `util/backoff` and injected Clock; a relay that forges, drops, floods or replays hints never changes reducer state and causes ≤ 1 extra fetch per 2 s (test) | todo |
| SK-702 | Enrollment and trust bundles (replaces Tailscale SSH provisioning) | SK-102, SK-607 | pi | `src/cli/commands/{enroll,trust}.ts`, `src/config/enroll.ts` (+ tests), `docs/RUNBOOK.md` (provisioning section) | §17.6: `skep enroll export\|import`, `skep trust import`; `skep.enroll/v1` and `skep.trust_bundle/v1` contain public data only (schema rejects private-key blocks and unknown keys; test) and are signed by the human key; import requires typing the human key's short fingerprint on first trust; later trust bundles verified against the installed human key and applied atomically; tampered or wrong-signer bundles rejected; no network access in tests | todo |
| SK-703 | `skep logs` without SSH | SK-604, SK-506 | pi | `src/cli/commands/logs.ts` (+ tests) | Local agents: tail the journal/log via `logs.tail`, redacted; remote agents: print the last heartbeat (state, task, item, epoch, observed age) and the journal path on that device, exit 0; no log transport between devices (§17.2) | todo |

---

## Wave 2b / Wave 3 parallel schedule

> **Status: complete.** All twelve tasks are merged on `main` (verdicts in the task tables and in
> `docs/reviews/`); open review notes are tracked under "Wave 2b/3 follow-ups" below.

Baseline: `main` at `e906dd1` (SK-101..SK-104, SK-201, SK-203, SK-205, SK-206, SK-209 merged).
The Wave 2 remainder (SK-202, SK-204, SK-207, SK-208) runs **in parallel** with every Wave 3 task
that neither depends on it nor shares files with it. One git worktree + branch + agent pane per
task; **cap 6 concurrent panes** (5 codex + 1 pi in Batch A). Merge order inside a batch does not
matter unless a gate below names it. Every task branches from the latest `main` when it starts.

### Dependency / conflict analysis

| Task | Unfinished prerequisites (W2 remainder or W3) | File / function overlap with a concurrent task | Verdict |
|---|---|---|---|
| SK-202 (W2) | none (SK-201, SK-209 merged) | `handlers/replan.ts` only; reads `barrier.ts`, `lease.ts` (`activeLeaseCount`), `plan.ts` `activatePlan` (SK-208 edits it; SK-202 must not). Also the stub list in `replay.test.ts` (owned by SK-202 in this batch). | **A** |
| SK-208 (W2) | none | `handlers/plan.ts`, `plan.test.ts`; keeps the D15 tail of `activatePlan`. Disjoint from SK-202 (no shared file); semantic overlap only through full replan cycles, avoided by SK-202 using mode-consistent plans | **A** |
| SK-204 (W2, pi) | none | new `views.ts`; reads `activeLeaseCount`/`isSettled`; owns the one-line export in `reducer/index.ts` for this batch. Barrier states are constructed in tests (SK-202 runs concurrently) | **A** |
| SK-207 (W2) | none hard; the real adapter needs a runtime backend and the interrupt ladder (SK-306) | `src/adapter/codex.ts` only; SK-307 owns the other adapter files. Decoupled by constructor injection of `RuntimeBackend` + an `InterruptLadder` function type declared in `codex.ts` (SK-306 implements a structurally identical function) | **A** (Day-1 risk spike, PRD §16.4) |
| SK-301 (W3) | none (SK-102, SK-103, SK-203 merged) | `src/blackboard/{clone,publisher,genesis}.ts`, new `src/core/intents.ts` (types + draft helper only; builders are SK-403). Publisher needs a state source: SK-301 defines `StateSource` + a simple full-replay implementation, SK-302 later provides the incremental one | **A** (critical path) |
| SK-308 (W3) | none | new `src/transport/*` | **A** (tiny; gates SK-302) |
| SK-302 (W3) | **SK-308** (`HintChannel` type), **SK-301** (`BlackboardClone`, `StateSource`) | `src/blackboard/sync.ts` only; must not edit `clone.ts`/`publisher.ts` | **B**, gated on SK-301 + SK-308 merged |
| SK-303 (W3) | none | `src/blackboard/{heartbeat,liveness}.ts`; works on a repo dir parameter, does not use or edit `clone.ts` | **B** (pane cap only); first free codex pane |
| SK-306 (W3) | none | `src/runtime/native.ts`, `src/exec/interrupt.ts`; must export `runInterruptLadder` matching SK-207's `InterruptLadder` | **B** (pane cap only) |
| SK-307 (W3) | none | `src/adapter/{structured,prompts,fake}.ts`; disjoint from SK-207's `codex.ts`; neither edits `adapter/types.ts` | **B** (pane cap only) |
| SK-304 (W3, pi) | **SK-202** (replan events in random logs), **SK-208** (plan-mode rules decide which generated plans are valid) | new `invariants.ts`, `replay.property.test.ts`, `test/helpers/random-log.ts` (owned by SK-304) | **B**, gated on SK-202 + SK-208 merged; takes the pi pane after SK-204 |
| SK-305 (W3, pi) | **SK-202**, **SK-208**, **SK-304** (property tests may still change reducer behaviour, which would churn golden hashes) | `test/fixtures/golden/*`, `test/integration/golden.test.ts`, `test/helpers/golden.ts`; imports (never edits) `random-log.ts` | **C**, gated on SK-304 merged |

Wave 2 remainder against each other: SK-202 vs SK-208 — disjoint files; SK-202 must not touch
`plan.ts`, SK-208 must not touch `replan.ts` or `replay.test.ts`. SK-204 vs both — read-only use of
handler exports; views must not reimplement reducer rules (D16 count via `activeLeaseCount`).
Shared frozen files nobody in Batches A–C may edit: `src/core/schemas/**`, `src/core/reducer/{state,apply,types,preconditions,authz,structural,genesis,replay}.ts`, `handlers/{barrier,lease,merge,work,task,types}.ts`, `src/adapter/types.ts`, `src/runtime/types.ts`, `src/git/**`, `test/helpers/{log-builder,git-fixture}.ts`, `package.json`, configs. Extend helpers only inside your own test files.

### Schedule

| Batch | Task | Assignee | Starts when / blocked by | Files owned |
|---|---|---|---|---|
| A | SK-202 | codex | now | `src/core/reducer/handlers/replan.ts`, `handlers/replan.test.ts`, stub assertions in `src/core/reducer/replay.test.ts` |
| A | SK-208 | codex | now | `src/core/reducer/handlers/plan.ts`, `handlers/plan.test.ts` |
| A | SK-301 | codex | now | `src/blackboard/{clone,publisher,genesis}.ts` (+ tests), `src/core/intents.ts` (+ test), `test/integration/publisher-race.test.ts` |
| A | SK-308 | codex | now | `src/transport/{types,null-hint,fake-hint}.ts` (+ tests) |
| A | SK-207 | codex | now | `docs/spikes/adapter-codex.md`, `src/adapter/codex.ts` (+ test), `test/fixtures/codex/*`, `test/integration/adapter-codex.test.ts` |
| A | SK-204 | pi | now | `src/core/reducer/views.ts` (+ test), export line in `src/core/reducer/index.ts` |
| B | SK-302 | codex | SK-301 **and** SK-308 merged | `src/blackboard/sync.ts` (+ test) |
| B | SK-303 | codex | first free codex pane (no gate) | `src/blackboard/{heartbeat,liveness}.ts` (+ tests) |
| B | SK-306 | codex | next free codex pane (no gate) | `src/runtime/native.ts`, `src/exec/interrupt.ts` (+ tests) |
| B | SK-307 | codex | next free codex pane (no gate) | `src/adapter/{structured,prompts,fake}.ts` (+ tests) |
| B | SK-304 | pi | SK-202 **and** SK-208 merged (pi pane free after SK-204) | `src/core/reducer/invariants.ts`, `src/core/reducer/replay.property.test.ts`, `test/helpers/random-log.ts` |
| C | SK-305 | pi | SK-304 merged | `test/fixtures/golden/*.json`, `test/integration/golden.test.ts`, `test/helpers/golden.ts` |

Batch B fill order when a codex pane frees: SK-302 (as soon as its gates merge; critical path) →
SK-303 (feeds SK-401) → SK-306 (gives SK-207 its real runtime) → SK-307. Never more than 6 panes.
Held-back reasons: SK-302 needs SK-308's `HintChannel` and SK-301's clone/state-source contracts;
SK-304 generates replan and plan-mode logs whose semantics SK-202/SK-208 are still defining;
SK-305 freezes state hashes, so it runs after the reducer stops moving (SK-304's property tests);
SK-303, SK-306 and SK-307 have no blocker and wait only for a free pane (they are off the
SK-202→SK-304→SK-401 and SK-301/302→SK-401 critical paths, or have slack because SK-401 also waits
for SK-304).

---

## Wave 4 + early Wave 5 schedule

> **Status: complete.** SK-401..SK-406, SK-501, SK-502, SK-503 and SK-506 are merged on `main`
> (verdicts in the task tables and in `docs/reviews/`); open review notes are tracked under
> "Wave 4 / early Wave 5 follow-ups" below.

Baseline: `main` after Wave 2b/3 (all of SK-2xx and SK-30x merged; follow-ups F1–F21 listed under
"Wave 2b/3 follow-ups"). This phase runs **all of Wave 4** (SK-401..SK-406) and, in parallel,
the Wave 5 tasks whose dependencies are already on `main` (SK-501, SK-503, SK-506; SK-502 once
SK-501 lands). **Cap: 5 implementer panes** (6 panes including the architect/orchestrator). One
git worktree + branch + pane per task; every task branches from the latest `main` when it
starts. codex implementers cannot commit inside their sandbox (the orchestrator commits), and 7
subprocess-stdout tests in `src/util/exec.test.ts` fail only inside that sandbox. Judge
`npm test` outside it.

### Dependency / conflict analysis

| Task | Unfinished prerequisites | File / export overlap with a concurrent task, and resolution | Verdict |
|---|---|---|---|
| SK-401 (codex) | none (SK-301..SK-304 merged) | New `src/sim/*` files. **Takes over the fixed test keys** (`test/fixtures/keys/*`, `.gitleaks.toml` allowlist) from SK-402: same-seed ⇒ same-tip determinism needs fixed ed25519 keys, and SK-402 depends on SK-401 anyway. Also owns the new scenario registry `src/sim/scenarios/index.ts`. There is no daemon yet (SK-601), so a "sim daemon" is a `SimNode` composed of the production `BlackboardClone`/`Publisher`/`Sync`/`HeartbeatWriter` plus a pluggable `duties` hook. | **A** (critical path) |
| SK-403 (codex) | none (SK-201, SK-302 merged) | Adds builders to `src/core/intents.ts` (created by SK-301; SK-403 is now its only editor). New `src/lease/*`. Uses `views.ts`/`Sync` read-only. | **A** (critical path) |
| SK-406 (codex) | none | `src/exec/interrupt.ts`, `src/adapter/codex.ts`, `handlers/replan.ts`, `src/blackboard/liveness.ts` (+ tests). Nobody else in this phase edits them; SK-401 only imports `liveness.ts`/`replan.ts`. **Must not change golden hashes** (run `test/integration/golden.test.ts`; if a hash would move, stop and report). | **A** (gates SK-504, SK-404, SK-405) |
| SK-501 (codex) | none (SK-205, SK-206 merged) | New `src/exec/{worktree,sandbox-env}.ts`. | **A** (Wave 5 critical path) |
| SK-503 (pi) | none (SK-205 merged) | New `src/codehost/*`. | **A** |
| SK-506 (codex) | none | New `src/exec/redact.ts`; adds an optional `redactor` option to `src/exec/journal.ts` (sole editor in this phase). | **B** (pane cap only) |
| SK-502 (codex) | **SK-501** (mirror + worktree) | New `src/exec/{checks,evidence,secret-scan}.ts`; imports `NativeRuntime` (SK-306) and `journal.ts` read-only. | **B**, after SK-501 merges |
| SK-404 (codex) | **SK-401** (world, registry), **SK-403** (intents), **SK-406** (F10 observer boot-id alarm for `duplicate-boot`) | New scenario files; adds entries to `src/sim/scenarios/index.ts` (owned by SK-401, editable by SK-404 only after SK-401 merges). | **B**, after SK-401 + SK-403 + SK-406 |
| SK-402 (pi) | **SK-401** (`runScenario`, registry) | `src/cli/commands/sim.ts` only (the keys moved to SK-401). | **B**, after SK-401 |
| SK-405 (pi) | **SK-406**: both touch the golden fixtures' validity (SK-406 changes `replan.ts`) and `toCodexOutputSchema` behaviour (SK-406 edits `codex.ts`; SK-405 tests it) | `invariants.ts`, `replay.property.test.ts`, golden test/fixtures/scenarios, `structured.ts`, `fake-hint.ts`. No overlap with SK-401/403/404 files; SK-401 imports `checkInvariants` and `FakeHintChannel` read-only. | **B**, after SK-406 merges |

Wave 4 internal: SK-401 and SK-403 share no files. SK-404 is the only task that combines them.
SK-405/SK-406 touch no file owned by SK-401/403/404 or by a Wave 5 task in this phase. They
are sequenced (SK-406 ⇒ SK-405) because of the golden fixtures and `codex.ts`.

### Schedule

| Batch | Task | Implementer | Gate | Files owned |
|---|---|---|---|---|
| A | SK-401 | codex | now | `src/sim/{world,faulty-git,invariants,runner}.ts`, `src/sim/scenarios/{index,empty}.ts`, `test/integration/sim/empty.test.ts`, `test/fixtures/keys/*`, `.gitleaks.toml` |
| A | SK-403 | codex | now | `src/core/intents.ts` (builders), `src/lease/{reverify,suspend}.ts` (+ tests) |
| A | SK-406 | codex | now | `src/exec/interrupt.ts`, `src/adapter/codex.ts`, `src/core/reducer/handlers/replan.ts`, `src/blackboard/liveness.ts` (+ tests) |
| A | SK-501 | codex | now | `src/exec/{worktree,sandbox-env}.ts` (+ tests) |
| A | SK-503 | pi | now | `src/codehost/{types,fake,gh}.ts` (+ tests) |
| B | SK-404 | codex | SK-401 + SK-403 + SK-406 merged | `src/sim/scenarios/{claim-race,lost-ack,fetch-flaky,forged-commits,sleep-wake-revoke,duplicate-boot,clock-skew}.ts`, registry entries, `test/integration/sim/*.test.ts` (new files) |
| B | SK-502 | codex | SK-501 merged | `src/exec/{checks,evidence,secret-scan}.ts` (+ tests) |
| B | SK-506 | codex | first free pane (no gate) | `src/exec/redact.ts`, `src/exec/journal.ts` (optional redactor) (+ tests) |
| B | SK-402 | pi | SK-401 merged | `src/cli/commands/sim.ts` (+ test) |
| B | SK-405 | pi | SK-406 merged | per its row (F1–F6) |

**Fill order when a pane frees** (take the first one whose gate is met; never more than 5
implementers): SK-404 (critical) → SK-502 (Wave 5 critical path) → SK-506 → SK-402 → SK-405.
Expected shape: SK-406 and SK-503 finish first, which frees panes for SK-506 and SK-405. SK-501
⇒ SK-502. SK-401 + SK-403 ⇒ SK-404 last.

**Held back in this phase:**

* SK-504: needs SK-403, SK-406, SK-502, SK-503 and SK-506 merged; it is scheduled in the next phase.
* SK-505: needs SK-504.
* All of Wave 6 (SK-601..SK-608): SK-601 needs SK-504, and the others build on SK-601. SK-602 and
  SK-607 are technically unblocked but are deferred by scope, to keep the pane budget on the
  critical path.
* Wave 7 (MVP+).
* SK-609 and SK-610 (need everything).

### Briefs

All tasks: AGENTS.md rules, generic example values only, no credentials anywhere (D19), `npm run
lint && npm test` green (outside the codex sandbox).

**SK-401 — Sim world, scheduler, faulty git, invariant checker, `empty` (codex).** Spec:
ARCHITECTURE §13.1–§13.2, §7.2, §8. Build:

* `SimWorld.create({ seed, devices, root })`: bare blackboard + bare code remotes in a temp dir;
  human-signed genesis via `createGenesis`. Per device, a `SimNode` with its own clone, `Publisher`,
  `Sync`, `HeartbeatWriter`, a `FakeClock` view (skew and suspend), a `NullHintChannel`, and an
  optional `duties(node, state) ⇒ Intent[]` hook (SK-404 scripts actors with it; SK-601 later
  replaces it with `Daemon.tick`).
* A discrete-event scheduler on `VirtualTime`, ties broken by `Rng.fork("schedule")`.
* `faulty-git.ts`: a `GitRunner` decorator with seeded or scripted faults (failed fetch, a
  competing push before ours, lost ack, delay, partition).
* `invariants.ts`, checked after every step:
  * invariant 1: every node at the same tip ⇒ byte-identical `canonicalJson`, and incremental ==
    full replay;
  * `checkInvariants` (2–4, 6, 8, 9);
  * invariant 7: no heartbeat commits on `main`; each `hb/*` ref is a single orphan;
  * invariant 5 only when a code host is attached (later).

  Violations report seed + step + log dump.
* `runner.ts`: `runScenario(name, seed, opts) ⇒ { finalTip, steps, violations }`.
* Registry `scenarios/index.ts` with `empty`.
* **Fixed test keys** under `test/fixtures/keys/` (README marks them test-only) and the
  `.gitleaks.toml` allowlist for that path.

Acceptance:

* `empty` (2 nodes, idle, heartbeats) runs with zero violations.
* The same seed run twice in fresh temp dirs gives the same final tip sha; different seeds may
  differ.
* A faulty-git unit test per fault kind.

Pitfalls: commit dates come only from the virtual clock; isolate `GIT_*`/`HOME` via the runner
env; keep scenarios short (real git is slow); never touch `~/.skep`. Picks up: invariant wiring
for F13 is SK-601's job, not this task's. Test: `npx vitest run src/sim test/integration/sim`.

**SK-402 — `skep sim run` (pi).** Spec: ARCHITECTURE §13.1, §12 output rules. Build: replace the
`sim run` stub with `runScenario` from the registry. `--machine` prints the result JSON; human
mode prints a summary. An unknown scenario ⇒ usage error (exit 2); violations ⇒ exit 1. The keys
are no longer this task's (moved to SK-401). Acceptance: `skep sim run --seed 42 --scenario empty
--machine` prints one JSON line with `ok`, `finalTip` and `violations: []`. Test: `npx vitest run
src/cli`.

**SK-403 — Lease intents, reverify, suspend (codex).** Spec: ARCHITECTURE §6.1–§6.3, D16;
follow-ups **F15, F16**. Build:

* Pure builders in `src/core/intents.ts`: `claimIntent`, `releaseIntent`, `revokeIntent` (human),
  `deliverIntent`, `failIntent`, `checkpointIntent`. Each re-derives everything from the state it
  receives and returns `null` when it is no longer valid (status, lease holder/epoch,
  `interrupt`, barrier).
* `claimCandidates(state, agent)` limits claims to `max_parallel_items − activeLeaseCount` (F15).
* `lease/reverify.ts`: `reverify(sync, lease) ⇒ "ok" | "stale"` via `Sync.observeNow()`.
* `lease/suspend.ts`: `SuspendDetector(clock, pollMs)`. `Δwall − Δmono > 2 × poll` ⇒ marks held
  leases unverified, pauses invocations until reverify, and notifies listeners (the daemon wires
  `LivenessTracker.resetAll`, F16).

Acceptance: each intent returns null for every invalidating state change (table test over
builder logs); two intents computed from one state ⇒ only one accepted after replay; a suspended
`FakeClock` triggers the detector, a skewed one does not. Pitfall: never cache state inside an
intent. Test: `npx vitest run src/core src/lease`.

**SK-404 — Protocol scenarios (codex).** Spec: ARCHITECTURE §13.3, §6, PRD S5. Build the seven
scenarios with `duties` hooks that use SK-403 intents. Holders are scripted (the attempt pipeline
is SK-504): **code first, then record**, meaning the scripted holder pushes a trivial commit to the
epoch branch on the bare code remote before `work.delivered`.

* `claim-race`: 8-way.
* `lost-ack`, `fetch-flaky`: via faulty git.
* `forged-commits`: unsigned, wrong principal, a daemon creating a task, a merge commit.
* `sleep-wake-revoke`: suspended holder, human revoke, re-claim at epoch 2; the stale holder's
  reverify fails and it never delivers.
* `duplicate-boot`: both writer-side and observer-side alarms (F10 from SK-406).
* `clock-skew`: wall skew changes no decision.

Acceptance: every scenario passes 50 seeds with zero violations; `sleep-wake-revoke`: exactly one
accepted delivery, by epoch 2. Test: `npx vitest run test/integration/sim`.

**SK-405 — Polish: tests and fixtures (pi).** Picks up **F1–F6** exactly as listed. Start after
SK-406 merged; regenerate goldens once (`SKEP_UPDATE_GOLDEN=1`) for `review-resume` and
`example.invalid`, and review the diff. Test: `npx vitest run src/core/reducer src/adapter
test/integration/golden.test.ts`.

**SK-406 — Polish: runtime, adapter, reducer, liveness (codex).** Picks up **F7–F10**. Golden
hashes must stay unchanged; the replan fixtures use valid items, so F9 rejects nothing there.
Test: `npx vitest run src/exec src/adapter src/core/reducer src/blackboard
test/integration/golden.test.ts`.

**SK-501 — Code mirror, worktrees, sanitized env (codex).** Spec: ARCHITECTURE §7.5, §9.7, PRD
§9.6, §11.4, D19. Build:

* `CodeMirror` per allowlisted repo (bare mirror under `$SKEP_HOME/mirrors/<name>.git`; fetch with
  the daemon's credentials).
* `createWorktree({ repo, baseSha, branch, path })` from `base_commit` or the predecessor's
  delivered head, and `removeWorktree`. Paths go through `safeJoin`; the `.git` admin files are
  daemon-owned.
* `sandbox-env.ts`: `agentEnv(opts)` built from an **allowlist** (e.g. `PATH`, `HOME`/`USER` of the
  agent user, `LANG`, `TMPDIR`, and the agent CLI's documented config-dir variable). It never
  forwards `GIT_*`, `SSH_AUTH_SOCK`, `GH_TOKEN`/`GITHUB_TOKEN`, credential helpers or anything
  provider-related (D19).
* Optional `uid`/`gid` resolution for the agent user.

Acceptance: a worktree at a given sha, on a fresh branch, in a temp dir; the env test proves that
nothing outside the allowlist passes, including a planted `GIT_ASKPASS` and `SSH_AUTH_SOCK`.
Test: `npx vitest run src/exec`.

**SK-502 — Trusted checks, evidence verifier, secret scan (codex).** Spec: ARCHITECTURE §9.5–§9.6,
PRD §9.6, §11.5. Build:

* `checks.ts`: load `.skep/checks.toml` **only** via `git show <base_commit>:…` from the SK-501
  mirror (`parseChecksFile`). Run each check with `NativeRuntime` (argv, `shell: false`, sanitized
  env, timeout, group kill) and produce a `CheckRun` with a journal entry and log digest.
* `evidence.ts`: `file_span`/`command_run`/`check_run` verification against the mirror and the
  journal.
* `secret-scan.ts`: gitleaks wrapper; skip with a warning if absent in tests.

Acceptance: a check from the worktree's own (modified) `checks.toml` is ignored; a tampered
excerpt or hash fails verification; timeouts kill the group. Test: `npx vitest run src/exec`.

**SK-503 — Code host (pi).** Spec: ARCHITECTURE §11.5. `types.ts` interface; `fake.ts` in-memory
PR registry over a local bare repo (one PR per head branch, `merge(pr)` for scenarios);
`gh.ts` via `execFileChecked("gh", …, --json …)`, unit-tested with a stub runner and no network.
Test: `npx vitest run src/codehost`.

**SK-506 — Pattern-based redactor (codex).** Spec: its row, ARCHITECTURE §16. Test: `npx vitest
run src/exec`.

## SK-610 — First public release v0.1.0 (brief)

Depends on SK-609. Owner: codex, with human sign-off. No `npm publish` and no tag push without
the human's explicit go.

**Versioning.** SemVer 0.x. `0.1.0` is the first public release (the MVP of PRD §16). While 0.x,
a **minor** bump may break CLI flags, config or the blackboard protocol, and a **patch** bump may
not. A protocol or reducer change additionally follows ARCHITECTURE §4.4: a new
`REDUCER_VERSION` needs golden evidence, and a live blackboard needs a human re-genesis. The
version lives in `package.json`; `skep --version` prints it together with `REDUCER_VERSION` and
`protocol_version`.

**CHANGELOG.md.** Keep-a-Changelog format: `## [0.1.0] - <date>` with Added / Changed / Security /
Known limitations. Sources: conventional-commit subjects on `main` since the scaffold (grouped by
`feat`/`fix`), the DEV-PLAN task table, and ARCHITECTURE §15 decisions that change user-visible
behaviour. An `Unreleased` section is kept at the top afterwards.

**README quickstart.**

* Prerequisites: Node ≥ 22.12, git ≥ 2.34, OpenSSH ≥ 8.9, `gh`, gitleaks, a pinned agent CLI
  installed and logged in **locally** on each device (D19).
* `npm install -g <package>`, then `skep init` on each device.
* Trust setup: allowed_signers plus fingerprint comparison.
* Create the private blackboard repo, then `skep init --genesis` on the controller.
* `skepd` as a service; `skep task new …` ⇒ `skep plan approve` ⇒ `skep status`.
* Link to `docs/RUNBOOK.md`, plus an explicit "what Skep never does" box: no credential
  transport (D19), no inbound connections (D18), no auto-merge.

**npm package name.** Check availability without publishing:

* `npm view skep name version` (exit 0 ⇒ taken; E404 ⇒ free)
* `npm view skepd name`
* `npm view @skepagent/skep name`
* `npm access list packages @skepagent` (does the scope exist, and do we own it)
* also search the npm registry for close look-alikes

**Availability snapshot (orchestrator, 2026-10-06, read-only GET requests to the public npm
registry):**

* `skep`: **taken**, by an unrelated package (latest `0.0.2`, last modified 2022).
* `skepd`, `skep-agent`, `skepagent`, `@skepagent/skep`: **404**, not published.
* The npm org page for `skepagent`: **404**, so the org most likely does not exist yet.

Re-run every check at release time; registry state can change.

Decision criteria, in order:

1. Unscoped `skep` is **not available** (see snapshot). Do not try to reclaim or name-squat it.
2. **Preferred:** the scoped `@skepagent/skep`, after the human creates the `skepagent` npm org
   (and ideally the matching GitHub org), published with `--access public`. The bin names stay
   `skep` and `skepd`.
3. Fallback, if the org cannot be created: an unscoped, still-free, non-confusable name such as
   `skep-agent` (re-check with `npm view`), with the same bin names. Note the possible collision
   of the `skep` *binary* with the unrelated package for users who install both.
4. **The final choice is a human decision**, recorded in `docs/RELEASE.md` with the re-check
   output.

The binaries stay `skep` and `skepd` in either case, and `skepd` is not published as a separate
package. Record the decision and the check output (date, command, result) in the release PR.

**package.json fields.**

* `name` (per the decision above) and `version: "0.1.0"`; remove `"private": true`.
* `bin: { skep: "dist/bin/skep.js", skepd: "dist/bin/skepd.js" }` with shebangs.
* `files: ["dist", "README.md", "LICENSE", "CHANGELOG.md"]` (no `src/`, `test/`, fixtures or keys).
* `engines.node: ">=22.12.0"`, `license: "MIT"`.
* `repository` / `homepage` / `bugs` pointing at the public repo; `keywords`.
* `publishConfig.access: "public"` if scoped.
* `prepublishOnly: "npm run check && npm run build"`.

Verify with `npm pack --dry-run`: the file list contains no test keys, fixtures or `.skep` data.

**GitHub release notes (tag `v0.1.0`).**

* Summary and the MVP scope (PRD §16).
* Highlights: signed git blackboard, deterministic reducer, epoch-fenced leases, coarse replan,
  stacked PRs, Codex adapter.
* Install and quickstart link.
* Security model: everything signed, local trust root, D18 transports are availability-only, D19
  non-goal stated verbatim.
* Known limitations: manual revoke; Codex adapter only; macOS/Linux; no herdr backend; relay and
  enrollment bundles are Wave 7; single slot per device.
* Results summary from `docs/MVP-RUN-REPORT.md`; upgrade notes ("first release"); checksums of
  the `npm pack` tarball.

**Pre-release checklist (all must be true):**

1. SK-609 passed: PRD §16.5 acceptance criteria verified on a real two-device run, documented in
   `docs/MVP-RUN-REPORT.md` with no open blocking gap.
2. `npm ci && npm run lint && npm test && npm run build` green on a clean checkout of the release
   commit (outside any sandbox), plus `SKEP_PROPERTY_LOGS=1000`, the sim scenarios at 50 seeds,
   and the opt-in real-adapter tests on a device with the pinned CLI.
3. Secret scan clean: `gitleaks detect` over the full git history and over the `npm pack`
   tarball; the only allowlisted findings are the documented test keys.
4. No absolute host paths, real hostnames, IPs or personal emails in the repo (grep check in the
   release PR).
5. The D19 non-goal is present in README, ARCHITECTURE (top + §16) and the release notes; the
   D18 "no inbound connectivity" statement is in README.
6. All DEV-PLAN MVP tasks are `done` with reviews in `docs/reviews/`; the Wave 2b/3 follow-ups
   (F1–F21) are closed or explicitly deferred in the CHANGELOG's known limitations.
7. `REDUCER_VERSION`/`protocol_version` match the golden fixtures; ARCHITECTURE §15 is current.
8. LICENSE present, `package.json` fields as above, `npm pack --dry-run` reviewed, and the name
   decision recorded.
9. Human sign-off on the tag and the publish command (the release task itself never publishes).

---

## Wave 1 task briefs

All Wave-1 tasks branch from the scaffold commit on `main`. Run `npm ci` first. Each task ends
with: its test command green, `npm run lint` green, `npm test` green, one or more commits on its
branch.

### SK-101 — Reducer core (codex)

Read first: `docs/ARCHITECTURE.md` §4–§5, `src/core/reducer/state.ts`, `src/core/log.ts`,
`src/core/schemas/events.ts`, `test/helpers/log-builder.ts`.

**Create**

| File | Exports |
|---|---|
| `src/core/reducer/genesis.ts` | `class GenesisError extends Error`; `genesisState(entry: LogEntry): State` — seq 0, no parents, `good` signature by `human`, adds `skep.json` valid per `GenesisSchema`; `reducer_version` must equal `REDUCER_VERSION` |
| `src/core/reducer/structural.ts` | `checkStructure(entry: LogEntry, prevTip: string): { ok: true; event: SkepEvent; principal: Principal } \| { ok: false; reason: InvalidReason; detail: string }` — ARCHITECTURE §5.3 step 1, in that order |
| `src/core/reducer/authz.ts` | `authorize(principal: Principal, event: SkepEvent, state: State): boolean` — §5.4 |
| `src/core/reducer/preconditions.ts` | `checkPre(event: SkepEvent, state: State): ApplyResult` — §4.2 (task existence/terminal checks + every present `pre` key) |
| `src/core/reducer/handlers/types.ts` | `interface ApplyCtx { seq: number; sha: string; principal: Principal }`; `type Handler<T extends EventType> = (draft: State, event: EventOf<T>, ctx: ApplyCtx) => ApplyResult` |
| `src/core/reducer/handlers/task.ts` | handlers for `agent.registered`, `task.created`, `task.cancelled`, `owner.transferred`, `human.decided` |
| `src/core/reducer/handlers/plan.ts` | handlers for `plan.proposed`, `review.submitted`, `plan.locked`, `plan.approved`, `plan.rejected`; `activatePlan(task, version, seq)` helper (carry-over rule D7) |
| `src/core/reducer/handlers/{lease,work,replan,merge}.ts` | **stubs** with the final handler signatures for `lease.claimed`, `lease.released`, `lease.revoked` / `work.delivered`, `work.failed` / `replan.requested`, `checkpoint.recorded`, `barrier.closed` / `item.merged`, `task.verified`; each returns `{ ok: false, reason: "bad_task_state", detail: "not implemented" }`. (Filled by SK-201/SK-202 without touching other files.) |
| `src/core/reducer/apply.ts` | `applyEvent(draft: State, event: SkepEvent, ctx: ApplyCtx): ApplyResult` — runs `checkPre`, then dispatches through a `{ [T in EventType]: Handler<T> }` table |
| `src/core/reducer/replay.ts` | `applyEntry(state: State, entry: LogEntry): State` (pure, returns new state; never mutates input); `replay(entries: LogEntry[]): State` |
| `src/core/reducer/index.ts` | re-exports public API |
| Tests | `structural.test.ts`, `authz.test.ts`, `replay.test.ts`, `handlers/task.test.ts`, `handlers/plan.test.ts` (use `LogBuilder`; extend helpers only inside your own test files) |

**Acceptance criteria**

1. Every `InvalidReason` in `state.ts` is produced by at least one test (merge commit, unsigned,
   bad signature, unknown key, two files added, modified file, bad path, null content, schema
   invalid, path/envelope mismatch); invalid entries advance `tip`/`seq`, record an `invalid`
   outcome, and change nothing else.
2. Duplicate `event_id` ⇒ `duplicate` outcome, no state change. `stale_tip` and `unauthorized`
   events are rejected **without** marking the event id seen (a later valid event with that id is
   accepted).
3. Authz: daemon cannot create/cancel/approve; daemon actor on another device ⇒ unauthorized;
   human actor signed by a daemon key ⇒ unauthorized; non-owner `plan.proposed` ⇒ unauthorized;
   non-reviewer `review.submitted` ⇒ unauthorized.
4. Lifecycle: solo `task.created → plan.proposed → plan.approved` ⇒ `executing` with items
   `W1 ready`; team with 2 items + 1 reviewer: `plan.proposed → review.submitted(approve) →
   plan.locked → plan.approved` ⇒ `executing`, `W1 ready`, `W2 blocked`; `plan.rejected` ⇒
   `planning`, `review_rounds` 1; exceeding `review_rounds` budget ⇒ `escalated`;
   `human.decided{reassign_owner}` bumps `owner_gen` and old owner's `plan.proposed` is rejected.
5. `pre` mismatches produce the reasons in ARCHITECTURE §4.2; `plan_hash` that does not equal
   `contentHash(plan)` ⇒ `plan_hash_mismatch`.
6. Determinism: replaying the same entries twice yields equal `canonicalJson`; `replay(all)`
   equals folding `applyEntry` one entry at a time from `replay(prefix)`; input state objects are
   not mutated (deep-freeze them in a test).
7. `rev` counts accepted task events; `outcomes` has exactly one record per seq ≥ 1.

**Test command:** `npx vitest run src/core/reducer && npm run lint && npm test`

### SK-102 — Git layer: runner, trust, signer, commits, verification (codex)

Read first: `docs/ARCHITECTURE.md` §7, `src/core/log.ts` (`SignatureCheck`),
`src/core/principal.ts`.

**Create**

| File | Exports |
|---|---|
| `src/git/runner.ts` | `interface GitRunOptions { cwd: string; input?: string \| Uint8Array; env?: Record<string, string>; timeoutMs?: number; allowFailure?: boolean }`; `interface GitResult { code: number; stdout: string; stderr: string }`; `interface GitRunner { run(args: string[], opts: GitRunOptions): Promise<GitResult> }`; `class GitError extends Error { args; code; stderr }`; `class NodeGitRunner implements GitRunner` — `execFile("git", args, { shell: false })`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, inherits only an explicit env allowlist (`PATH`, `HOME`, `SSH_AUTH_SOCK`, `TMPDIR`) + `opts.env`; throws `GitError` on non-zero unless `allowFailure` |
| `src/git/trust.ts` | `interface TrustEntry { principals: string[]; namespaces: string[] \| null; keyType: string; key: string; comment: string }`; `parseAllowedSigners(text: string): { entries: TrustEntry[]; errors: string[] }` (OpenSSH allowed_signers format incl. quoted `namespaces="git"` option, comments, blank lines; every principal must satisfy `parsePrincipal`); `loadTrustRoot(path): Promise<TrustRoot>`; `class TrustRoot { readonly path; entries; principalsForKey(keyType, key): string[] }` |
| `src/git/signer.ts` | `interface Signer { readonly principal: string; sign(payload: Uint8Array): Promise<string> }`; `class SshKeySigner implements Signer` — constructor `{ principal, keyPath, useAgent?: boolean, sshKeygen?: string }`, runs `ssh-keygen -Y sign -n git -f <keyPath> [-U]` with the payload on stdin, returns the armored `-----BEGIN SSH SIGNATURE-----` block |
| `src/git/commit.ts` | `interface Ident { name: string; email: string; timestampSec: number; tz: string }`; `buildCommitText({ tree, parents, author, committer, message }): string`; `insertSignature(commitText, armoredSig): string` (gpgsig header with continuation lines, exactly as git writes it); `writeSignedCommit(git, repoDir, { tree, parents, author, committer, message, signer }): Promise<string /*sha*/>` via `git hash-object -t commit -w --stdin`; `writeTreeFromIndex(git, repoDir): Promise<string>` |
| `src/git/verify.ts` | `verifyCommits(git, repoDir, trustRootPath, shas: string[]): Promise<Record<string, SignatureCheck>>` using one `git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=<trustRootPath> log --no-walk --format=%H%x00%G?%x00%GS%x00%GF ...`; mapping `G`→good (principal = `%GS`, must `parsePrincipal`), `N`→missing, `B`→bad, `U`/`E`/`X`/`Y`/`R` or unparseable principal → unknown_key (detail includes the letter) |
| `test/helpers/git-fixture.ts` | `tempDir(prefix)`, `initRepo(dir, { bare? })`, `generateKey(dir, name): Promise<{ privPath, pubPath, pubLine }>` (`ssh-keygen -t ed25519 -N ""`), `writeAllowedSigners(path, [{ principal, pubLine }])`, `commitFile(git, dir, path, content, signer?)` |
| Tests | `runner.test.ts`, `trust.test.ts`, `commit.test.ts`, `verify.test.ts` |

**Acceptance criteria**

1. A commit created by `writeSignedCommit` with a `daemon:mac` key verifies as
   `{ status: "good", principal: "daemon:mac" }`; `git cat-file -p` shows the same tree/parents/
   message; the commit is also accepted by `git verify-commit` with the same allowed signers file.
2. Unsigned commit ⇒ `missing`; signed by a key absent from allowed_signers ⇒ `unknown_key`;
   commit whose message was altered after signing (rewrite object with same gpgsig) ⇒ `bad`.
3. A repo-local `gpg.ssh.allowedSignersFile` pointing to an attacker file is ignored (our `-c`
   wins).
4. A commit made by stock `git commit -S` (`gpg.format=ssh`) verifies identically (interop).
5. `parseAllowedSigners` handles comments, `namespaces="git"`, multiple principals
   (`human,daemon:mac` comma list), and reports invalid principals as errors.
6. Signatures are deterministic for the same payload/key (ed25519) — asserted.
7. `NodeGitRunner` never uses a shell (test with an argument containing `;` and `$(...)`).

**Test command:** `npx vitest run src/git && npm run lint && npm test`

### SK-103 — Sim primitives: RNG, virtual time, fake clock, backoff (pi)

Read first: `docs/ARCHITECTURE.md` §13.1, `src/util/clock.ts`, `src/util/random.ts`.

**Create**

| File | Exports |
|---|---|
| `src/sim/rng.ts` | `class Rng { constructor(seed: number \| string); next(): number /* [0,1) */; int(min: number, maxInclusive: number): number; chance(p: number): boolean; pick<T>(xs: readonly T[]): T; shuffle<T>(xs: readonly T[]): T[] /* new array */; bytes(n: number): Uint8Array; fork(label: string): Rng /* independent stream derived from seed + label */ }`; `rngRandomSource(rng: Rng): RandomSource`. Algorithm: sfc32 seeded by a cyrb128 hash of `String(seed)`. No `Math.random`. |
| `src/sim/fake-clock.ts` | `class VirtualTime { constructor(startMs?: number); get now(): number; nextTimerAt(): number \| null; advance(ms: number): Promise<void>; runNext(): Promise<boolean> }` and `class FakeClock implements Clock { constructor(vt: VirtualTime, opts?: { wallStartMs?: number; skewMs?: number }); monotonicMs(); nowMs(); sleep(ms, signal?); suspend(); resume(); readonly suspended: boolean; setSkew(ms: number) }` |
| `src/util/backoff.ts` | `interface BackoffOptions { baseMs?: number /*500*/; maxMs?: number /*30_000*/; factor?: number /*2*/; jitter?: number /*0.25*/ }`; `backoffDelay(attempt: number, rs: RandomSource, opts?: BackoffOptions): number` — `min(maxMs, baseMs·factor^attempt)` scaled by a uniform factor in `[1−jitter, 1+jitter]` drawn from `rs`, clamped to `[0, maxMs]` |
| Tests | `src/sim/rng.test.ts`, `src/sim/fake-clock.test.ts`, `src/util/backoff.test.ts` |

Semantics of the fake clock:
* `monotonicMs()` = virtual time elapsed since construction **minus** total time spent suspended
  (frozen while suspended). `nowMs()` = `wallStartMs + vt.now + skewMs` (keeps advancing during
  suspend, so `Δwall − Δmono` exposes the suspension).
* `sleep(ms)` resolves when the clock's monotonic time reaches `start + ms`; a suspended clock's
  timers do not fire until it resumes (their virtual fire time shifts by the suspended duration).
  Abort ⇒ reject with an `AbortError` (`DOMException` name `AbortError`), timer removed.
* `advance(ms)` fires due timers across all clocks in order of virtual fire time, ties broken by
  creation order, awaiting a microtask flush (`await Promise.resolve()` a few times or
  `setImmediate`) after each so continuations run before the next timer.

**Acceptance criteria**

1. Same seed ⇒ identical first 1,000 `next()` values; different seeds differ; `fork(label)`
   depends only on (seed, label) — not on how many values the parent has drawn — and two forks
   with different labels differ.
2. `int` covers both bounds and stays in range (property test over 10k draws); `shuffle` is a
   permutation and does not mutate input; `bytes(n)` length n.
3. Fake clock: sleeps of 30, 10, 20 ms resolve in order 10, 20, 30 after `advance(30)`; a sleep
   created inside a timer continuation with a due time ≤ the advance target also fires in the same
   `advance` call.
4. Suspend: `suspend()`, `advance(3_600_000)`, `resume()` ⇒ monotonic unchanged by the hour,
   wall advanced by the hour; a pending 1,000 ms sleep fires only after resume + 1,000 ms of
   remaining time.
5. Skew changes `nowMs()` only. Aborted sleeps reject with `AbortError` and never fire.
6. `backoffDelay`: attempt 0 ≈ 500 ms ± 25 %, monotone in expectation, never above `maxMs`, and
   deterministic for a seeded `RandomSource`.
7. No use of `Date.now`, `performance.now`, `setTimeout` in `src/sim/*` except `setImmediate`/
   microtasks for flushing.

**Test command:** `npx vitest run src/sim src/util && npm run lint && npm test`

### SK-104 — CLI skeleton (pi)

Read first: PRD §15.2 (command table), `docs/ARCHITECTURE.md` §12, `src/core/ids.ts`.

**Create / modify**

| File | Exports / behaviour |
|---|---|
| `src/config/paths.ts` | `skepHome(env?: NodeJS.ProcessEnv): string` (`SKEP_HOME` or `~/.skep`); `skepPaths(home: string)` ⇒ `{ home, deviceToml, allowedSigners, socket, lockFile, blackboardClone, cliBlackboardClone, keysDir }` |
| `src/cli/output.ts` | `class CliError extends Error { code: string; exitCode: number }`; exit codes `EXIT = { ok: 0, error: 1, usage: 2, rejected: 3, notImplemented: 4 }`; `interface Output { machine: boolean; result(data: unknown, human: () => string): void; error(err: CliError): void }`; `createOutput({ machine, stdout, stderr })` — machine mode prints exactly one JSON line `{ "ok": true, "result": ... }` / `{ "ok": false, "error": { "code", "message" } }` |
| `src/cli/language.ts` | `isPredominantlyNonLatin(text: string): boolean` — > 50 % of letters outside Latin script (use `\p{Script=Latin}` with the `u` flag) |
| `src/cli/commands/*.ts` | One module per group: `init`, `agent`, `task`, `plan`, `replan`, `lease`, `decide`, `status`, `log`, `logs`, `doctor`, `sim`. Each exports `register(program: Command, ctx: CliContext): void` adding its (sub)commands with options and validation; actions call `notImplemented("<command path>")` (throws `CliError` code `not_implemented`, exit 4) after validating arguments |
| `src/cli/program.ts` | `interface CliContext { stdout: Writable-like { write(s: string): void }; stderr: same; env: NodeJS.ProcessEnv; output(): Output }`; `buildProgram(ctx): Command` with global options `--machine`, `--home <dir>`; `runCli(argv: string[], ctx): Promise<number>` (returns exit code; uses `exitOverride()` so Commander never calls `process.exit`) |
| `src/bin/skep.ts` | replace stub: `process.exitCode = await runCli(process.argv.slice(2), realCtx)` |
| Tests | `src/cli/program.test.ts`, `src/cli/language.test.ts`, `src/config/paths.test.ts` |

Commands and validation (all MVP rows of PRD §15.2):
`init --device <name> --blackboard <url>` (device matches `DEVICE_RE`) · `agent start|stop
[--role-dir <dir>]` · `task new <text> --repo <name> [--owner <agentId>] [--team]
[--allow-non-english]` · `task cancel <task> --reason <text>` · `plan show <task> [--version <n>]
[--diff]` · `plan approve|reject <task> [--note <text>]` · `replan <task> --reason <text>
[--evidence <file>...]` · `lease revoke <task> <item> --epoch <n> [--reason <text>]` · `decide
<task> (--resume | --replan | --cancel | --owner <agentId>) [--note <text>]` · `status` · `log
<task>` · `logs <agent> [--follow]` · `doctor` · `sim run --scenario <name> [--seed <n>] [--steps
<n>]`. Task IDs, item IDs, agent IDs validated with the regexes in `src/core/ids.ts`; integers
must be positive.

**Acceptance criteria**

1. `runCli(["--help"])` exits 0 and the help text lists every command above.
2. Invalid task id / item id / agent id / epoch ⇒ exit 2, message names the bad argument; in
   `--machine` mode stdout is a single JSON line `{"ok":false,"error":{"code":"usage",...}}`.
3. `decide` with zero or two of `--resume/--replan/--cancel/--owner` ⇒ exit 2.
4. `task new` with predominantly Chinese text ⇒ exit 2 `non_english_task` unless
   `--allow-non-english`; valid invocations of every command ⇒ exit 4 `not_implemented`.
5. `skepHome` honours `SKEP_HOME`, `--home` overrides both; `skepPaths` returns absolute paths.
6. No test writes to the real home directory; `npm run skep -- --help` works.

**Test command:** `npx vitest run src/cli src/config && npm run lint && npm test`

## Wave 2 task briefs

All Wave-2 tasks branch from `main` after Wave 1 (SK-101..SK-104 merged). Run `npm ci` first.
Each task ends with: its test command green, `npm run lint` green, `npm test` green, one or more
commits on its branch. Tasks below must not edit files from Wave 1 (`src/core/**` contracts,
`src/git/{runner,trust,signer,commit,verify}.ts`, `test/helpers/*`); extend helpers only inside
your own test files.

### SK-201 — Reducer: lease & delivery handlers (codex)

Read first: `docs/ARCHITECTURE.md` §5.3, §5.5 (rows lease.* / work.* / item.merged /
task.verified, budgets), §6.1–§6.2, `src/core/reducer/state.ts`, `src/core/reducer/handlers/plan.ts`
(`activatePlan`, item statuses), `src/core/reducer/handlers/task.test.ts` (fixtures style).

SK-101 created `handlers/{lease,work,merge}.ts` as **stubs** with final signatures, already wired
into `apply.ts`. Replace the stub bodies; do not change `apply.ts`, `types.ts` or the exported
names. `checkPre` already ran (task exists, not terminal, every `pre` key matched) before your
handler is called.

**Create / modify**

| File | Exports |
|---|---|
| `src/core/reducer/handlers/barrier.ts` (new) | `isSettled(task: TaskState, item: ItemId): boolean` — item ∈ `barrier.checkpointed` or its lease is `null` (released, revoked, failed); `settleBarrier(task: TaskState, seq: number): void` — if `task.barrier` is open (`closed_seq === null`) and every `awaiting` item is settled ⇒ `closed_seq = seq`, status `replanning` (or `escalated` with `escalation = { reason: "replans", seq }` if `barrier.escalate`); otherwise no-op. Shared with SK-202 (checkpoint, barrier.closed). |
| `src/core/reducer/handlers/lease.ts` | `handleLeaseClaimed`, `handleLeaseReleased`, `handleLeaseRevoked` |
| `src/core/reducer/handlers/work.ts` | `handleWorkDelivered`, `handleWorkFailed` |
| `src/core/reducer/handlers/merge.ts` | `handleItemMerged`, `handleTaskVerified` |
| Tests | `handlers/lease.test.ts`, `handlers/work.test.ts`, `handlers/merge.test.ts`, `handlers/barrier.test.ts` (build logs with `LogBuilder`; barrier states may be constructed directly, since `replan.requested` is SK-202) |

Rules (ARCHITECTURE §5.5 is normative; check order = reason precedence):

* `lease.claimed` (status `executing`): barrier null (`barrier_open`); item `ready`
  (`item_not_ready`); actor == assignee (`not_assignee`); `expected_epoch == epochs[item] ?? 0`
  (`epoch_mismatch`); `pre.plan_hash` == active plan hash (`plan_changed`); actor's active leases
  across **all** tasks < `agents[actor].profile.max_parallel_items` (`max_parallel`);
  `attempts_this_plan ≤ budgets.item_retries` (`retry_budget`); branch ==
  `workBranch(task, item, epoch + 1)` from `src/core/ids.ts` (`bad_branch`). Effect: `epochs[item]
  += 1`; lease `{ epoch, holder, attempt_id, branch, plan_version, plan_hash, granted_at_seq,
  interrupt: null }`; item `leased`; `attempts_this_plan += 1`.
* Fencing for released/delivered/failed: `lease !== null ∧ lease.holder == actor ∧ lease.epoch ==
  payload.epoch`, else `fenced`.
* `lease.released` (executing, interrupting): lease null, item `ready`; then `settleBarrier`.
* `lease.revoked` (executing, interrupting, escalated): lease exists ∧ epoch matches
  (`epoch_mismatch`); lease null; item `ready` (`unknown` if interrupting); then `settleBarrier`.
* `work.delivered` (executing): fenced; `lease.interrupt === null` (`interrupted`); branch ==
  `lease.branch` (`bad_branch`). Item `delivered` (record `Delivery`), lease null; next item in
  stack whose deps are all delivered ⇒ `ready`; all delivered ⇒ task `delivered`.
* `work.failed` (executing, interrupting): fenced; item `failed` (record `failure`), lease null.
  Interrupting ⇒ `settleBarrier`. Executing ⇒ `attempts_this_plan ≤ item_retries` and class ≠
  `budget_exceeded` ⇒ item `ready`; else task `escalated` (`escalation.reason = "item_failed"` or
  `"budget_exceeded"`).
* `item.merged` (executing, delivered, escalated): item delivered ∧ `pr_number` ==
  `delivered.pr_number` (`bad_task_state`); item `merged`; all items merged ⇒ task `done`.
* `task.verified` (delivered): `top_of_stack_sha` == delivered `head_sha` of the last
  `stack_order` item (`bad_task_state`); record `verified`.

**Acceptance criteria**

1. Claim happy path: epoch 0 → 1, branch `skep/<task>/W1/e1`, item `leased`, attempts 1; each
   rejection reason above is produced by a test (`barrier_open`, `item_not_ready`, `not_assignee`,
   `epoch_mismatch`, `plan_changed`, `max_parallel` with a lease in a **second** task,
   `retry_budget`, `bad_branch`) and leaves state unchanged except the outcome.
2. Two claims computed from the same state: first accepted, second rejected (`epoch_mismatch` or
   `item_not_ready`, via replay with correct `observed_tip`).
3. Revoke epoch 1 then the stale holder's `work.delivered{epoch 1}` ⇒ `fenced`; re-claim ⇒ epoch 2,
   branch `e2`; delivery by the new holder accepted.
4. Two-item stack: W1 delivered ⇒ W2 `ready`; W2 delivered ⇒ task `delivered`; `task.verified`
   with W2 head accepted, with W1 head rejected; `item.merged` W1 then W2 ⇒ `done`; wrong
   `pr_number` ⇒ `bad_task_state`.
5. `work.failed`: first failure with `item_retries: 1` ⇒ item `ready` and a re-claim is allowed;
   failure after the retry budget ⇒ `escalated`; `budget_exceeded` ⇒ `escalated` immediately.
6. Barrier (constructed state): in `interrupting` with awaiting `[W1, W2]`, releasing W1 keeps the
   barrier open; failing W2 closes it (`closed_seq` set, status `replanning`); with `escalate:
   true` ⇒ `escalated`; revoke in `interrupting` ⇒ item `unknown`; `work.delivered` with
   `lease.interrupt` set ⇒ `interrupted`.
7. Purity/determinism tests from SK-101 still pass; new handlers don't mutate input (deep-freeze
   one case).

**Test command:** `npx vitest run src/core/reducer && npm run lint && npm test`

### SK-203 — Git log reader → `LogEntry[]` (codex)

Read first: `docs/ARCHITECTURE.md` §5.1, §5.3 step 1, §7.3, `src/core/log.ts` (contract,
**normative**), `src/git/{runner,verify}.ts`, `test/helpers/git-fixture.ts`.

**Create**

| File | Exports |
|---|---|
| `src/git/log-reader.ts` | `interface ReadLogOptions { ref?: string /* default "refs/heads/main" */; from?: { sha: Sha; seq: number } }`; `class LogReadError extends Error` (also used when `from.sha` is not on the first-parent chain of `ref`, i.e. history was rewritten — the caller alarms and falls back to a full read); `readLog(git: GitRunner, repoDir: string, trustRootPath: string, opts?: ReadLogOptions): Promise<LogEntry[]>` |
| Tests | `src/git/log-reader.test.ts`, `test/integration/log-reader-replay.test.ts` |

Algorithm (fixed number of git processes per call, independent of commit count where possible):

1. `git rev-list --first-parent --reverse <ref>` (or `<from.sha>..<ref>`); `seq` = index from
   genesis (or `from.seq + 1 + i`). Verify `from.sha` with `git merge-base --is-ancestor` **and**
   membership in the first-parent list; otherwise `LogReadError`.
2. Parents: `git log --no-walk --format=%H%x00%P <shas…>` (one call; batch to keep argv < 64 KiB).
3. Changes: per commit `git diff-tree -r -z --no-renames --name-status <firstParent> <sha>`
   (genesis: `--root`). Map `A/M/D/T` to themselves, everything else ⇒ `"other"`. Diff against the
   **first** parent so merge commits are represented faithfully (the reducer rejects them as
   `not_linear`).
4. Added contents: only for `A` paths under `events/` and, for seq 0, `skep.json`. One `git
   cat-file --batch` process: request `<sha>:<path>`; size > `MAX_EVENT_BYTES` ⇒ `null` without
   reading more than `MAX_EVENT_BYTES + 1` bytes into a string; invalid UTF-8 (`TextDecoder` with
   `fatal: true`) ⇒ `null`.
5. Signatures: a single `verifyCommits(git, repoDir, trustRootPath, shas)` call (SK-102).

**Acceptance criteria**

1. Real repo (temp dir, `git-fixture`): genesis + 3 signed single-file event commits ⇒ 4 entries,
   seq 0..3, correct parents, `changes` = one `A`, `added` contains the exact file bytes, `signature`
   `good` with the right principal.
2. Faithful representation: a merge commit (2 parents, first-parent diff), a commit adding two
   files, a commit modifying a file, an unsigned commit, an oversized file (`null`), a non-UTF-8
   file (`null`), and a file outside `events/` (not read) — each produces the expected `LogEntry`
   and `replay` classifies it with the expected `InvalidReason`.
3. Incremental: `readLog(..., { from: { sha: entries[k].sha, seq: k } })` equals
   `entries.slice(k + 1)`; `from` not on the chain (after a force-push to a divergent history) ⇒
   `LogReadError`.
4. `test/integration/log-reader-replay.test.ts`: the same logical events written to a real repo
   (with correct `observed_tip`) and built with `LogBuilder` replay to equal `tasks`, `agents` and
   outcome kinds/reasons (shas differ by construction; compare with `sha`/`tip` fields stripped).
5. Process count: reading 50 commits spawns a bounded number of git processes (assert with a
   counting `GitRunner` wrapper; diff-tree per commit is allowed, cat-file/verify/log are one each).
6. A repo-local config (e.g. `core.quotePath`, `diff.renames=true`, `log.showSignature`) does not
   change the output.

**Test command:** `npx vitest run src/git test/integration/log-reader-replay.test.ts && npm run lint && npm test`

### SK-205 — exec/fs utilities + run journal (pi)

Read first: `docs/ARCHITECTURE.md` §9.7, §11.3–§11.4, PRD §10.6, `src/util/clock.ts`, AGENTS.md
(subprocess rules).

**Create**

| File | Exports |
|---|---|
| `src/util/exec.ts` | `interface ExecOptions { cwd?: string; env?: Record<string, string> /* passed as-is, no implicit process.env merge */; input?: string \| Uint8Array; timeoutMs?: number /* default 120_000 */; maxBufferBytes?: number /* default 16 MiB */; allowFailure?: boolean; signal?: AbortSignal }`; `interface ExecResult { code: number \| null; signal: string \| null; stdout: string; stderr: string; timedOut: boolean }`; `class ExecError extends Error { file; args; result }`; `execFileChecked(file: string, args: string[], opts?: ExecOptions): Promise<ExecResult>` — `execFile` with `shell: false`; throws `ExecError` on non-zero exit, signal, timeout or buffer overflow unless `allowFailure` |
| `src/util/fs.ts` | `atomicWrite(path: string, data: string \| Uint8Array, opts?: { mode?: number }): Promise<void>` (temp file in the same dir ⇒ write ⇒ fsync ⇒ rename ⇒ fsync dir); `appendFsync(path: string, data: string): Promise<void>` (open `a`, write, fsync, close; creates parent dirs); `class PathEscapeError extends Error`; `safeJoin(root: string, rel: string): Promise<string>` — rejects absolute paths, `..` segments, NUL bytes, and results whose deepest existing ancestor's `realpath` lies outside `realpath(root)` (symlink escape) |
| `src/exec/journal.ts` | `interface AttemptKey { task: TaskId; item: ItemId; epoch: number }`; `type JournalRecord = { ts_mono: number; ts_wall: string; step: string; [k: string]: unknown }`; `TERMINAL_STEPS = ["delivered_published", "failed", "checkpointed", "stale"] as const`; `class Journal { constructor(opts: { roleDir: string; clock: Clock }); path(key): string /* <roleDir>/.skep/journal/<task>/<item>-e<epoch>.jsonl */; append(key, record: { step: string; [k: string]: unknown }): Promise<JournalRecord>; read(key): Promise<JournalRecord[]>; unfinishedAttempts(): Promise<AttemptKey[]> /* last step not terminal; sorted by task, item, epoch */ }` |
| Tests | `src/util/exec.test.ts`, `src/util/fs.test.ts`, `src/exec/journal.test.ts` |

**Acceptance criteria**

1. `execFileChecked` never uses a shell (argument `"; echo pwned $(id)"` is passed literally to
   `node -e`); non-zero exit ⇒ `ExecError` with stdout/stderr; `allowFailure` returns the result;
   `timeoutMs` kills the child (`timedOut: true`); overflowing `maxBufferBytes` ⇒ `ExecError`;
   `env` is exactly what was passed (child sees no unlisted variable).
2. `atomicWrite` never leaves a partial target (target content is old or new; no temp files remain
   after success); `mode` applied.
3. `safeJoin` rejects `../x`, `/etc/passwd`, `a/../../x`, `a\0b`, and a symlink inside root
   pointing outside; accepts nested paths that do not exist yet.
4. Journal: append ⇒ fsync'd JSONL line with `ts_mono`/`ts_wall` from the injected `FakeClock`;
   `read` returns records in order; a torn last line (partial JSON without newline) is ignored by
   `read`, and the next `append` starts on a fresh line; a corrupt **middle** line throws a typed
   error naming file and line.
5. `unfinishedAttempts` returns exactly the attempts whose last step is non-terminal across several
   tasks/items/epochs; an empty or missing journal dir ⇒ `[]`.
6. Tests use temp dirs only; no `Date.now`/`setTimeout` in `src/exec/journal.ts`.

**Test command:** `npx vitest run src/util src/exec && npm run lint && npm test`

### SK-206 — Config loaders: device.toml, AGENT.md, checks.toml (pi)

Read first: PRD §7.1–§7.3, §11.5, `src/core/schemas/config.ts` (normative), `src/config/paths.ts`
(SK-104). Dependencies already present: `smol-toml`, `yaml`.

**Create**

| File | Exports |
|---|---|
| `src/config/errors.ts` | `class ConfigError extends Error { file: string; line: number \| null }` — message format `<file>[:<line>]: <problem>`; Zod issues rendered as `<dotted.path>: <message>`, one per line |
| `src/config/device.ts` | `parseDeviceConfig(text: string, file: string): DeviceConfig`; `loadDeviceConfig(path: string): Promise<DeviceConfig>`; `findRepo(cfg: DeviceConfig, nameOrUrl: string): { name: string; url: string } \| null` (match by `name` or exact `url`; also normalizes a trailing `.git` / trailing `/`) |
| `src/config/agent-md.ts` | `interface AgentMd { frontMatter: AgentMdFrontMatter; body: string; file: string }`; `parseAgentMd(text: string, file: string): AgentMd` — front-matter between a first line `---` and the next `---` line, parsed with `yaml` (no custom tags), validated with `AgentMdFrontMatterSchema`; body = the rest, trimmed, must be non-empty; `loadAgentMd(roleDir: string): Promise<AgentMd>` reads `<roleDir>/AGENT.md` |
| `src/exec/checks-file.ts` | `parseChecksFile(text: string, source: string): ChecksFile` — TOML ⇒ `ChecksFileSchema`; pure (loading at `base_commit` via `git show` is SK-502) |
| Fixtures | `test/fixtures/config/{device.valid.toml, device.bad-repo.toml, agent.valid.md, agent.no-frontmatter.md, checks.valid.toml, checks.bad-argv.toml}` |
| Tests | `src/config/device.test.ts`, `src/config/agent-md.test.ts`, `src/exec/checks-file.test.ts` |

**Acceptance criteria**

1. Valid fixtures parse; defaults applied (`poll`, `requires_local`, `max_parallel_items`,
   `budgets`, `timeout_sec`, `parser`).
2. TOML/YAML syntax errors ⇒ `ConfigError` with the file and the 1-based line from the parser;
   schema errors ⇒ `ConfigError` naming the dotted path (e.g. `repos.0.name`); unknown keys
   rejected (strict schemas).
3. AGENT.md without front-matter, with an unterminated front-matter, or with an empty body ⇒
   `ConfigError`; body extracted verbatim otherwise.
4. `findRepo` by name, by URL, with/without `.git`; unknown ⇒ `null`.
5. checks.toml: a check whose `argv` is a string (not an array), an invalid check name, or an `env`
   key in lowercase ⇒ `ConfigError`.
6. No test reads the real `~/.skep`; files come from fixtures or temp dirs.

**Test command:** `npx vitest run src/config src/exec && npm run lint && npm test`

---

## Wave 2b / Wave 3 task briefs

All tasks: branch `task/<ID>-<slug>` from the latest `main`, run `npm ci` first, own **only** the
files listed in the schedule above (plus colocated tests), never edit the frozen files listed under
the analysis table, and finish with the task's test command green. Normative: ARCHITECTURE
§4–§9, §11, D12–D16, D18, D19. Generic example values only. No credentials anywhere (D19).

### SK-202 — Reducer: replan, barrier, checkpoint handlers (codex, Batch A)

Read first: ARCHITECTURE §5.2, §5.5 (rows replan.requested, checkpoint.recorded, barrier.closed;
budgets; D6, D12, D16), §6.1 "Which leases count", PRD §9.7; `handlers/barrier.ts`, `lease.ts`,
`work.ts` (style), `state.ts` (`Barrier`, `CheckpointRecord`).

**Modify:** `handlers/replan.ts` (replace the three stubs, keep the exported names), new
`handlers/replan.test.ts`, and in `replay.test.ts` **only** remove the three SK-202 types from the
"later-wave stub" assertions. Do not edit `plan.ts` (SK-208 runs concurrently), `barrier.ts`,
`lease.ts`, `apply.ts`, `state.ts`.

Rules (check order = rejection precedence):

* `replan.requested` — `executing`: if the signer principal is not `human`, `evidence.length ≥ 1`
  (`missing_evidence`); `payload.item` non-null ⇒ must exist (`unknown_item`). Effect:
  `replan_count += 1`; `barrier = { id: "B<seq>", opened_seq: seq, closed_seq: null, requests:
  [{seq, event_id, actor, summary, evidence_count}], awaiting: items in status `leased` in
  `stack_order`, checkpointed: [], escalate: replan_count > budgets.replans }`; every awaited
  lease gets `interrupt = barrier.id`; status `interrupting`; then `settleBarrier(task, seq)` (an
  empty `awaiting` closes it at once ⇒ `replanning`, or `escalated` with reason `replans`).
  `interrupting`/`replanning`: same evidence check, then append to `barrier.requests` only
  (coalesce; `replan_count` unchanged). Other statuses ⇒ `bad_task_state`.
* `checkpoint.recorded` — statuses `executing`, `interrupting`, `replanning`, `escalated`
  (`bad_task_state`); fenced (`lease !== null ∧ holder == actor ∧ epoch == payload.epoch`, else
  `fenced`); `snapshot.item/epoch == payload.item/epoch` (`bad_snapshot`); `barrier_id === null`
  or `== task.barrier?.id` (`no_barrier`). Effect: `last_checkpoint = { epoch, seq, barrier_id,
  head_sha: snapshot.head_sha, invocation_state: snapshot.invocation_state }`. If `barrier_id` is
  set: item `interrupted`, add to `checkpointed` (no duplicates), **keep the lease** (parked, D16),
  then `settleBarrier`. A voluntary checkpoint (`barrier_id: null`) changes nothing else.
* `barrier.closed` — `interrupting`; `barrier_id == task.barrier.id ∧ closed_seq === null`
  (`no_barrier`); sorted `missing` == sorted(awaiting − settled) (`pre_mismatch`). Effect: each
  missing item: lease `null`, status `unknown`; then `settleBarrier` (⇒ `replanning`/`escalated`).

**Acceptance criteria**

1. Every row of the DEV-PLAN SK-202 entry, each rejection reason above with no state change but
   the outcome.
2. Full cycle via `LogBuilder` (use **solo** plans in solo tasks or **team** plans in team tasks so
   the log is valid both before and after SK-208): claim W1 ⇒ `replan.requested` ⇒ checkpoint ⇒
   `replanning` ⇒ `plan.proposed` v2 ⇒ approve ⇒ `executing`, barrier cleared, epochs kept, W1
   re-claimable at epoch+1; a stale `work.delivered` from epoch 1 ⇒ `fenced` or `interrupted`.
3. Budget: with `replans: 2` the third barrier escalates only after settlement (reason `replans`);
   coalesced requests do not count; `human.decided{replan}` afterwards clears the barrier (D12).
4. D16: holder with `max_parallel_items: 1` checkpoints in task A ⇒ claim in task B accepted;
   before the checkpoint (flagged, still `leased`) ⇒ `max_parallel`.
5. Late checkpoint in `replanning`/`escalated` for the parked lease is accepted and changes no
   status; deep-freeze + prefix-replay determinism test as in `merge.test.ts`.

**Test command:** `npx vitest run src/core/reducer && npm run lint && npm test`

### SK-208 — Reducer: plan-mode routing (D13) (codex, Batch A)

The DEV-PLAN row is the spec (ARCHITECTURE §5.5 "Plan mode decides routing", D13, D15). **Modify
only** `handlers/plan.ts` and `handlers/plan.test.ts`; keep the D15 status derivation at the end
of `activatePlan` and add `task.mode = record.plan.mode` there. Do not touch `replan.ts` or
`replay.test.ts` (SK-202). If a test in another file encodes the old `plan.mode == task.mode`
rule, change only that assertion and say so in the commit body.

**Acceptance criteria:** as in the row; additionally `npx vitest run src/core/reducer` shows the
D14/D15 tests in `merge.test.ts` and the D16 tests in `lease.test.ts` unchanged and green.

**Test command:** `npx vitest run src/core/reducer && npm run lint && npm test`

### SK-204 — Reducer views + `statusView` (pi, Batch A)

Read first: ARCHITECTURE §5.6, §6.1 (D16), §16 (D19), `state.ts`, `handlers/{lease,barrier}.ts`.

**Create** `src/core/reducer/views.ts` (pure) + `views.test.ts`; add `export * from "./views.js";`
to `src/core/reducer/index.ts` (the only edit outside your files).

| Export | Contract |
|---|---|
| `claimableItems(s: State, agent: AgentId): ClaimCandidate[]` | `{ task_id, item, expected_epoch, plan_version, plan_hash, branch }` (branch = `workBranch(task, item, epoch + 1)`); task `executing` ∧ barrier null ∧ item `ready` ∧ assignee == agent ∧ `attempts_this_plan ≤ budgets.item_retries`; returns `[]` for an unregistered agent or when `activeLeaseCount(s, agent) ≥ max_parallel_items`; sorted by task_id, then `stack_order` |
| `leasesHeldBy(s, agent): HeldLease[]` | `{ task_id, item, epoch, branch, interrupt, parked }`, `parked` = item status `interrupted` (D16) |
| `isOwner(s, taskId, agent): boolean` | |
| `pendingReviews(s, agent): { task_id, plan_version, plan_hash }[]` | task `reviewing`, agent ∈ current plan reviewers, no review by agent yet |
| `barrierStatus(s, taskId): BarrierStatus \| null` | `{ id, open, awaiting, settled, missing, escalate, request_count }` using `isSettled` |
| `statusView(s): StatusView` | stable, JSON-only: `seq`, `tip`, agents (id, device, agent_cli, cli_version, max_parallel_items), tasks (status, mode, owner, owner_gen, current/active plan version, items with status/assignee/epoch/holder/parked, barrier status, `escalation` incl. `verification_failed`, `verified`, replan_count/review_rounds with budgets); arrays sorted; **no provider information** (D19) |

**Acceptance criteria:** each function tested over `LogBuilder` logs; barrier and parked-lease
cases use constructed states (SK-202 runs concurrently); `claimableItems` never offers an item the
reducer would reject for `max_parallel`/`retry_budget`/`barrier_open` (cross-check by applying the
claim it returns); `canonicalJson(statusView(s))` equals `JSON.stringify` of a re-parse and is
identical for two replays; inputs not mutated (deep-freeze).

**Test command:** `npx vitest run src/core/reducer && npm run lint && npm test`

### SK-207 — Adapter spike: pinned Codex CLI (codex, Batch A)

Read first: ARCHITECTURE §9.1–§9.3, §10.1, §16 (D19), `src/adapter/types.ts`,
`src/runtime/types.ts`, PRD §13.1.

**Create:** `docs/spikes/adapter-codex.md`; `src/adapter/codex.ts` + `codex.test.ts`;
`test/fixtures/codex/*.jsonl` (recorded or hand-made event streams with generic content);
`test/integration/adapter-codex.test.ts` (opt-in, `SKEP_REAL_CODEX=1`).

* `export type InterruptLadder = (h: ProcessHandle, clock: Clock) => Promise<"completed" |
  "interrupted" | "killed">` — SK-306's `runInterruptLadder` is structurally identical; do not
  import from `src/exec/interrupt.ts` (not merged yet).
* `class CodexAdapter implements AgentAdapter` — constructor `{ runtime: RuntimeBackend;
  interrupt: InterruptLadder; clock: Clock; codexPath?: string }`; `probe()` (version string);
  `invoke(inv)` builds argv (no shell), writes the schema to `inv.scratchDir`, passes the prompt on
  stdin, parses JSONL events (usage, approval request ⇒ `permission_prompt`), reads the
  last-message file, enforces `timeoutMs` and `signal` through `interrupt`.
* The opt-in real test uses a minimal inline `RuntimeBackend` in the test file, not `native.ts`.

**Report must cover:** exact flags (non-interactive, approval policy, sandbox, output schema,
last-message file, JSON events), version string, usage fields, SIGINT behaviour, permission-prompt
detection, and **D19:** how the CLI authenticates from the agent user's own local configuration
when the daemon passes only the sanitized environment (no credentials), and what the human must
configure on each device; plus the Codex-vs-fallback decision.

**Acceptance criteria:** unit tests with a fake `RuntimeBackend` replaying fixtures cover success,
invalid final message, approval request ⇒ `permission_prompt`, timeout ⇒ ladder called ⇒
`timeout`, abort ⇒ `interrupted`/`killed`, missing usage ⇒ `null`; argv never contains the
prompt or any credential; `adapter/types.ts` unchanged (contract problems go into the commit
body).

**Test command:** `npx vitest run src/adapter && npm run lint && npm test` (plus, on a device with
the pinned CLI configured: `SKEP_REAL_CODEX=1 npx vitest run test/integration/adapter-codex.test.ts`)

### SK-301 — Blackboard clone, publisher write loop, genesis (codex, Batch A)

Read first: ARCHITECTURE §7.1–§7.4, §4.5, §5.3, PRD §10.2; `src/git/{runner,commit,signer}.ts`,
`src/git/log-reader.ts`, `src/util/backoff.ts`, `test/helpers/git-fixture.ts`.

| File | Exports |
|---|---|
| `src/core/intents.ts` (pure) | `interface EventDraft<T extends EventType = EventType> { type: T; task_id: TaskId \| null; actor: string; pre: Pre; payload: PayloadOf<T> }`; `type Intent = (s: State) => EventDraft \| null`; `draft(type, taskId, actor, payload, pre)`; `finalizeEvent(d, { event_id, observed_tip, created_at }): SkepEvent` (runs `parseEvent`, throws a typed error). No intent builders (SK-403). |
| `src/blackboard/clone.ts` | `class BlackboardClone { constructor({ git, dir, remoteUrl }); init(): Promise<void> /* non-bare, mode 0700, refspecs §7.1 */; fetch(): Promise<void> /* main + hb/* */; resetToRemoteMain(): Promise<Sha>; }` |
| `src/blackboard/publisher.ts` | `interface StateSource { replayTo(tip: Sha): Promise<State> }`; `fullReplaySource(git, dir, trustPath): StateSource` (readLog + replay, no cache); `interface PublishResult`; `class Publisher { constructor({ git, clone, signer, clock, rng, state: StateSource, ident, maxAttempts? }); publish(intent, opts?: { signer?: Signer }): Promise<PublishResult> }` — §7.2 steps 1–9, serialized FIFO, backoff via `util/backoff` + `rng`, sleeps via `clock` |
| `src/blackboard/genesis.ts` | `createGenesis({ git, clone, signer /* human */, genesis, allowedSignersText, ident }): Promise<Sha>` — refuses if remote `main` exists |

**Acceptance criteria:** the DEV-PLAN row; plus (recording `GitRunner` wrapper defined in the test
file) no `rebase`/`merge`/`pull`/`--force` ever on `main`; lost-ack (push performed, error
reported) resolves through `seen_event_ids` to exactly one commit; an intent returning `null` ⇒
`dropped`; a rejected event ⇒ `rejected` with the reducer reason; `MAX_ATTEMPTS` exhaustion ⇒
`failed`; the `opts.signer` path signs with the human test key and the reducer accepts the human
event. Hint publishing is **not** part of this task (SK-601 wires it, D18).

**Test command:** `npx vitest run src/blackboard src/core/intents.test.ts test/integration/publisher-race.test.ts && npm run lint && npm test`

### SK-308 — Transport interface: wake-up hints (codex, Batch A)

The DEV-PLAN row is the spec (ARCHITECTURE §17.3). **Create** `src/transport/types.ts`
(`HintSchema` (Zod), `type Hint`, `interface HintChannel`) and `src/transport/null-hint.ts`
(`class NullHintChannel implements HintChannel`), with tests. Export a `FakeHintChannel` only
from a test helper inside `src/transport/` named `fake-hint.ts` so SK-302 can import it (SK-308
owns it; SK-302 must not edit it).

**Test command:** `npx vitest run src/transport && npm run lint && npm test`

### SK-302 — Sync poller + state cache (codex, Batch B; after SK-301 + SK-308)

Read first: ARCHITECTURE §5.1 (incremental == full), §11.1 step 2, §17.3; `clone.ts` and
`publisher.ts` (`StateSource`) from SK-301; `src/transport/*` from SK-308. **Create**
`src/blackboard/sync.ts` + test; do not edit SK-301/SK-308 files.

`class Sync implements StateSource { constructor({ git, clone, trustPath, clock, rng, hints?:
HintChannel, intervals?: { activeMs: 20_000, idleMs: 90_000, jitter: 0.25, minHintGapMs: 2_000 }
}); replayTo(tip); observeNow(): Promise<State>; start(); stop(); current(): { state, tip, seq,
fetchedAtMonoMs, invalidCount }; onState(cb); onAlarm(cb) }` — incremental from the cached
`{sha, seq}` via `readLog({ from })`; `LogReadError` ⇒ alarm + full replay.

**Acceptance criteria:** the DEV-PLAN row (hint rate limit, forged hint, `ls-remote`
short-circuit, incremental == full over a real temp repo, adaptive interval with `FakeClock`).

**Test command:** `npx vitest run src/blackboard/sync.test.ts && npm run lint && npm test`

### SK-303 — Heartbeats + liveness (codex, Batch B)

Read first: ARCHITECTURE §8, PRD §10.4–§10.5, `src/core/schemas/heartbeat.ts`,
`src/git/{commit,verify}.ts`. **Create** `src/blackboard/{heartbeat,liveness}.ts` + tests; take a
`repoDir` parameter, do not use or edit `clone.ts`.

`class HeartbeatWriter { constructor({ git, repoDir, agent, signer, clock, bootId, onAlarm });
beat(hb: Omit<Heartbeat, "schema" | "agent" | "boot_id" | "n" | "sent_at">): Promise<void> }`;
`readHeartbeats(git, repoDir, trustPath, devices: Record<AgentId, string>): Promise<Record<AgentId,
{ oid: string; hb: Heartbeat | null; problem: string | null }>>`; `class LivenessTracker` exactly as
§8.2.

**Acceptance criteria:** the DEV-PLAN row; a beat signed by another device's key ⇒ `problem`; a
ref with a parent commit ⇒ `problem`; `main` sha unchanged by 10 beats.

**Test command:** `npx vitest run src/blackboard && npm run lint && npm test`

### SK-306 — Native runtime + interrupt ladder (codex, Batch B)

Read first: ARCHITECTURE §10.1, §9.2 (ladder), PRD §9.7, §10.6; `src/runtime/types.ts`.
**Create** `src/runtime/native.ts` (`class NativeRuntime implements RuntimeBackend`,
`readStartToken(pid)`) and `src/exec/interrupt.ts` (`runInterruptLadder(h: ProcessHandle, clock:
Clock, opts?: { graceMs?: number /*120_000*/; termMs?: number /*30_000*/ }): Promise<"completed" |
"interrupted" | "killed">` — must stay assignable to SK-207's `InterruptLadder`).

**Acceptance criteria:** the DEV-PLAN row; ladder steps driven by `FakeClock` (no real 120 s
waits); a child that traps SIGINT is escalated to SIGTERM/SIGKILL; grandchildren die with the
group; `isAlive` false after reuse simulation (wrong start token); uid/gid tests skipped unless
running as root.

**Test command:** `npx vitest run src/runtime src/exec/interrupt.test.ts && npm run lint && npm test`

### SK-307 — Structured output, prompts, fake adapter (codex, Batch B)

Read first: ARCHITECTURE §9.3–§9.5, §13.4, §16 (D19); model-facing schemas in
`src/core/schemas/{plan,review,work-report}.ts`. **Create** `src/adapter/{structured,prompts,fake}.ts`
+ tests; do not edit `types.ts` or `codex.ts` (SK-207).

Exports: `extractJson(text): unknown | null` (last JSON object, fenced or bare); `runStructured`
per §9.3 (exactly one `repair` invocation); `buildPlanPrompt`, `buildReviewPrompt`,
`buildWorkPrompt`, `buildFixupPrompt`, `buildRepairPrompt` (English, inputs passed explicitly —
never read env or files; D19); `class FakeAdapter implements AgentAdapter` scripted per §13.4.

**Acceptance criteria:** the DEV-PLAN row; a prompt-builder test asserts the output is a pure
function of its arguments (same inputs ⇒ same string; no `process.env` access).

**Test command:** `npx vitest run src/adapter && npm run lint && npm test`

### SK-304 — Reducer invariants + property tests (pi, Batch B; after SK-202 + SK-208)

The DEV-PLAN row is the spec (ARCHITECTURE §13.2 invariants 1–4, 6, 8, 9; invariant 6 is the per-transition form of D20: the event that exceeds a budget must escalate, and counters may stay over budget after `human.decided`). **Create**
`src/core/reducer/invariants.ts` (pure predicates `(entries, state) ⇒ Violation[]`),
`src/core/reducer/replay.property.test.ts`, `test/helpers/random-log.ts` (`randomLog(seed, opts)`
using `src/sim/rng.ts`; owned by SK-304, SK-305 may only import it). Use `activeLeaseCount` for
invariant 9; never reimplement handler rules.

**Test command:** `npx vitest run src/core/reducer && npm run lint && npm test`

### SK-305 — Golden replay fixtures (pi, Batch C; after SK-304)

The DEV-PLAN row is the spec. **Create** `test/fixtures/golden/*.json` (entries + expected
`contentHash(state)`), `test/helpers/golden.ts` (serialize/load + hash), and
`test/integration/golden.test.ts`. Updating hashes: `SKEP_UPDATE_GOLDEN=1 npx vitest run
test/integration/golden.test.ts` rewrites the fixtures (documented in the test file header) —
no `scripts/` dir and no `package.json` change.

**Test command:** `npx vitest run test/integration/golden.test.ts && npm run lint && npm test`

---

## Protocol gap closure (D14–D16, from the SK-201 review)

Decided in ARCHITECTURE §15 before Wave 3. The reducer part of all three gaps was small and
limited to `src/core/reducer/handlers/**`, so the architect fixed it directly (SK-209). No event
type or schema changed (`task.verified.passed` already existed, D11). The daemon/view parts are
folded into existing tasks; no new tasks were needed.

| Gap | Decision | Fixed now in code (SK-209) | Changed tasks |
|---|---|---|---|
| Failed top-of-stack verification had no path (review note 1) | D14: `task.verified{passed:false}` (owner) ⇒ `escalated`, reason `verification_failed`; no budget, no auto-retry; human resumes (re-verify), replans or cancels | `handlers/merge.ts` `handleTaskVerified` + tests | SK-606 (emit `passed:false`, never `work.failed`; scenario), SK-601 (verification duty after re-activation), SK-204 (status shows reason), SK-304, SK-305 |
| Replan carrying over every item stuck in `executing` (review note 3) | D15: activation status from rebuilt items: all merged ⇒ `done`, all delivered/merged ⇒ `delivered`, else `executing`; `verified` cleared | `handlers/plan.ts` `activatePlan` + tests | SK-208 (keep the D15 tail, branch after SK-209), SK-304 (invariant 8), SK-305 |
| `max_parallel` counted parked leases (review note 4) | D16: only items in status `leased` count; a checkpointed (`interrupted`) lease is parked until activation/revoke/cancel | `handlers/lease.ts` `activeLeaseCount` + tests | SK-202 (checkpoint keeps the parked lease; cross-task claim test), SK-204 + SK-403 (use `activeLeaseCount`), SK-601, SK-304 (invariant 9) |

---

## Wave 2b/3 follow-ups

Collected from the Wave 2b/3 reviews (`docs/reviews/SK-2xx.md`, `SK-30x.md`). Each item is
owned by the named future task; a task's brief inherits the items listed for it.

| # | Item | Source | Owner |
|---|---|---|---|
| F1 | Negative tests for invariant 6 codes `replan_budget` and `replan_budget_settle` (constructed over-budget barrier with `escalate: false`; escalate barrier settling into `replanning`) | SK-304 fix round | SK-405 |
| F2 | Doc comment on `checkInvariants`: the final `state` must equal `replay(entries)` (invariant 6 trusts it for the last step) | SK-304 fix round | SK-405 |
| F3 | Seventh golden fixture `review-resume` (D20: review-round escalation ⇒ `resume_with_plan` over budget) and `example.invalid` PR URLs, in one reviewed `SKEP_UPDATE_GOLDEN=1` run; move the rewrite out of test collection | SK-305, SK-304 | SK-405 |
| F4 | `extractJson`: recover the JSON object after a stray unmatched `{` in prose (fallback scan) + test | SK-307 | SK-405 |
| F5 | Round-trip tests `toCodexOutputSchema` ⇒ provider-shaped value with nulls ⇒ `normalizeOptionalNulls` ⇒ original Zod for Plan, Review, WorkReport | SK-207 fix round, SK-307 | SK-405 |
| F6 | `FakeHintChannel.publish` before `start()` documented (or recorded); mark the file as a test helper | SK-308 | SK-405 |
| F7 | `runInterruptLadder` returns `killed` when SIGTERM was needed (frozen contract: `killed` = "needed SIGTERM/SIGKILL"); feeds `snapshot.invocation_state` | SK-306 | SK-406 (before SK-504) |
| F8 | `outputSchema: "off"`: the adapter stops appending the JSON Schema (prompt builders already embed it) | SK-207 fix round, SK-307 | SK-406 |
| F9 | Reducer polish: coalesced `replan.requested` validates `payload.item`; `barrier.closed` throws on an impossible missing item; `replan.ts` header citing §5.5/PRD §9.7 | SK-202 | SK-406 |
| F10 | Observer-side duplicate-daemon alarm when a superseded `boot_id` re-appears on an `hb/*` ref (§8.1) | SK-303 | SK-406 |
| F11 | `Sync` optional `isActive(state)` predicate: fast polling only for tasks with work for this device's slots | SK-302 | SK-601 |
| F12 | One clone-level lock serializing Sync's fetch and the publisher's fetch/reset/commit/update-ref on the shared blackboard clone | SK-302 | SK-601 |
| F13 | Daemon wiring: `Sync` replaces `fullReplaySource` as the publisher's `StateSource`; `hints.publish({kind: "tip"})` after an accepted publish (D18); `readHeartbeats` ⇒ `LivenessTracker.observe` after each fetch | SK-301, SK-302, SK-303 | SK-601 |
| F14 | Gate invocations on `probe()` plus exact equality with AGENT.md `cli_version` at startup (the adapter no longer enforces the pin) | SK-207 | SK-601 |
| F15 | Claim at most `max_parallel_items − activeLeaseCount` candidates per tick | SK-204 | SK-403 / SK-601 |
| F16 | Suspend detector calls `LivenessTracker.resetAll()` | SK-303 | SK-403 |
| F17 | Persist the publisher `eventId` in the journal before the first attempt and re-publish with `opts.eventId` on recovery | SK-301 | SK-504 / SK-505 |
| F18 | Bound the interrupt ladder with an attempt-level timeout; record `invocation_state: unknown` if the group never exits after SIGKILL | SK-306 | SK-504 |
| F19 | On restart, send SIGKILL to the recorded process group (ESRCH ignored) before declaring an attempt dead; journal start tokens verbatim and treat `""` as "not adoptable, kill the group" | SK-306 | SK-505 |
| F20 | `skep status`: print `statusView` via `canonicalJson`; label `fetchedAtMonoMs` as "checked" (it includes unchanged `ls-remote` checks); render the 3–5 min liveness gap distinctly (a `late` label; architect decision with SK-604) | SK-204, SK-302, SK-303 | SK-604 |
| F21 | Relay: enforce the topic format `^[a-z2-7]{26}$`, reuse `HintSchema` on both ends, `TextEncoder` instead of `Buffer` for sizes in the worker | SK-308 | SK-701 |

---

## Wave 4 / early Wave 5 follow-ups

Collected from the Wave 4 / early Wave 5 reviews (`docs/reviews/SK-40x.md`, `SK-50x.md`). Each
item is owned by the named future task; a task's brief inherits the items listed for it.
Wave 2b/3 follow-ups closed in this phase: F1–F6 (SK-405), F7–F10 (SK-406), F15 (SK-403
`claimCandidates`), F16 (SK-403 suspend listener hook; the daemon wiring remains SK-601).

| # | Item | Source | Owner |
|---|---|---|---|
| G1 | Run the full sim sweep `SKEP_SIM_SEEDS=50 npx vitest run test/integration/sim` before release, and in any CI job; `npm test` keeps the 3-seed default | SK-404 | SK-610 |
| G2 | Document the MVP limitation "moving an item to another agent requires a revoke plus a human-approved replan (no reassign event; claims require the plan assignee)" | SK-404 | SK-608 (runbook), SK-610 (release notes) |
| G3 | Replace the scenarios' `ScriptedCode` with SK-503's `FakeCodeHost` (plus a `pullRequests()` listing for invariant 5); optionally move shared helpers out of `claim-race.ts` into `scenarios/common.ts` | SK-404 | SK-505 |
| G4 | `skep sim run` outside a source checkout: the fixture keys resolve under `test/`; ship the sim fixtures in the package or fail with an actionable message | SK-401, SK-402 | SK-610 |
| G5 | Machine envelope consistency: a failed sim run prints `{"ok":true,"result":{"ok":false…}}` with exit 1; add an `Output` path that prints top-level `ok:false` with the result. Also include `seed` and `scenario` in the `skep sim run` machine result | SK-402 | SK-603 / SK-604 |
| G6 | Redactor hardening: cap `RedactionStream` buffering for newline-free output (redact and release beyond ~1 MiB, holding a tail); add bearer-token, JWT, Slack-token and URL-embedded-credential patterns | SK-506 | SK-504 |
| G7 | Wire the redactor everywhere: journal, adapter log capture (streams), published or prompted check-log excerpts (raw logs stay local for evidence digests), PR and commit text; run `findSecrets` + gitleaks before every publication | SK-502, SK-506 | SK-504 |
| G8 | Code-host hardening before use: reject a leading `-` in repo and ref names and pass `--flag=value`; read branch tips via `gh api …/git/ref/heads/<branch>` instead of HTTPS `ls-remote` (one auth path, no prompt; `GIT_TERMINAL_PROMPT=0` for any git call); enforce one PR per head in any state | SK-503 | SK-504 |
| G9 | Record the `PrInfo` shape (`number, url, head, base, title, state, mergeSha`) in ARCHITECTURE §11.5 | SK-503 | architect (with SK-504) |
| G10 | Reconcile PRs via the journaled PR number and `prState` before falling back to `findPr` (which only sees open PRs) | SK-503 | SK-505 |
| G11 | Document `GH_TOKEN` for headless `gh` (passed explicitly; the daemon's own code-host credential, not a provider credential, D19) and the conservative check-env denylist (`*_KEY` etc. are stripped) | SK-503, SK-502 | SK-608 |
| G12 | `resolveAgentUser`: call `/usr/bin/id` by absolute path; the daemon passes an agent-specific `PATH` (from config) to `agentEnv`, not its own | SK-501 | SK-601 |
| G13 | Agents cannot run git in their worktree (daemon-owned `.git`): state it in the work prompt, and give fix-ups a read-only diff | SK-501 | SK-504 |
| G14 | `ChecksRunner.load` and `scanSecrets` need the base commit in the mirror: fetch first (both now fail with "fetch first") | SK-502 | SK-504 |
| G15 | `SuspendDetector`: isolate listener exceptions; implement the stale-lease loop (stale ⇒ journal `stale` ⇒ drop from `setHeldLeases` ⇒ re-verify) | SK-403 | SK-601 (loop also SK-504) |
| G16 | Reducer `RangeError` on an impossible state ⇒ daemon enters read-only mode with an alarm (like a reducer-version mismatch), no crash loop; poll `LivenessTracker.alarms()` and route to status/ntfy | SK-406 | SK-601 |
| G17 | Cap `extractJson`'s stray-brace fallback (O(n²) parse attempts on large malformed output) with a timing test; move the misplaced D14/D15 doc comment in `golden-scenarios.ts` | SK-405 | SK-504 |
| G18 | Suppress the pre-existing gitleaks false positive in `src/git/trust.test.ts` (dummy `ssh-ed25519` body) so a full-history `gitleaks git` scan is clean | SK-502 fix round | SK-610 (or any earlier small fix) |
| G19 | Optional cleanups: split `SimScheduler` out of `src/sim/world.ts`; per-scenario expectation hooks instead of one `switch` in `protocol.test.ts`; cap the per-agent superseded-boot set in `LivenessTracker` | SK-401, SK-404, SK-406 | SK-505 |

Still open from Wave 2b/3: F11–F14, F17–F20 (SK-504/SK-505/SK-601/SK-604) and F21 (SK-701).

---

## Critical path

`SK-101 → SK-201/202 → SK-304 → SK-401 → SK-404` (protocol safety, must never be cut) and
`SK-102 → SK-203 → SK-301/302 → SK-401`. Execution (Wave 5) can start as soon as SK-205/206/307
land. Cut order if late (PRD §16.4): team-mode review in SK-601, `task.verified` + retarget in
SK-606. Never cut: harness, reducer invariants, signing, epoch fencing. Wave 7 (D18) is MVP+ and can
slip entirely without affecting MVP acceptance.
