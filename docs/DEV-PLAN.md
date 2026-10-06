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
| SK-201 | Reducer: lease & delivery handlers | SK-101 | codex | `src/core/reducer/handlers/{lease,work,merge}.ts` (+ tests) | lease.claimed/released/revoked, work.delivered/failed, item.merged, task.verified per ARCHITECTURE §5.5: epoch increments, `fenced`/`epoch_mismatch`/`max_parallel`/`retry_budget`/`bad_branch` rejections, dependents unblocked, task → delivered → done; stale-holder delivery after revoke is rejected | todo |
| SK-202 | Reducer: replan, barrier, checkpoint handlers | SK-101 | codex | `src/core/reducer/handlers/replan.ts` (+ tests) | replan.requested opens barrier `B<seq>`, flags leases, blocks claims; coalescing in interrupting/replanning; checkpoints settle barrier ⇒ replanning; barrier.closed ⇒ missing items unknown; 3rd request with budget 2 ⇒ escalated; daemon request without evidence ⇒ `missing_evidence` | todo |
| SK-203 | Git log reader → `LogEntry[]` (incremental) | SK-102 | codex | `src/git/log-reader.ts` (+ tests) | `readLog(git, dir, trustPath, {fromSha?})` walks `rev-list --first-parent --reverse main`; parents, name-status, added-file contents (size-capped, UTF-8 checked), signatures in one `git log` pass; merge commits/multi-file/oversized files represented faithfully; reducer replay over a real repo equals replay over equivalent builder log | todo |
| SK-204 | Reducer views + `statusView` | SK-101 | pi | `src/core/reducer/views.ts` (+ tests) | `claimableItems`, `leasesHeldBy`, `isOwner`, `pendingReviews`, `barrierStatus`, `statusView` (stable JSON, sorted keys) with unit tests over builder logs | todo |
| SK-205 | exec/fs utilities + run journal | SK-001 | pi | `src/util/{exec,fs}.ts`, `src/exec/journal.ts` (+ tests) | `execFileChecked` (shell:false, timeout, maxBuffer, env passthrough), `atomicWrite`, `appendFsync`, `safeJoin` (rejects `..`/absolute/symlink escape); journal append/read/`unfinishedAttempts()` with fsync; torn last line tolerated | todo |
| SK-206 | Config loaders: device.toml, AGENT.md, checks.toml parsing | SK-104 | pi | `src/config/{device,agent-md}.ts`, `src/exec/checks-file.ts` (+ tests, fixtures under `test/fixtures/config/`) | Parse + validate with the scaffold schemas; helpful error messages with file/line; AGENT.md body extracted; repo allowlist lookup by name/url | todo |
| SK-207 | Adapter spike: pinned Codex CLI | SK-001 | codex | `docs/spikes/adapter-codex.md`, `src/adapter/codex.ts` (+ opt-in test `test/integration/adapter-codex.test.ts`) | Report: exact flags for non-interactive run, output schema, last-message file, JSON events, interrupt behaviour (SIGINT), approval policy, usage fields, version string; `CodexAdapter` implements `AgentAdapter`; decision Codex vs Claude fallback recorded | todo |

## Wave 3 — write path, sync, heartbeats, runtime

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-301 | Blackboard clone + publisher write loop + genesis bootstrap | SK-101, SK-102, SK-203, SK-103 | codex | `src/blackboard/{clone,publisher,genesis}.ts`, `src/core/intents.ts` (types + draft helper) (+ integration tests) | fetch→reset→recompute→push, never rebase; stable event_id; ambiguous push resolved via `seen_event_ids`; dropped intents; 8 concurrent publishers on one bare remote all land exactly once with linear history; genesis created human-signed | todo |
| SK-302 | Sync poller + state cache | SK-101, SK-203 | codex | `src/blackboard/sync.ts` (+ tests) | Fetch main + hb/*; incremental replay from cached tip == full replay; `observeNow()`; jittered adaptive interval via Clock; freshness metadata | todo |
| SK-303 | Heartbeat writer/reader + liveness tracker | SK-102, SK-103 | codex | `src/blackboard/{heartbeat,liveness}.ts` (+ tests) | Orphan signed commit per beat, `--force-with-lease`; reader verifies principal matches agent device; `main` untouched; liveness live/stale/lost/unknown on observer monotonic clock; suspend reset; duplicate boot_id alarm | todo |
| SK-304 | Reducer invariants + property tests | SK-201, SK-202 | pi | `src/core/reducer/invariants.ts`, `src/core/reducer/replay.property.test.ts`, `test/helpers/random-log.ts` | Seeded random log generator (valid + forged entries); 1,000 logs: full == incremental, invariants 2–4, 6 hold, forged entries are no-ops | todo |
| SK-305 | Golden replay fixtures | SK-201, SK-202 | pi | `test/fixtures/golden/*.json`, `test/integration/golden.test.ts`, `scripts/golden-update.ts` | ≥ 5 golden logs (solo, team, replan, escalate, forged) with expected state hashes; update script documented | todo |
| SK-306 | Native runtime backend + interrupt ladder | SK-205 | codex | `src/runtime/native.ts`, `src/exec/interrupt.ts` (+ tests) | Detached spawn, pgid, start token (Linux /proc, macOS ps), group signals, `isAlive` guards PID reuse; ladder SIGINT→grace→SIGTERM→SIGKILL with injected Clock; tests kill a child tree | todo |
| SK-307 | Structured output runner, prompts, fake adapter | SK-001 | codex | `src/adapter/{structured,prompts,fake}.ts` (+ tests) | JSON extraction (fenced/unfenced), Zod validation, exactly one repair; prompt builders for plan/review/work/fixup; fake adapter scripts (success, invalidJson, wrongEvidence, hang, slow, permissionPrompt, replanRequest, crash) | todo |

## Wave 4 — simulation harness and lease safety

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-401 | Sim world, scheduler, faulty git, invariant checker, `empty` scenario | SK-301, SK-302, SK-303, SK-304 | codex | `src/sim/{world,faulty-git,invariants,runner}.ts`, `src/sim/scenarios/empty.ts`, `test/integration/sim/empty.test.ts` | 2 sim daemons on local bare repos with fixed test keys; seeded interleavings reproducible (same seed ⇒ same final tip sha); invariants checked every step | todo |
| SK-402 | Test keys + `skep sim run` command | SK-401, SK-104 | pi | `test/fixtures/keys/*`, `.gitleaks.toml`, `src/cli/commands/sim.ts` | Test-only keys committed + allowlisted; `skep sim run --seed 42 --scenario empty` prints result JSON with `--machine` | todo |
| SK-403 | Lease intents, reverify, suspend detection | SK-201, SK-302 | codex | `src/core/intents.ts` (claim/release/revoke/deliver/fail/checkpoint builders), `src/lease/{reverify,suspend}.ts` (+ tests) | Intents return null when no longer valid; reverify does a fresh observation; suspend gap marks leases unverified | todo |
| SK-404 | Protocol scenarios | SK-401, SK-403 | codex | `src/sim/scenarios/{claim-race,lost-ack,fetch-flaky,forged-commits,sleep-wake-revoke,duplicate-boot,clock-skew}.ts` + tests | Each scenario passes for 50 seeds; sleep-wake-revoke: stale holder never delivers, new holder delivers once | todo |

## Wave 5 — execution core

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-501 | Code mirror, worktrees, sanitized agent env | SK-205, SK-206 | codex | `src/exec/{worktree,sandbox-env}.ts` (+ tests) | Mirror per allowlisted repo; worktree from base or predecessor SHA; env strips GIT_*, SSH_AUTH_SOCK, GH_TOKEN, credential helpers; optional uid/gid | todo |
| SK-502 | Trusted checks runner, evidence verifier, secret scan | SK-501 | codex | `src/exec/{checks,evidence,secret-scan}.ts` (+ tests) | Checks only from `base_commit`; CheckRun + journal; file_span/command_run/check_run verification; gitleaks wrapper (skip with warning if absent in tests) | todo |
| SK-503 | Code host interface, fake host, gh host | SK-205 | pi | `src/codehost/{types,fake,gh}.ts` (+ tests) | Interface per ARCHITECTURE §11.5; fake enforces one PR per head; gh implementation via `gh` JSON output (unit-tested with a stub runner) | todo |
| SK-504 | Attempt pipeline + mechanical snapshot | SK-306, SK-307, SK-403, SK-502, SK-503 | codex | `src/exec/{attempt,snapshot}.ts` (+ tests) | Journaled steps per ARCHITECTURE §9.7; one fix-up; code first then record; reverify before PR and before `work.delivered`; snapshot from verifiable facts | todo |
| SK-505 | Restart reconciliation + crash scenario | SK-504, SK-401 | codex | `src/exec/reconcile.ts`, `src/sim/scenarios/crash-every-step.ts` (+ tests) | Crash at every journal step ⇒ no duplicate events, executions or PRs | todo |

## Wave 6 — daemon, flows, CLI

| ID | Title | Depends on | Assignee | Files/area | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| SK-601 | Daemon tick loop, slots, duties, plan validator | SK-504, SK-302, SK-303 | codex | `src/daemon/{daemon,slots,duties,lock}.ts`, `src/exec/plan-validator.ts`, `src/bin/skepd.ts` | Owner plans, reviewer reviews, assignee claims & executes; single-daemon lock; scenarios `solo-happy`, `team-stacked` pass | todo |
| SK-602 | IPC protocol, server, client with sign callback | SK-301 | pi | `src/ipc/{protocol,client}.ts`, `src/daemon/ipc-server.ts` (+ tests) | NDJSON frames per ARCHITECTURE §12; sign_request/sign_result round trip; version mismatch error; socket perms 0600 | todo |
| SK-603 | CLI write commands (task, plan, lease, decide, replan, cancel) | SK-602, SK-403 | pi | `src/cli/commands/{task,plan,lease,decide,replan}.ts` | Each command builds the intent, publishes via daemon or in-process fallback, prints accepted/rejected with `#seq`; language guard on `task new` | todo |
| SK-604 | `skep status`, `skep log`, `skep plan show` rendering | SK-204, SK-602 | pi | `src/cli/commands/{status,log}.ts`, `src/cli/render-status.ts` | Matches PRD §15.1 layout; `--machine` stable JSON; revoke suggestions for stale holders | todo |
| SK-605 | Coarse replan flow in the daemon | SK-601 | codex | `src/daemon/replan.ts`, scenarios `replan-once`, `replan-escalate`, `missing-checkpoint` | Interrupt ladder → snapshot → WIP push → checkpoint; barrier deadline ⇒ barrier.closed; third replan escalates | todo |
| SK-606 | Stacked delivery, task.verified, merge observation & retarget | SK-601 | codex | `src/daemon/delivery.ts` (+ scenario test) | W2 starts from W1 delivered SHA, PR base = W1 branch; top-of-stack verification; merged PRs ⇒ item.merged, next PR retargeted | todo |
| SK-607 | `skep init`, `skep doctor`, ntfy notifier | SK-301, SK-206 | pi | `src/cli/commands/{init,doctor}.ts`, `src/notify/ntfy.ts` | init writes device.toml, generates daemon key, prints allowed_signers line, optional genesis; doctor runs PRD §13.3 pre-flight + full replay + invariants | todo |
| SK-608 | Service units + runbook | SK-601 | pi | `deploy/{skepd.service,com.skepagent.skepd.plist}`, `docs/RUNBOOK.md` | Setup, key rotation, revoke, re-genesis procedures documented | todo |
| SK-609 | Real two-device run & metrics | all | codex | `docs/MVP-RUN-REPORT.md` | PRD §16.5 acceptance criteria verified or gaps documented | todo |

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

---

## Critical path

`SK-101 → SK-201/202 → SK-304 → SK-401 → SK-404` (protocol safety, must never be cut) and
`SK-102 → SK-203 → SK-301/302 → SK-401`. Execution (Wave 5) can start as soon as SK-205/206/307
land. Cut order if late (PRD §16.4): team-mode review in SK-601, `task.verified` + retarget in
SK-606. Never cut: harness, reducer invariants, signing, epoch fencing.
