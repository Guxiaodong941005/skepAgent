# Skep — MVP Architecture

> Status: v1 (architect), 2026-10-06. Normative source: `docs/PRD-v0.4.md` (the PRD). This
> document turns the PRD into concrete module boundaries, data shapes and algorithms. Where it
> makes a decision the PRD leaves open, it says so in a **Decision** note. Section references like
> "PRD §9.5" point into the PRD.
>
> Naming: CLI `skep`, per-device daemon `skepd`, coordination repo = "blackboard".

Contents

1. [Language and runtime](#1-language-and-runtime)
2. [Module layout](#2-module-layout)
3. [Process topology](#3-process-topology)
4. [Event schema](#4-event-schema)
5. [Deterministic reducer](#5-deterministic-reducer)
6. [Lease protocol](#6-lease-protocol)
7. [Git write path and signing](#7-git-write-path-and-signing)
8. [Heartbeats and liveness](#8-heartbeats-and-liveness)
9. [Agent adapters, work reports and checks](#9-agent-adapters-work-reports-and-checks)
10. [Runtime backends and herdr](#10-runtime-backends-and-herdr)
11. [Daemon internals](#11-daemon-internals)
12. [CLI ↔ daemon socket protocol](#12-cli--daemon-socket-protocol)
13. [Simulation harness](#13-simulation-harness)
14. [Testing strategy](#14-testing-strategy)
15. [Decisions and deviations log](#15-decisions-and-deviations-log)
16. [Provider config sync (D17)](#16-provider-config-sync-d17)
17. [Transport and discovery without a mesh VPN (D18)](#17-transport-and-discovery-without-a-mesh-vpn-d18)

---

## 1. Language and runtime

**TypeScript (strict) on Node.js 22 LTS, ESM, npm.**

| Concern | Why TypeScript/Node fits |
|---|---|
| PRD alignment | PRD §16.2 already names TypeScript/Node, Commander, Zod, Vitest; the reducer pseudo-code (PRD §10.1) is TS. |
| Schemas | One Zod definition per protocol object gives runtime validation (daemon), static types (all code) and JSON Schema (`z.toJSONSchema`) for adapters' structured-output flags. Go would need three parallel definitions or codegen. |
| Process groups | `child_process.spawn(..., { detached: true })` creates a new process group on Linux and macOS without `setsid` (PRD §13.2). |
| Git | System `git`/`ssh-keygen` via `execFile` (`shell: false`); no libgit2 binding needed. |
| Availability | Node 22 + npm are installed on both target devices and here; Go is not installed. |
| Implementers | The coding agents (Codex, pi) are strongest in TS; Vitest gives fast, parallel feedback in worktrees. |

Trade-off accepted: a Node runtime dependency on each device (vs. a static Go binary). Mitigation:
`npm run build` emits plain ESM to `dist/`; packaging as a single-file bundle is a V1 concern.

Toolchain (pinned in `package.json`):

| Tool | Use |
|---|---|
| `typescript` 5.9 | `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `NodeNext` modules. Relative imports use the `.js` suffix. |
| `zod` 4 | All protocol and config schemas (`src/core/schemas`). Every object is `z.strictObject` (unknown keys rejected, PRD §8.4). |
| `commander` 15 | CLI. |
| `smol-toml`, `yaml` | `device.toml`, `.skep/checks.toml`; AGENT.md front-matter. |
| `vitest` 5 | Unit, integration, property and simulation tests. |
| `@biomejs/biome` 2 | Lint + format (single tool, zero plugins). |
| `tsx` | Run TS entry points in development (`npm run skep -- status`). |

External binaries used at runtime (never installed by Skep): `git` ≥ 2.34 (SSH signing),
`ssh-keygen` (OpenSSH ≥ 8.9 for `-Y sign/verify` with agent keys), `gh`, `gitleaks`, the pinned
agent CLI (`codex` in the MVP), optionally `herdr`.

---

## 2. Module layout

Rule of thumb: **`src/core` is pure** (no I/O, no clock, no randomness, no `process`), everything
else is an adapter around I/O that takes its dependencies (git runner, clock, random source,
runtime backend, code host) as constructor parameters so the simulation harness can substitute
them.

```text
skep/
├── package.json · tsconfig.json · tsconfig.build.json · biome.json · vitest.config.ts
├── AGENTS.md  (CLAUDE.md → AGENTS.md)       conventions for coding agents
├── docs/      PRD-v0.4.md · ARCHITECTURE.md · DEV-PLAN.md
├── src/
│   ├── bin/
│   │   ├── skep.ts              CLI entry (thin: builds the Commander program, runs it)
│   │   └── skepd.ts             daemon entry (thin: loads config, starts Daemon)
│   ├── core/                    PURE. Shared by daemon, CLI, sim. No I/O.
│   │   ├── ids.ts               ID formats/regexes, branch + event path helpers        [scaffold]
│   │   ├── canonical.ts         canonical JSON, sha256, contentHash (plan_hash)         [scaffold]
│   │   ├── principal.ts         signer principals (`human`, `daemon:<device>`)          [scaffold]
│   │   ├── log.ts               LogEntry: git layer → reducer contract                  [scaffold]
│   │   ├── schemas/             Zod schemas = the protocol freeze                       [scaffold]
│   │   │   ├── common.ts        primitives, CheckRun, Budgets, size limits
│   │   │   ├── events.ts        envelope, every event payload, REQUIRED_PRE, parseEvent*
│   │   │   ├── evidence.ts      file_span | command_run | check_run
│   │   │   ├── plan.ts          skep.plan/v1 (+ linear-stack refinement)
│   │   │   ├── review.ts        skep.review/v1
│   │   │   ├── work-report.ts   skep.work_report/v1, Usage
│   │   │   ├── snapshot.ts      skep.snapshot/v1
│   │   │   ├── heartbeat.ts     skep.hb/v1
│   │   │   ├── genesis.ts       skep.genesis/v1 (skep.json)
│   │   │   └── config.ts        device.toml, AGENT.md front-matter, .skep/checks.toml
│   │   ├── reducer/
│   │   │   ├── state.ts         State/TaskState/ItemState/Lease/Barrier types        [scaffold]
│   │   │   ├── genesis.ts       initial State from the seq-0 entry
│   │   │   ├── structural.ts    PRD §8.2 rules 1–4 + parse ⇒ InvalidReason | event
│   │   │   ├── authz.ts         PRD §11.3 matrix
│   │   │   ├── preconditions.ts generic `pre` checks
│   │   │   ├── apply.ts         dispatch table EventType → handler
│   │   │   ├── handlers/        one file per event family (task, plan, lease, work, replan, merge)
│   │   │   ├── replay.ts        replay(entries) / applyEntry(state, entry)
│   │   │   ├── views.ts         read helpers (eligible claims, holders, stale suggestions)
│   │   │   └── invariants.ts    pure invariant predicates over (entries, state)
│   │   └── intents.ts           Intent type + pure intent builders (State → event draft | null)
│   ├── util/
│   │   ├── clock.ts             Clock interface + systemClock                           [scaffold]
│   │   ├── random.ts            RandomSource + id generators                            [scaffold]
│   │   ├── exec.ts              execFile wrapper (shell:false, timeouts, max buffer)
│   │   ├── fs.ts                atomic write, fsync'd append, safe path join
│   │   └── backoff.ts           jittered exponential backoff
│   ├── git/
│   │   ├── runner.ts            GitRunner interface + NodeGitRunner (execFile git)
│   │   ├── trust.ts             allowed_signers parser, TrustRoot
│   │   ├── signer.ts            Signer interface; SshKeySigner (key file / ssh-agent)
│   │   ├── commit.ts            plumbing commit builder (tree, signed commit object)
│   │   ├── verify.ts            commit signature → SignatureCheck (local trust root only)
│   │   └── log-reader.ts        first-parent walk of main → LogEntry[] (incremental)
│   ├── blackboard/
│   │   ├── clone.ts             private clone management (init, fetch refspecs, reset)
│   │   ├── publisher.ts         write loop + per-device serialized queue (§7)
│   │   ├── sync.ts              poller: fetch main + hb/*, incremental replay, state cache
│   │   ├── heartbeat.ts         hb/<agent> writer + reader (§8)
│   │   ├── liveness.ts          observer-relative TTL tracker (§8.2)
│   │   └── genesis.ts           `skep init` blackboard bootstrap (human-signed skep.json)
│   ├── lease/
│   │   ├── reverify.ts          mandatory re-verification before delivery (§6.3)
│   │   └── suspend.ts           suspend-gap detector (wall vs monotonic)
│   ├── exec/                    work-item execution on a device
│   │   ├── worktree.ts          code repo mirror + per-attempt worktrees
│   │   ├── sandbox-env.ts       sanitized agent environment, agent-user spawn options
│   │   ├── checks.ts            load trusted checks at base_commit, run them, CheckRun
│   │   ├── journal.ts           append-only fsync'd JSONL run journal
│   │   ├── evidence.ts          evidence verifier (file_span, command_run, check_run)
│   │   ├── secret-scan.ts       gitleaks wrapper
│   │   ├── snapshot.ts          mechanical snapshot builder
│   │   ├── interrupt.ts         interrupt ladder (SIGINT → grace → SIGTERM → SIGKILL)
│   │   ├── attempt.ts           attempt state machine: invoke → commit → check → fix-up → push → PR → deliver
│   │   └── reconcile.ts         restart reconciliation from journal (§11.4)
│   ├── adapter/
│   │   ├── types.ts             AgentAdapter interface                                  [scaffold]
│   │   ├── structured.ts        run → extract JSON → validate → one repair
│   │   ├── prompts.ts           prompt builders (plan, review, work, fix-up, repair)
│   │   ├── codex.ts             MVP adapter (`codex exec`)
│   │   ├── claude.ts            fallback adapter (`claude -p`)  — only if the spike fails
│   │   └── fake.ts              scripted adapter for tests/sim
│   ├── runtime/
│   │   ├── types.ts             RuntimeBackend / ProcessHandle                          [scaffold]
│   │   ├── native.ts            detached spawn, process-group signals, start-token
│   │   └── herdr.ts             V1 backend (stubbed; MVP exposes hooks only)
│   ├── codehost/
│   │   ├── types.ts             CodeHost interface (branches, PRs, merges)
│   │   ├── gh.ts                GitHub via `gh`
│   │   └── fake.ts              in-memory PR registry over a local bare repo (sim)
│   ├── daemon/
│   │   ├── daemon.ts            Daemon: tick loop, wiring
│   │   ├── slots.ts             slot registry (role dir + AGENT.md + adapter binding)
│   │   ├── duties.ts            per-tick decisions: owner/reviewer/claimer/executor duties
│   │   ├── lock.ts              single-daemon-per-device lock file
│   │   └── ipc-server.ts        local socket server
│   ├── ipc/
│   │   ├── protocol.ts          Zod schemas for socket messages
│   │   └── client.ts            CLI-side client (with sign-callback support)
│   ├── cli/
│   │   ├── program.ts           Commander program: all MVP commands
│   │   ├── output.ts            human tables vs `--machine` JSON
│   │   ├── commands/            one file per command group (task, plan, lease, status, ...)
│   │   └── render-status.ts     status view model → text
│   ├── config/
│   │   ├── paths.ts             SKEP_HOME resolution (~/.skep), well-known file paths
│   │   ├── device.ts            load/validate device.toml
│   │   └── agent-md.ts          parse AGENT.md (front-matter + body)
│   ├── notify/
│   │   └── ntfy.ts              human notifications
│   ├── transport/               D18 (§17): hint channels + mailboxes; never authoritative
│   │   ├── types.ts             Hint (Zod), HintChannel, Mailbox
│   │   ├── null-hint.ts         default no-op hint channel
│   │   ├── git-mailbox.ts       refs/heads/mbx/<agent> mailbox on the blackboard remote
│   │   └── relay.ts             V1: outbound WebSocket relay client (hints + mailbox)
│   ├── secrets/                 D17 (§16): provider config sync
│   │   ├── redact.ts            Redactor (journal, logs, IPC, notifications)
│   │   ├── device-key.ts        per-device age X25519 identity, rotation
│   │   ├── bundle.ts            skep.secret_bundle/v1 seal / verify / open
│   │   ├── ccswitch.ts          read-only import of one provider entry (controller)
│   │   └── store.ts             at-rest ciphertext store + per-invocation env hand-off
│   └── sim/
│       ├── rng.ts               seeded PRNG (+ RandomSource adapter)
│       ├── fake-clock.ts        per-daemon virtual clock (skew, suspend)
│       ├── faulty-git.ts        GitRunner wrapper with fault injection
│       ├── world.ts             SimWorld: bare remotes, keys, daemons, scheduler
│       ├── invariants.ts        cross-daemon invariant checks (uses core/reducer/invariants)
│       ├── runner.ts            seeded scenario runner (`skep sim run`)
│       └── scenarios/           one file per scenario
└── test/
    ├── helpers/                 log-builder (pure log fixtures) [scaffold], git tmp repos, keys
    ├── fixtures/                test-only SSH keys, golden logs
    └── integration/             cross-module tests (git + publisher + reducer, sim scenarios)
relay/                           V1 (D18): serverless WebSocket relay (worker + per-topic object), own deploy config
```

`[scaffold]` = present in the initial commit. Unit tests are colocated (`foo.ts` ↔ `foo.test.ts`);
cross-module tests live in `test/integration`. Each DEV-PLAN task owns a disjoint set of files.

Dependency direction (enforced by review, not tooling, in the MVP):

```text
core  ←  util  ←  git  ←  blackboard  ←  lease/exec/adapter/runtime/codehost  ←  daemon  ←  cli/bin
                                                                     sim (may import anything)
```

`core` imports only `zod` and `node:crypto` (hashing).

---

## 3. Process topology

```text
             ┌──────────────── device (mac | vps) ────────────────┐
human ──►  skep CLI ──unix socket──►  skepd  (one per device, launchd/systemd)
 (key in                         │   ├─ Sync (fetch main + hb/*)  ─► Reducer ─► State cache
  ssh-agent,                     │   ├─ Publisher queue (single writer) ─► blackboard remote
  Mac only)                      │   ├─ Heartbeat writer (hb/<agent>)
                                 │   ├─ Slots (1 in MVP): duties → intents / attempts
                                 │   │     └─ Attempt runner ─► Adapter ─► Runtime (agent user)
                                 │   ├─ Journal (.skep/journal/*.jsonl)
                                 │   └─ CodeHost (gh) ─► code remote (branches, PRs)
             └──────────────────────────────────────────────────────────┘
```

* One `skepd` per device holds a lock file (`$SKEP_HOME/skepd.lock`, `flock`-style via exclusive
  create + pid/start-token) and a random `boot_id`.
* Only `skepd` writes git (blackboard and code). The CLI never pushes when the daemon is
  running; when it is not, the CLI runs the same `Publisher` in-process against its own private
  clone (`$SKEP_HOME/cli-blackboard`). Correctness never depends on single-writer-ness — the
  write loop handles races — it only reduces contention.
* `SKEP_HOME` defaults to `~/.skep`; tests and the simulator point it at temp dirs.
* **Outbound-only networking (D18, §17).** Devices never connect to each other. Each `skepd` talks
  only to the git remotes, the code host, provider APIs and, optionally, one relay WebSocket for
  hints. No mesh VPN, inbound port or fixed IP is required (this replaces the PRD §6.1 Tailscale
  edge between devices).

---

## 4. Event schema

Source of truth: `src/core/schemas/events.ts` (+ the files it imports).

### 4.1 Envelope `skep.event/v1`

| Field | Type | Rule |
|---|---|---|
| `schema` | `"skep.event/v1"` | literal |
| `event_id` | `evt_<uuid v4>` | generated once per intent; stable across write-loop retries |
| `type` | one of §4.3 | discriminator |
| `task_id` | `T-yyyymmdd-xxxx` \| `null` | `null` iff `type == agent.registered` (D17 extends this to the registry events `device.key_published`, `provider.*`, §16.6) |
| `actor` | `"human"` \| agent ID | must be bound to the commit's signer (§5.4) |
| `observed_tip` | git sha | must equal the commit's parent |
| `pre` | object | preconditions (§4.2) |
| `created_at` | ISO-8601 UTC | display only |
| `lang` | `"en"` | literal (PRD §14) |
| `payload` | per type | strict |

File location: `events/<task_id or _skep>/<event_id>.json`; the path's IDs must match the
envelope. Serialization: `JSON.stringify(event, null, 2) + "\n"`. Limit: 64 KiB.

### 4.2 Preconditions (`pre`)

All keys optional in the schema; `REQUIRED_PRE[type]` lists the keys a type must carry; the
parser rejects events missing them. The reducer compares **every present key** with state:

| Key | Compared with | Reject reason |
|---|---|---|
| `task_rev` | `task.rev` (accepted events for the task so far) | `pre_mismatch` |
| `owner_gen` | `task.owner_gen` | `pre_mismatch` |
| `plan_version` | `task.current_plan_version` | `plan_changed` |
| `plan_hash` | `plans[current_plan_version].plan_hash` | `plan_changed` |
| `item` | key exists in `task.items` | `unknown_item` |
| `expected_epoch` | `task.epochs[item] ?? 0` | `epoch_mismatch` |

Because `observed_tip == parent` is enforced first, a correctly computed event always satisfies
its preconditions; `pre` makes each event self-describing for audit (G6) and is defence in depth
against buggy or forged-but-signed writers.

### 4.3 Event types and payloads

| Type | Actor | REQUIRED_PRE | Payload (see schema for limits) |
|---|---|---|---|
| `agent.registered` | agent (own device) | – | role, agent_cli, cli_version, capabilities[], requires_local[], max_parallel_items |
| `task.created` | human | – | title, body, repo, base_branch, mode, owner, budgets, plan_approval, original_text?, original_lang? |
| `task.cancelled` | human | task_rev | reason |
| `owner.transferred` | human | task_rev, owner_gen | new_owner |
| `plan.proposed` | owner | task_rev, owner_gen | version, parent_version, plan (`skep.plan/v1`), plan_hash, base_commit, reviewers[] |
| `review.submitted` | reviewer \| human | task_rev, plan_version, plan_hash | plan_version, plan_hash, verdict, blockers[] (typed evidence), suggestions[] |
| `plan.locked` | owner | task_rev, owner_gen, plan_version, plan_hash | plan_version, plan_hash, overrides[{reviewer, blocker_id, rationale}], missing_reviews[] |
| `plan.approved` / `plan.rejected` | human | task_rev, plan_version, plan_hash | plan_version, plan_hash, note? |
| `lease.claimed` | assignee | task_rev, plan_version, plan_hash, item, expected_epoch | item, attempt_id, branch |
| `lease.released` | holder | task_rev, item | item, epoch, reason |
| `lease.revoked` | human (MVP) | task_rev, item | item, epoch, reason, observed_hb |
| `checkpoint.recorded` | holder | task_rev, item | item, epoch, barrier_id, snapshot (`skep.snapshot/v1`) |
| `work.delivered` | holder | task_rev, item | item, epoch, branch, head_sha, pr_url, pr_number, check_runs[] |
| `work.failed` | holder | task_rev, item | item, epoch, class, detail |
| `replan.requested` | holder \| owner \| human | task_rev | summary, evidence[], item |
| `barrier.closed` | owner \| human | task_rev | barrier_id, missing[] |
| `item.merged` | any daemon \| human | task_rev, item | item, pr_number, merge_sha |
| `task.verified` | owner | task_rev, owner_gen, plan_hash | top_of_stack_sha, check_runs[], passed (`false` ⇒ escalate, D14) |
| `human.decided` | human | task_rev | decision, note?, new_owner? |
| `device.key_published` *(planned, D17)* | agent on the device | – | device, key_id, alg, recipient, retires |
| `provider.bound` / `provider.revoked` *(planned, D17)* | human | – | agent, version, bundle_id, recipient_key_id, ciphertext_sha256, provider_name, transport / agent, version, reason |
| `provider.applied` *(planned, D17)* | target agent | – | version, bundle_id, ciphertext_sha256 |

`work.failed.class` ∈ `invalid_output | checks_failed | timeout | permission_prompt | crash |
preflight | secret_detected | budget_exceeded`.

Model-facing documents (not events, but embedded in or feeding events): `skep.plan/v1`,
`skep.review/v1`, `skep.work_report/v1`, `skep.snapshot/v1`; heartbeat `skep.hb/v1`; genesis
`skep.genesis/v1`.

### 4.4 Versioning

* Every document carries a `schema: "skep.<kind>/v<N>"` literal. A breaking change creates
  `v<N+1>` alongside `vN`; the reducer accepts both for as long as the log contains `vN`.
* The blackboard's `skep.json` pins `protocol_version` and `reducer_version`. A daemon refuses to
  act (read-only mode + alarm) if it does not implement the pinned reducer version.
* Bumping `REDUCER_VERSION` is only allowed together with golden replay tests showing the new
  reducer produces the identical state for every existing golden log (PRD §10.1). Changing the
  pinned reducer version of a live blackboard is a human-signed re-genesis (out of MVP scope).

### 4.5 Validation pipeline

1. **Writer side (daemon/CLI):** build the event from typed inputs → `parseEvent()` (must pass) →
   `serializeEvent()` → size check. Model output is validated with the model-facing schema first
   (one repair attempt, §9.3) and evidence is verified (§9.5) before anything is turned into an
   event.
2. **Reader side (reducer):** `parseEventFile()` on the exact bytes of the committed file. Parse
   failure ⇒ the commit is `invalid` (`schema_invalid`), a no-op that raises an alarm.

---

## 5. Deterministic reducer

### 5.1 Contract

```ts
// src/core/reducer/replay.ts
export function genesisState(entry: LogEntry): State;             // throws GenesisError if invalid
export function applyEntry(state: State, entry: LogEntry): State; // pure; returns a NEW state
export function replay(entries: LogEntry[]): State;               // = entries.slice(1).reduce(applyEntry, genesisState(entries[0]))
```

* Inputs are `LogEntry` values (`src/core/log.ts`) — git commits already reduced to: seq, sha,
  parents, signature check result (principal resolved against the **local** trust root), name-status
  changes, and the content of added files. The reducer never touches git, clocks or the fs.
* **Purity / immutability:** `applyEntry` deep-clones what it changes (`structuredClone` of the
  state is acceptable at MVP sizes); handlers mutate the draft and the draft is discarded on
  rejection. Never mutate the input state.
* **Plain JSON state** (`src/core/reducer/state.ts`): no Map/Set/Date/undefined. Two daemons at
  the same tip must produce byte-identical `canonicalJson(state)` (invariant 1).
* **Incremental == full:** `applyEntry` over new entries from a cached state must equal a full
  `replay` (invariant 1b). The daemon caches `(tip sha → state)`; `skep doctor` runs a full replay.

### 5.2 State shape (summary)

```text
State
├── reducer_version, protocol_version, blackboard_id, genesis_sha, tip, seq
├── agents:         { [agentId]: { agent, device, profile, registered_seq } }
├── tasks:          { [taskId]: TaskState }
├── seen_event_ids: { [eventId]: seq }
└── outcomes:       LogOutcome[]   // one per seq ≥ 1: accepted | rejected | invalid | duplicate (+reason)

TaskState
├── status (planning | reviewing | awaiting_approval | executing | interrupting | replanning
│           | delivered | done | escalated | cancelled), created_seq, rev, last_seq
├── title, body, repo, base_branch, mode, plan_approval, budgets
├── owner, owner_gen
├── plans: { [version]: PlanRecord{ plan, plan_hash, base_commit, reviewers, reviews, locked, decision } }
├── current_plan_version, active_plan_version
├── review_rounds, replan_count, barrier: Barrier | null
├── epochs: { [itemId]: highest epoch ever granted }        // survives plan versions
├── items:  { [itemId]: ItemState }                           // items of the ACTIVE plan
└── escalation, verified, cancelled
    // escalation.reason ∈ review_rounds | replans | item_failed | budget_exceeded
    //                     | verification_failed (D14)

ItemState: id, title, assignee, depends_on, requires, status, lease, delivered, merged, failure,
           last_checkpoint, attempts_this_plan
Lease:     epoch, holder, attempt_id, branch, plan_version, plan_hash, granted_at_seq, interrupt
Barrier:   id (B<seq>), opened_seq, closed_seq, requests[], awaiting[], checkpointed[], escalate
```

### 5.3 Per-entry algorithm (order matters)

```text
applyEntry(s, e):                                   // e.seq == s.seq + 1
  1. structural(e, s.tip)        → invalid(reason) ⇒ record outcome "invalid", alarm, return
       - e.parents.length != 1                          not_linear
       - e.parents[0] != s.tip                          parent_mismatch
       - signature missing / bad / unknown key          unsigned / bad_signature / unknown_signer
       - principal string not parseable                 unknown_signer
       - changes != exactly one "A" change              not_single_add
       - path not events/<task|_skep>/<evt>.json        bad_event_path
       - added content null (too big / not UTF-8)       unreadable_event
       - parseEventFile fails (schema, REQUIRED_PRE)    schema_invalid
       - path ids ≠ envelope task_id/event_id           path_mismatch
  2. event_id ∈ s.seen_event_ids  ⇒ outcome "duplicate" (no state change), return
  3. event.observed_tip ≠ e.parents[0] ⇒ rejected "stale_tip" (event_id NOT marked seen), return
  4. authz(principal, event, s) fails ⇒ rejected "unauthorized" (NOT marked seen), return
  5. preconditions + handler on a draft:
       ok   ⇒ commit draft; task.rev += 1; task.last_seq = seq; outcome "accepted"
       fail ⇒ discard draft; outcome "rejected" + reason
     either way: seen_event_ids[event_id] = seq
  6. s.tip = e.sha; s.seq = e.seq          (also for invalid/duplicate/rejected entries)
```

Determinism argument: every branch depends only on `(entries, trust-root-derived signatures,
REDUCER_VERSION)`. Invalid entries still advance `tip`, so all daemons agree on positions.

**Genesis (seq 0):** must have no parents, a `good` signature by `human`, and add `skep.json`
(`GenesisSchema`); other added files (e.g. `policy/allowed_signers.txt`) are ignored. A bad
genesis is fatal (`GenesisError`): the daemon refuses to run against that blackboard.

### 5.4 Authorization (PRD §11.3)

`authz(principal, event, state)`:

1. **Actor binding.** `human` principal ⇒ `actor == "human"`. `daemon:<d>` ⇒ actor is an agent ID
   whose device is `<d>`. Otherwise `unauthorized`.
2. **Type matrix.**

| Type | `human` | `daemon:<d>` (actor on `<d>`) |
|---|---|---|
| task.created, task.cancelled, owner.transferred, plan.approved, plan.rejected, human.decided | ✅ | ❌ |
| lease.revoked | ✅ | ❌ (V1: owner with observed_hb) |
| plan.proposed, plan.locked, task.verified | ❌ | actor == task.owner |
| barrier.closed | ✅ | actor == task.owner |
| review.submitted | ✅ | actor ∈ plans[current].reviewers |
| lease.claimed, lease.released, checkpoint.recorded, work.delivered, work.failed | ❌ | ✅ (fencing checked by handler) |
| replan.requested | ✅ | actor == task.owner or actor holds a lease in the task |
| agent.registered | ❌ | ✅ |
| item.merged | ✅ | ✅ |
| provider.bound, provider.revoked *(planned, D17)* | ✅ | ❌ |
| device.key_published, provider.applied *(planned, D17)* | ❌ | actor on `<d>`; payload device == `<d>`; `provider.applied` only for the actor itself |

3. State-dependent checks (owner, reviewer, holder) are evaluated only if the task exists; if it
   does not, authz passes and the handler rejects with `unknown_task`.

### 5.5 Transitions (handlers)

Generic, before any task handler: task must exist (`unknown_task`; except `task.created` ⇒ must
not exist, `task_exists`); task not terminal (`task_terminal`); then the §4.2 `pre` comparisons.
"Activate plan v" (used by `plan.approved`, owner-policy `plan.locked`, `human.decided`) =
set `active_plan_version = v`, rebuild `items` from the plan in `stack_order` (first item `ready`,
others `blocked`), carry over `delivered`/`merged` status for an item ID whose canonical item
definition (title, assignee, depends_on, touches, acceptance, requires) is unchanged from the
previously active plan, reset `attempts_this_plan`, clear `barrier`, `escalation` and
`verified`, drop every lease (parked leases end here, D16), keep `epochs`, and set `task.mode = plan.mode` (D13). The resulting status
is derived from the rebuilt items (D15): every item `merged` ⇒ `done`; every item `delivered` or
`merged` ⇒ `delivered` (the owner verifies the stack again); otherwise `executing`. "⇒
`executing`" in the table below means "⇒ the activation status".

| Event | Allowed task status | Checks (reject reason) | Effect |
|---|---|---|---|
| agent.registered | – | – | upsert `agents[actor]` (latest wins) |
| task.created | (new) | owner registered (`unknown_agent`) | new task: `planning`, owner_gen 1, rev 0→1 |
| task.cancelled | any non-terminal | – | `cancelled`; leases cleared; barrier cleared |
| owner.transferred | any non-terminal | new_owner registered (`unknown_agent`) | owner = new_owner; owner_gen += 1 |
| plan.proposed | planning, replanning, reviewing | version = current+1, parent = current, plan.task_id/version match, `contentHash(plan) == plan_hash` (`plan_hash_mismatch`), base_commit == plan.base.commit, plan.base.repo == task.repo, assignees registered, mode allowed (D13: task.mode team ⇒ plan.mode team; plan.mode solo ⇒ exactly 1 item), reviewers by **plan.mode**: solo ⇒ `[]`, team ⇒ 1..4 registered, ≠ owner (`invalid_plan`) | record PlanRecord; current = version; if superseding a version with a `block` review ⇒ review_rounds += 1; status by plan.mode: team ⇒ `reviewing`, solo ⇒ `awaiting_approval` with implicit lock; review_rounds > budget ⇒ `escalated` |
| review.submitted | reviewing | payload plan_version/hash == current (`plan_changed`); block ⇒ ≥1 blocker with evidence (schema) | `reviews[actor]` = latest |
| plan.locked | reviewing (current plan.mode team) or awaiting_approval (current plan.mode solo, plan_approval=owner) | every override names an existing `block` blocker; missing_reviews == reviewers without a review (`invalid_plan`) | record lock; plan_approval=owner and no `risk: high` item ⇒ activate ⇒ `executing`; else `awaiting_approval` |
| plan.approved | awaiting_approval | current version locked (`bad_task_state`) | activate ⇒ `executing` |
| plan.rejected | awaiting_approval | – | review_rounds += 1; `planning` (or `escalated` if > budget) |
| lease.claimed | executing | barrier null (`barrier_open`); item `ready` (`item_not_ready`); actor == assignee (`not_assignee`); expected_epoch (`epoch_mismatch`); plan_hash == active (`plan_changed`); actor's active leases (items in status `leased`, D16) across all tasks < max_parallel_items (`max_parallel`); attempts_this_plan ≤ item_retries (`retry_budget`); branch == `skep/<task>/<item>/e<epoch+1>` (`bad_branch`) | epochs[item] += 1; lease set; item `leased`; attempts += 1 |
| lease.released | executing, interrupting | lease.holder == actor ∧ lease.epoch == payload.epoch (`fenced`) | lease null; item `ready`; in a barrier counts as settled |
| lease.revoked | executing, interrupting, escalated | lease exists ∧ lease.epoch == payload.epoch (`epoch_mismatch`) | lease null; item `ready` (`unknown` if interrupting); settles barrier |
| checkpoint.recorded | executing, interrupting, replanning, escalated | fenced as above; snapshot.item/epoch match (`bad_snapshot`); barrier_id null or == task.barrier.id (`no_barrier`) | last_checkpoint; if barrier: item `interrupted` (lease parked, D16), add to checkpointed; all awaiting settled ⇒ closed_seq, status `replanning` (or `escalated` if barrier.escalate) |
| work.delivered | executing | fenced; lease.interrupt null (`interrupted`); branch == lease.branch (`bad_branch`) | item `delivered` (lease null); dependents whose deps are all delivered ⇒ `ready`; all delivered ⇒ task `delivered` |
| work.failed | executing, interrupting | fenced | item `failed`, lease null; settles barrier; executing: attempts_this_plan ≤ item_retries and class ≠ budget_exceeded ⇒ item `ready`, else task `escalated` |
| replan.requested | executing ⇒ open; interrupting, replanning ⇒ coalesce | daemon actor needs ≥1 evidence (`missing_evidence`) | executing: replan_count += 1; barrier `B<seq>` with awaiting = items holding leases; flag those leases; escalate = replan_count > budgets.replans; status `interrupting` (or immediately `replanning`/`escalated` if nothing awaited). Otherwise append to barrier.requests (count unchanged) |
| barrier.closed | interrupting | barrier_id == open barrier (`no_barrier`); missing == awaiting − settled (`pre_mismatch`) | missing items `unknown`, leases cleared; closed; `replanning` (or `escalated`) |
| item.merged | executing, delivered, escalated | item delivered ∧ pr_number matches (`bad_task_state`) | item `merged`; all merged ⇒ `done` (also from `escalated`: merging is a human gate, so merging every PR overrides a failed verification, D14) |
| task.verified | delivered | top_of_stack_sha == delivered head of last stack item (`bad_task_state`) | record verified; `passed: false` ⇒ `escalated` (reason `verification_failed`), items/deliveries/epochs unchanged (D14) |
| human.decided | escalated | decision valid for state (`bad_decision`) | resume_with_plan ⇒ activate active plan again, failed/unknown/interrupted items `ready` ⇒ activation status (`executing`, or `delivered`/`done` when nothing is left, D15); replan ⇒ `planning`, review_rounds = 0, barrier cleared (D12); cancel ⇒ `cancelled`; reassign_owner ⇒ owner/owner_gen += 1, `planning`, review_rounds = 0, barrier cleared (D12) |

**Budgets** (PRD §9.9): `replans` and `review_rounds` count *failures allowed*; the failure that
exceeds the budget escalates (replans: 3rd request with budget 2). A human `human.decided` of
`replan` or `reassign_owner` grants a fresh review budget: `review_rounds` resets to 0 and any
`barrier` is cleared (D12), otherwise every new proposal after a review-round escalation would
re-escalate immediately and the task could only be cancelled. `replan_count` is **not** reset: it
is a lifetime counter, so the human is consulted again on every further replan. `item_retries`: an item may be
leased `1 + item_retries` times per plan version. `max_invocations` / `max_wall_hours` are
enforced by the executing daemon (they are not observable on the log); exhaustion ⇒
`work.failed{class: budget_exceeded}` ⇒ escalate. A failed top-of-stack verification consumes no
budget and is never retried automatically: it escalates on the first `task.verified{passed:
false}` (D14), and the human's decision is the retry gate.

**Failed top-of-stack verification (D14, PRD §9.8).** Once every item is delivered the task is
`delivered` and no item holds a lease, so the PRD's "`work.failed` on the top item" cannot pass
fencing (§6.2). Instead the owner records the failing combined result as `task.verified{passed:
false, check_runs}` (owner only, `pre.owner_gen` + `pre.plan_hash`; a stale owner generation or plan
is rejected by §4.2). The reducer moves the task to `escalated` with reason `verification_failed`;
items stay `delivered`/`merged`, `epochs` are unchanged and there is nothing to fence. The human
then decides:

* `resume_with_plan` ⇒ re-activates the same plan; every item carries over, so by D15 the task
  returns to `delivered` with `verified = null` and the owner re-runs verification (e.g. after a
  flaky check or a fix pushed to the base branch).
* `replan` / `reassign_owner` ⇒ `planning`; the owner proposes `v+1` (input: the failing
  `check_runs`), typically keeping the delivered items unchanged (carried over by D7) and appending
  a fix item that depends on the old top item. Activation then makes only the new item `ready`.
* `cancel` ⇒ `cancelled`. Merging every PR anyway ⇒ `done` (`item.merged` row).

`task.verified{passed: true}` changes only `verified`; the task stays `delivered` until merged.

**Plan mode decides routing (D13, PRD §9.1, §9.3).** `task.mode` is the mode the human asked for
(`solo` by default, `team` with `--team`); each plan carries its own `plan.mode`. The **plan's**
mode decides reviewers (solo ⇒ none, team ⇒ 1..4), the status after `plan.proposed` (solo ⇒
implicitly locked, `awaiting_approval`; team ⇒ `reviewing`) and which `plan.locked` is allowed.
Upgrade only: a `solo` task may receive a `team` plan (the capability-split case), but a `team`
task only accepts `team` plans, because `--team` is an explicit human request the owner cannot
override. A `solo` plan has exactly one item. Activating a plan sets `task.mode = plan.mode`, so
the task switches to team mode only when a human approves the plan (or an owner-policy lock
activates it, §9.4), and from then on it stays team (later replans must be team plans too). The
owner's plan validator (§11.2) picks `team` whenever the plan has more than one item or an item
assigned to an agent on another device than the owner. Implemented by SK-208 (SK-101 currently
requires `plan.mode == task.mode`).

### 5.6 Views

`src/core/reducer/views.ts` (pure helpers used by daemon duties and the CLI): `claimableItems(s,
agent)`, `leasesHeldBy(s, agent)`, `isOwner(s, task, agent)`, `pendingReviews(s, agent)`,
`barrierStatus(s, task)`, `statusView(s)` (stable JSON for `skep status --machine`).

---

## 6. Lease protocol

### 6.1 Claiming

A slot's duty loop computes, from the latest State, the items it may claim
(`claimableItems`: task `executing`, item `ready`, assignee == me, `activeLeaseCount(s, me) <
max_parallel_items`, D16). For each,
it enqueues a **claim intent**:

```ts
const claim: Intent = (s) => {
  const t = s.tasks[taskId]; const it = t?.items[item];
  if (!t || t.status !== "executing" || !it || it.status !== "ready" || it.assignee !== me) return null;
  const e = t.epochs[item] ?? 0;
  return draft("lease.claimed", taskId, { item, attempt_id, branch: workBranch(taskId, item, e + 1) },
               { task_rev: t.rev, plan_version: t.active_plan_version!, plan_hash: ..., item, expected_epoch: e });
};
```

**Which leases count toward `max_parallel_items` (D16).** Exactly the items in status `leased`
whose `lease.holder` is the agent, in any task (`activeLeaseCount` in `handlers/lease.ts`, shared
by the claim handler and `views.ts`). A lease flagged by a barrier (`lease.interrupt` set) still
counts until its item has checkpointed, because the holder's process may still be running the
interrupt ladder. Once the item is `interrupted` the lease is **parked**: its record stays on the
item for audit and fencing until the next plan activation, but it no longer occupies a slot, so
the agent may claim in other tasks while the human or owner decides. Parked leases never become
active again; they end by plan activation (`plan.approved`, owner-policy `plan.locked`,
`human.decided{resume_with_plan}`; items are rebuilt and the previous holder re-claims under a
new epoch, PRD §9.5 "resume preference"), by `lease.revoked` (allowed in `escalated`), or by
cancellation. Items made `unknown` by `barrier.closed` or a revoke have no lease at all.

Two daemons racing compute the same `expected_epoch`; only one push lands on that tip; the loser
re-derives from the new state and gets `null` (dropped). The attempt runner starts only after the
publisher reports the claim **accepted** at seq N.

### 6.2 Fencing

* Every downstream event carries `payload.epoch` + `pre.item`; handler rejects unless
  `lease.holder == actor && lease.epoch == epoch` (`fenced`).
* Code branches are epoch-namespaced (`skep/<task>/<item>/e<epoch>`); a stale holder can never
  overwrite the current holder's branch. The current holder's daemon closes PRs from older epochs
  of the same item (`CodeHost.closePr`).
* No time-based expiry on `main`. Leases end by release, revoke, failure, delivery, plan
  activation, or cancellation; a barrier checkpoint parks a lease (D16) and `barrier.closed`
  clears the leases of missing items.

### 6.3 Re-verification before delivery (sleep/wake rule)

`lease/reverify.ts`:

```ts
async function reverify(lease: HeldLease): Promise<"ok" | "stale"> {
  const s = await sync.observeNow();          // full write-loop observation: fetch → reset → recompute
  const t = s.tasks[lease.taskId]; const it = t?.items[lease.item];
  return t?.status === "executing" && it?.lease?.holder === me && it.lease.epoch === lease.epoch
         && it.lease.interrupt === null ? "ok" : "stale";
}
```

* Called by the attempt runner **immediately before** each externally visible delivery step:
  PR create/update and `work.delivered`. The `work.delivered` intent itself re-checks the same
  conditions against the state it is computed from (so a revoke landing between reverify and push
  still makes the publication drop or be rejected).
* `lease/suspend.ts`: every tick compares `Δwall − Δmonotonic`; a gap > 2 × poll interval (or an
  explicit wake notification) marks all held leases **unverified** and pauses new invocations
  until a successful reverify. Observers also reset liveness timers (§8.2).
* Failed reverify ⇒ journal `stale`; branch kept; no PR, no event.

### 6.4 Revocation (MVP: manual)

`skep status` flags a holder as `stale`/`lost` (observer-relative) and prints the suggested
command `skep lease revoke <task> <item> --epoch <n>`. The CLI builds a human-signed
`lease.revoked` with `pre.item` and `payload.epoch` = the epoch being revoked; the reducer
rejects it if the epoch moved on. V1 adds owner-initiated revocation citing `observed_hb`.

---

## 7. Git write path and signing

### 7.1 Private clone

Each writer owns a private non-bare clone of the blackboard (`$SKEP_HOME/blackboard`, mode 0700).
Nobody edits it by hand, so `reset --hard` is always safe. Fetch refspecs:
`+refs/heads/main:refs/remotes/origin/main` and `+refs/heads/hb/*:refs/remotes/origin/hb/*`.

### 7.2 Publisher (`src/blackboard/publisher.ts`)

```ts
type Intent = (s: State) => EventDraft | null;     // pure; re-run on every attempt
interface PublishResult { status: "accepted" | "rejected" | "dropped" | "failed"; seq?: number; reason?: string; eventId: string }

class Publisher {
  constructor(deps: { git: GitRunner; clone: BlackboardClone; signer: Signer; clock: Clock; rng: RandomSource; sync: Sync; maxAttempts?: number });
  publish(intent: Intent, opts?: { signer?: Signer }): Promise<PublishResult>;  // serialized FIFO queue
}
```

Loop (PRD §10.2), per queued intent, `eventId` fixed up front:

1. `git fetch origin <refspecs>` (failure ⇒ backoff, retry).
2. `git reset --hard origin/main`; `tip = rev-parse HEAD`.
3. `state = sync.replayTo(tip)` (incremental).
4. If `state.seen_event_ids[eventId]` exists ⇒ return its outcome (an earlier ambiguous push
   landed).
5. `draft = intent(state)`; `null` ⇒ `dropped`.
6. Fill `event_id`, `observed_tip = tip`, `created_at`, `lang`; `parseEvent` must pass.
7. Write `events/<task|_skep>/<event_id>.json`; build a **signed commit with plumbing** (§7.3)
   whose single parent is `tip`; `git update-ref refs/heads/main <new> <tip>`.
8. `git push origin <new>:refs/heads/main` (never `--force`).
   * ok ⇒ fetch (cheap) and replay to learn the outcome (`accepted`/`rejected`) at its seq.
   * non-fast-forward ⇒ go to 1.
   * ambiguous (timeout, connection reset) ⇒ go to 1 (step 4 resolves it).
9. After `MAX_ATTEMPTS` (8; jittered exponential backoff 0.5 s … 30 s) ⇒ `failed`; surfaced in
   status; attempt journal keeps the intent for retry after recovery (fail closed).

**Never** `pull`, `rebase`, `merge`, or `push --force` on `main`.

### 7.3 Signing

* `Signer` interface (`src/git/signer.ts`):
  ```ts
  interface Signer { principal: string; sign(payload: Uint8Array): Promise<string> } // armored SSH sig, namespace "git"
  ```
  `SshKeySigner` runs `ssh-keygen -Y sign -n git -f <key>` (key file for daemons; public key +
  `SSH_AUTH_SOCK` agent for the human key — the private key never leaves the agent/Secure Enclave).
* `git/commit.ts` builds commits with plumbing so any Signer works, including the human signer that
  lives in the CLI process: write blobs/tree (`git hash-object -w`, `git mktree`), compose the
  commit object text (`tree`, `parent`, `author`, `committer`, message), ask the Signer to sign it,
  insert the `gpgsig` header exactly as git does, `git hash-object -t commit -w --stdin`. Author/
  committer: `skepd@<device>` or `human`; dates from the injected Clock (deterministic in sim).
  Commit message: `<type> <task_id|_skep> <event_id>`.
* **Verification** (`git/verify.ts`) uses only the local trust root:
  `git -c gpg.ssh.allowedSignersFile=$SKEP_HOME/allowed_signers -c gpg.format=ssh log
  --first-parent --format=%H%x00%P%x00%G?%x00%GS ...`; `G` + principal ⇒ `good`, `N` ⇒
  `missing`, `B` ⇒ `bad`, `U`/`E` or principal not parseable ⇒ `unknown_key`. The repo copy
  `policy/allowed_signers.txt` is never read for trust.
* `hb/*` commits are signed the same way; observers verify that the principal is
  `daemon:<device of agent>`.
* Human key custody: MVP supports a key file or ssh-agent identity on the Mac
  (`device.toml: human_signing_key`); hardware/Secure-Enclave UX is a configuration detail.

### 7.4 Human-signed events through the daemon

The CLI sends `publish` with `signer: "human"` over the socket; the daemon's publisher calls back
`sign` over the same connection for each loop attempt (§12); the CLI signs with the human key and
answers. If the daemon is down, the CLI runs `Publisher` in-process on `$SKEP_HOME/cli-blackboard`.

### 7.5 Code repo writes

`exec/worktree.ts` keeps a daemon-owned mirror of each allowlisted code repo and creates
attempt worktrees under `<roleDir>/.skep/worktrees/<task>/<item>-e<epoch>`. The daemon commits
the agent's changes (signed with the daemon key, `skep-wip:` prefix for checkpoints), pushes
`skep/<task>/<item>/e<epoch>` (plain push; branch is unique to the epoch), and verifies the remote
ref equals the local sha before recording anything (**code first, then record**).

---

## 8. Heartbeats and liveness

### 8.1 Writer (`blackboard/heartbeat.ts`)

* Ref `refs/heads/hb/<agent>`; each beat = a new **orphan** commit (no parent), tree `{ hb.json }`
  (`skep.hb/v1`), signed by the daemon key.
* `git push --force-with-lease=refs/heads/hb/<agent>:<last_oid> origin <new>:refs/heads/hb/<agent>`.
  Lease failure ⇒ someone else wrote our ref ⇒ `duplicate-daemon` alarm (also raised when two
  `boot_id`s are seen for one agent).
* After each beat the daemon may publish a `tip` hint for `hb/<agent>` (D18, §17.3); observers still
  judge liveness only from fetched refs.
* Interval 60 s while holding a lease, 300 s idle. `n` increments per boot. Never touches `main`
  (invariant: zero heartbeat commits on main).

### 8.2 Observer (`blackboard/liveness.ts`)

```ts
class LivenessTracker {
  constructor(clock: Clock, cfg = { liveFactor: 3, staleMs: 5 * 60_000, lostMs: 15 * 60_000 });
  observe(agent: string, oid: string, hb: Heartbeat | null): void; // on every fetch
  classify(agent: string): { cls: "live" | "stale" | "lost" | "unknown"; sinceChangeMs: number; bootId?: string };
  resetAll(): void; // after own suspend
}
```

Records `(oid, n, boot_id)` and **the observer's monotonic time** when the value last changed.
`live` = changed within 3 × the agent's announced interval; `stale` ≥ 5 min; `lost` ≥ 15 min;
`unknown` until two observations. Sender `sent_at` is display-only. MVP use: `skep status`
liveness column + revoke suggestion.

---

## 9. Agent adapters, work reports and checks

### 9.1 Adapter interface

See `src/adapter/types.ts` (`AgentAdapter`, `AdapterInvocation`, `AdapterResult`). An adapter
only runs the CLI and returns the raw final message; it knows nothing about events. Provider
credentials reach the CLI only through `AdapterInvocation.env` (sanitized base ∪ the slot's
allowlisted provider env, D17 §16.9); each adapter declares that allowlist.

### 9.2 MVP adapter: Codex (`adapter/codex.ts`)

* Invocation (flags pinned by the Day-1 spike, SK-0xx): `codex exec --json --output-schema
  <scratch>/schema.json --output-last-message <scratch>/last.json --sandbox workspace-write
  --skip-git-repo-check -C <cwd> -` with the prompt on stdin; approval policy fixed to
  non-interactive (`never`). `cli_version` from `codex --version` must equal AGENT.md.
* JSONL events on stdout go to the journal log; usage is parsed from the final `token_count`-style
  event when present, else `null`.
* Permission prompt detection: any approval-request event or a read from stdin after the prompt
  ⇒ stop ⇒ `permission_prompt`.
* Interrupt: abort ⇒ ladder in `exec/interrupt.ts` on the process group (SIGINT → 120 s →
  SIGTERM → 30 s → SIGKILL), outcome `interrupted`/`killed`.
* Fallbacks (only if the spike fails): `claude -p --output-format json [--json-schema]`,
  `pi -p` — same interface.

### 9.3 Structured output (`adapter/structured.ts`)

```ts
async function runStructured<T>(adapter, inv, schema: z.ZodType<T>): Promise<
  { ok: true; value: T; result: AdapterResult } | { ok: false; error: string; result: AdapterResult }>
```

`outputSchema = z.toJSONSchema(schema)`; extract the last JSON object from `finalMessage`
(tolerate code fences); validate; on failure exactly **one** `repair` invocation with the
validator errors; still invalid ⇒ `invalid_output`.

### 9.4 Work report (`skep.work_report/v1`)

`summary`, `files_intended[]`, `concerns[]`, `replan_request {summary, evidence[]} | null`.
Advisory: the model cannot declare success. The daemon uses `files_intended` vs the real diff for
a `touches` warning, and `replan_request` (after evidence verification) for `replan.requested`.

### 9.5 Evidence verification (`exec/evidence.ts`)

* `file_span`: `git show <commit>:<path>` in the daemon's mirror; lines exist; sha256 of the
  `\n`-joined lines matches; excerpt (if any) equals those lines.
* `command_run` / `check_run`: `run_id` exists in this device's journal with the same sha, exit
  and `log_sha256` (cross-device verification of journal runs is V1; the reducer does not verify
  evidence — PRD §10.1).
* Unverified ⇒ the item is dropped; a `block` with no verified evidence is downgraded to
  `comment`; a replan request with none is ignored (logged).

### 9.6 Trusted checks (`exec/checks.ts`)

* Loaded **only** via `git show <base_commit>:.skep/checks.toml` from the daemon's mirror (never
  from the worktree or plan). Schema `ChecksFileSchema`: named entries with `argv[]`,
  `timeout_sec`, `cwd?`, `env?`, `parser`.
* Run with `shell: false` in the worktree, sanitized env, as the agent user, with timeout and
  process-group kill. Captured: exit, duration, tested sha (HEAD of the worktree after the daemon's
  commit), log digest ⇒ `CheckRun` + journal entry (`run_id`).
* Failure ⇒ one `fixup` invocation with the captured log tail ⇒ commit ⇒ re-check ⇒ else
  `work.failed{checks_failed}`.

### 9.7 Attempt pipeline (`exec/attempt.ts`)

Journaled steps (each an fsync'd JSONL record, each a sim crash point):
`claimed → worktree_created → preflight_ok → invoked(pid,pgid,start_token) → invocation_done(outcome)
→ committed(sha) → checks(run_ids) → [fixup…] → secret_scan_ok → pushed(sha) → reverified →
pr(number,url, created|found) → reverified → delivered_published(seq)`; side exits `failed(class)`,
`checkpointed`, `stale`.

---

## 10. Runtime backends and herdr

### 10.1 Native (MVP, `runtime/native.ts`)

`spawn(argv[0], argv.slice(1), { detached: true, cwd, env, uid?, gid?, stdio: ["pipe", fd, fd] })`.
`pgid = pid`. `startToken` = process start time (`/proc/<pid>/stat` field 22 on Linux, `ps -o
lstart= -p <pid>` on macOS). `signalGroup(sig)` = `process.kill(-pgid, sig)`. `isAlive(pgid,
token)` re-reads the start time to guard against PID reuse.

### 10.2 herdr (optional, V1; `runtime/herdr.ts`)

Selected per slot when `herdr` is on PATH **and** `herdr api schema --machine` reports a
compatible version; any herdr failure ⇒ the slot falls back to native for that invocation.

| Skep need | herdr call (always `--machine`) | Native fallback |
|---|---|---|
| Worktree | `herdr worktree create …` (daemon still commits/pushes) | `git worktree add` |
| Start agent session | `herdr agent start …` | `spawn` (detached) |
| Send prompt | `herdr agent prompt …` | stdin / `codex exec -` · `claude -p` · `pi -p` |
| Wait / timeout | `herdr agent wait …` | `ProcessHandle.wait()` + timer |
| Final output | `herdr agent read …` | `--output-last-message` file / stdout |
| Run a check | `herdr pane run …` + `herdr pane wait-output …` | `spawn` check argv |
| Status | `herdr api snapshot` | journal + process table |
| Discovery | `herdr api schema` | – |

The herdr backend implements both `RuntimeBackend` (process-level) and an optional
`AgentSessionBackend` (prompt/wait/read) so the adapter can delegate. MVP ships only the interface
and a stub that reports "unavailable".

---

## 11. Daemon internals

### 11.1 Tick loop (`daemon/daemon.ts`)

```text
every tick (20 s ±25 % with an active local task, 90 s idle; immediately after a local publish):
  1. suspend check (§6.3)
  2. sync: fetch main + hb/* → incremental replay → State; liveness.observe(...)
     (a relay `tip` hint starts this step early, ≤ 1 per 2 s; `ls-remote` may skip an idle fetch, D18)
  3. alarms: new invalid commits, duplicate boot_ids, reducer version mismatch
  4. for each slot: duties(state) → intents / attempt actions
       owner:    planning|replanning → plan invocation → validate → plan.proposed
                 reviewing + all reviews (or 15-min timeout) → plan.locked / revise (v+1)
                 interrupting + 20-min barrier deadline → barrier.closed
                 delivered ∧ verified == null → top-of-stack checks → task.verified{passed}
                   (passed:false ⇒ reducer escalates, D14; notify the human)
       reviewer: reviewing ∧ my review missing → review invocation → review.submitted
       assignee: claimable item → claim intent → start attempt runner
       holder:   barrier on my lease → interrupt → snapshot → checkpoint.recorded
       any:      PR merged (gh) → item.merged; retarget next PR
  5. heartbeat if due
  6. publisher drains its queue (serialized); after an accepted publish ⇒ hints.publish(tip)
  7. mailbox (D17): pending provider.bound for a local slot ⇒ fetch → verify → apply → provider.applied
```

All waits use the injected `Clock`; `Daemon.tick()` is callable directly by the simulator.

### 11.2 Plan validation (owner side, before `plan.proposed`)

PRD §9.2: schema; linear stack; assignees registered with matching role/capabilities/
`requires_local`; every `check` name exists in checks.toml at `base_commit`; `touches` paths exist
at base (warning); ≤ 4 items; reviewers chosen deterministically (team: the non-owner assignee).

### 11.3 Run journal

`<roleDir>/.skep/journal/<task>/<item>-e<epoch>.jsonl`, append-only, `fsync` after each record;
records `{ts_mono, ts_wall, step, ...}`. Also `checks/<run_id>.log` (digested).

### 11.4 Restart reconciliation (`exec/reconcile.ts`)

On start, after a full replay, for each unfinished attempt (PRD §10.6): live process group with
matching start token ⇒ re-adopt/terminate; branch on remote at recorded sha ⇒ skip push;
existing PR for branch ⇒ reuse; reverify ⇒ finish publication or mark `stale`; never re-run an
invocation whose outcome is unknown ⇒ `work.failed{crash}` or `checkpoint.recorded{unknown}`.

### 11.5 Code host (`codehost/types.ts`)

```ts
interface CodeHost {
  remoteBranchSha(repo: string, branch: string): Promise<string | null>;
  findPr(repo: string, head: string): Promise<PrInfo | null>;            // idempotency
  createPr(repo: string, p: { head: string; base: string; title: string; body: string }): Promise<PrInfo>;
  retargetPr(repo: string, pr: number, base: string): Promise<void>;
  closePr(repo: string, pr: number, comment: string): Promise<void>;
  prState(repo: string, pr: number): Promise<{ state: "open" | "closed" | "merged"; mergeSha: string | null }>;
}
```

`gh.ts` implements it with `gh pr list --head`, `gh pr create`, `gh pr edit --base`, `gh pr view
--json`. `fake.ts` keeps an in-memory registry over a local bare repo and asserts "one PR per
head branch".

---

## 12. CLI ↔ daemon socket protocol

* Transport: Unix domain socket `$SKEP_HOME/skepd.sock` (dir 0700, socket 0600, owned by the
  daemon user; the human's CLI user must be in the daemon group on the Mac). NDJSON frames, one JSON
  object per line, max 1 MiB per frame.
* Frames (Zod schemas in `src/ipc/protocol.ts`):

```jsonc
// client → daemon
{ "v": 1, "id": "c1", "method": "status" | "log" | "publish" | "agent.start" | "agent.stop" | "logs.tail" | "doctor" | "ping", "params": { ... } }
{ "v": 1, "id": "c1", "sign_result": { "req": "s1", "signature": "-----BEGIN SSH SIGNATURE-----…" } }   // reply to a sign callback
// daemon → client
{ "v": 1, "id": "c1", "ok": true, "result": { ... } }
{ "v": 1, "id": "c1", "ok": false, "error": { "code": "...", "message": "..." } }
{ "v": 1, "id": "c1", "sign_request": { "req": "s1", "payload_b64": "...", "principal": "human" } }  // publish with signer=human
{ "v": 1, "id": "c1", "stream": { ... } }                                                            // logs.tail chunks
```

* `publish.params = { intent: IntentSpec, signer: "daemon" | "human" }`. `IntentSpec` is a
  serializable description (`{ kind: "lease.revoke", task, item, epoch, reason }`, …) that the
  daemon maps to a pure intent function in `core/intents.ts` — the same functions the CLI uses in
  fallback mode, so behavior is identical either way.
* `status.result` = `statusView(state)` + liveness + fetch freshness (`#seq`, tip, fetched N s
  ago, reducer version, invalid commit count). The same JSON is printed by `--machine`.
* Version negotiation: `v` mismatch ⇒ `error.code = "protocol_version"`.
* `logs.tail` serves **local** agents only. There is no device-to-device socket and no SSH hop
  (D18): for a remote agent the CLI shows its last heartbeat; remote log streaming is V1 over the
  relay mailbox, redacted and encrypted (§17.6). All socket responses pass through the redactor
  (§16.10).

---

## 13. Simulation harness

Built first (PRD §16.3). Lives in `src/sim/` so `skep sim run` can ship it; tests in
`test/integration/sim/*.test.ts` run a fixed set of seeds.

### 13.1 Components

| Component | Responsibility |
|---|---|
| `rng.ts` | Seeded PRNG (sfc32/xoshiro128\*\*) with `fork(label)`; `RandomSource` adapter. |
| `fake-clock.ts` | One virtual time base for the world; per-daemon `Clock` views with skew and **suspend** (monotonic frozen while wall time advances). `sleep()` resolves when the scheduler advances virtual time. |
| `faulty-git.ts` | `GitRunner` decorator: by seeded schedule or explicit script, fail fetch, inject a competing push before ours (non-ff), **lost ack** (perform push, then report error), delay, partition a daemon. |
| `world.ts` | Temp dir with a bare blackboard remote + bare code remote, test SSH keys (fixtures), N daemons built from production classes with injected Clock/Rng/GitRunner/FakeAdapter/FakeCodeHost, a human actor driver (creates/approves/revokes via the same intents). |
| Scheduler | Discrete-event loop: picks the next runnable daemon tick / human action / timer by virtual time, ties broken by the seeded RNG ⇒ interleavings are reproducible. |
| Crash injection | Named crash points (`crashPoint("pushed")`) throw `SimCrash`; the world discards the Daemon instance and constructs a new one over the same on-disk state (journal, clones) ⇒ exercises reconciliation. |
| `invariants.ts` | Checked after every step (below). Violations fail with seed + step number + log dump. |
| `runner.ts` | `runScenario(name, seed, opts)`; CLI `skep sim run --seed 42 --scenario sleep-wake-revoke [--steps N]`. |

Determinism of real git: fixed test keys (ed25519 signatures are deterministic), author/committer
dates from the virtual clock, fixed identities ⇒ identical SHAs for identical seeds.

### 13.2 Invariants (PRD §16.3)

1. Replay determinism: all daemons at the same tip have byte-identical `canonicalJson(state)`;
   incremental == full replay.
2. ≤ 1 accepted `work.delivered` per (task, item, epoch); no accepted fenced event from a
   non-current epoch.
3. No accepted event with `observed_tip ≠ parent`; rejected events change nothing but `outcomes`/
   `seen_event_ids`.
4. No `lease.claimed` accepted while a barrier is open; unsigned/unauthorized commits change
   nothing.
5. ≤ 1 PR per head branch; every accepted `work.delivered.head_sha` exists on the code remote at
   that branch.
6. `replan_count ≤ budget` unless status is `escalated`; review rounds likewise.
7. `main` contains zero heartbeat commits; each `hb/*` ref has exactly one (orphan) commit.
8. Task status agrees with its items (D15): `executing` ⇒ at least one item is not
   `delivered`/`merged`; `delivered` ⇒ every item is `delivered`/`merged` and not all `merged`;
   `escalated` with reason `verification_failed` ⇒ `verified.passed == false` (D14).
9. Right after every accepted `lease.claimed`, the actor's `activeLeaseCount` (items in status
   `leased`; parked `interrupted` leases excluded, D16) ≤ its `max_parallel_items` at that seq.

Pure predicates for 2–4, 6, 8 and 9 live in `core/reducer/invariants.ts` (usable by `skep doctor`).

### 13.3 Scenarios (MVP set)

`empty` (2 daemons idle) · `solo-happy` · `team-stacked` · `claim-race` (8-way push race) ·
`lost-ack` · `fetch-flaky` · `sleep-wake-revoke` (S5) · `replan-once` (S3) · `replan-escalate`
(S4) · `missing-checkpoint` (barrier deadline) · `crash-every-step` (crash at each journal step) ·
`forged-commits` (unsigned, wrong principal, daemon creating a task, merge commit) ·
`duplicate-boot` · `clock-skew` · `invalid-output` / `permission-prompt` / `hang` (fake adapter).

### 13.4 Fake adapter (`adapter/fake.ts`)

Script per invocation kind: `success(files)`, `invalidJson`, `validButWrongEvidence`, `hang`,
`slow(ms)`, `permissionPrompt`, `replanRequest(evidence)`, `crash`. It edits files in the worktree
deterministically (content derived from the seed) so checks (`sh -c` is forbidden — checks in sim
use `node -e` argv) can pass or fail on purpose.

---

## 14. Testing strategy

| Layer | What | Where | Command |
|---|---|---|---|
| Unit (pure) | ids, canonical, schemas, reducer handlers, authz, views, intents, liveness math, backoff | colocated `src/**/*.test.ts` | `npm test` |
| Property | random event sequences (seeded) ⇒ replay determinism, incremental == full, invariants 2–4, 6; forged entries are no-ops | `src/core/reducer/*.property.test.ts` | `npm test` |
| Golden | checked-in logs (`test/fixtures/golden/*.json`) ⇒ expected `contentHash(state)`; guards reducer versioning | `test/integration/golden.test.ts` | `npm test` |
| Git integration | real `git`/`ssh-keygen` in temp dirs: signing, verification against allowed_signers, log reader, publisher races, heartbeats | `src/git/*.test.ts`, `test/integration/*.test.ts` | `npm test` |
| Simulation | scenarios × fixed seeds, all invariants every step | `test/integration/sim/*.test.ts` | `npm test`; more seeds: `SKEP_SIM_SEEDS=200 npm test -- sim` |
| Adapter conformance | real CLI (opt-in): schema output, interrupt, permission prompt, usage | `test/integration/adapter-*.test.ts` | `SKEP_REAL_CODEX=1 npm test -- adapter` |
| End-to-end | two real devices, runbook S1/S2/S3/S5 | manual (`docs/RUNBOOK.md`, Day 10) | – |

Rules: tests never touch `~/.skep` (use `SKEP_HOME` temp dirs), never the network (local bare
repos), never real agent CLIs unless opted in. Test SSH keys live in `test/fixtures/keys/` and are
labelled test-only (gitleaks allowlist). `npm run lint` = Biome + `tsc --noEmit`; both must pass
before a task is done.

---

## 15. Decisions and deviations log

| # | Decision | Rationale |
|---|---|---|
| D1 | TypeScript/Node 22, Zod 4, Commander, Vitest, **Biome** (not ESLint) | PRD §16.2; Biome = one fast tool, no plugin config to drift across parallel worktrees. |
| D2 | `pre.task_rev` required on all task events | Uniform audit/defence in depth; free because intents re-derive each loop. |
| D3 | `event_id` marked seen only after step 5 (not for stale_tip/unauthorized) | Matches PRD pseudo-code; prevents a forged-but-signed event from squatting a legit id. |
| D4 | Solo plans are implicitly locked at proposal | Removes a useless round trip; PRD shows lock only for team review. |
| D5 | Budgets count allowed failures; exceeding one escalates | Matches "third replan escalates with budget 2"; same rule for review rounds. |
| D6 | Barrier record kept through `replanning`, cleared on plan activation | Allows coalescing late `replan.requested` (PRD §9.7) and late checkpoints. |
| D7 | Delivered/merged items carry over to a new plan iff their item definition is canonical-equal | Avoids redoing finished stacked work after a replan, deterministically. |
| D8 | Invocation/wall budgets enforced per executing device; exhaustion ⇒ `work.failed{budget_exceeded}` | Not observable on the log in the MVP; PRD has no budget event. |
| D9 | Commits built with git plumbing + pluggable `Signer` | Lets the human key sign through the daemon's single writer (sign callback) and keeps sim deterministic. |
| D10 | Verification via `git log %G?/%GS` with `-c gpg.ssh.allowedSignersFile=<local>` | Uses only the local trust root, one process for the whole walk. |
| D11 | Added `details` to plan items, `budget_exceeded`/`secret_detected` to failure classes, `passed` to `task.verified` | Gaps in the PRD tables needed by the execution flow. |
| D12 | `human.decided{replan \| reassign_owner}` resets `review_rounds` to 0 and clears `barrier`; `replan_count` is not reset | Without the reset a review-round escalation deadlocks the task (SK-101 review B1): every new proposal re-escalates. The human explicitly grants a fresh review budget; replans stay a lifetime count so each further replan goes back to the human. |
| D13 | `plan.mode` decides reviewers, routing and lock rules; upgrade only (solo task may take a team plan, team task only team plans); solo plan = 1 item; activation sets `task.mode = plan.mode` | PRD §9.1: "`--team` or a plan that the human approves with multiple items/devices switches to team mode". SK-101's `plan.mode == task.mode` made that switch impossible. Updating `task.mode` only on activation means the switch happens exactly when the human approves. |
| D14 | A failed top-of-stack verification is recorded as `task.verified{passed: false}` by the owner and moves the task `delivered → escalated` (reason `verification_failed`). Items, deliveries and epochs are unchanged; no budget is consumed and there is no automatic retry. The human resumes (re-verify, via D15), replans (fix item on top of the carried-over stack) or cancels; merging every PR anyway still completes the task | PRD §9.8 says "`work.failed` on the top item", but in `delivered` no item holds a lease, so a fenced event (PRD §9.5) cannot be accepted, and reopening the lease of a delivered item would undo a fenced, accepted delivery. `task.verified` is already owner-only and `owner_gen`/`plan_hash`-fenced (PRD §11.3), and `passed` exists (D11), so no schema change is needed. Escalation matches PRD §8.6 (a failure with no budget left ⇒ `escalated`) and §9.9 (escalation decisions are a human gate); integration failures span items, so retrying a single item is not a meaningful default. Found in the SK-201 review (note 1). |
| D15 | Plan activation derives the status from the rebuilt items: all `merged` ⇒ `done`; all `delivered`/`merged` ⇒ `delivered`; otherwise `executing` | With D7 carry-over a replan (or `resume_with_plan`) can keep every item finished. Claims and deliveries are the only way out of `executing` (PRD §8.6), so the task would be stuck forever. The rule reuses the existing `work.delivered`/`item.merged` completion conditions, so it is deterministic, and it clears `verified` so a carried-over stack is verified again under the new plan (PRD §9.8). Found in the SK-201 review (note 3). |
| D16 | Only items in status `leased` count toward `max_parallel_items`. A lease flagged by a barrier counts until its item checkpoints; after that it is parked (record kept until the next activation, never reactivated, ends on activation, revoke or cancel) and does not count | PRD §9.5 limits *held* leases ("claimant holds < `max_parallel_items`"). A checkpointed lease is fenced (`interrupt` set ⇒ no delivery, §6.3), and its process has stopped (PRD §9.7 ladder), so counting it would block the agent in every other task for as long as the human takes to decide an escalation. Counting a flagged but not yet checkpointed lease stays conservative while the process may still run. Found in the SK-201 review (note 4). |
| D17 | Provider config sync: the controller sends one cc-switch provider entry to exactly one `(device, agent)` as `skep.secret_bundle/v1` = age (X25519) encryption to a per-device key published on `main` by the device's daemon (`device.key_published`), signed by the human key (SSH signature, namespace `skep-secret-bundle@v1`), bound to blackboard/device/agent/version. `main` carries only metadata (`provider.bound`/`applied`/`revoked`) and is the anchor for replay/rollback protection; the ciphertext travels through a transient mailbox. Target stores ciphertext 0600 under the daemon user, decrypts per invocation and hands values to the agent CLI only via its process env (adapter allowlist); a redactor + exact-match scan guard every output. Design in §16 | PRD §3.2 excludes secret distribution through the blackboard and §18 defers `skep provider copy`; this is a deviation, kept narrow: no plaintext or plaintext hash ever on the blackboard, never on `main`, one entry per push. age over libsodium/SSH-derived keys: reviewed format with CLI recovery tooling, key separation from signing keys (§16.2). Anchoring versions on the signed log reuses the existing trust root (PRD §11.2) instead of trusting a transport. |
| D18 | No mesh VPN or fixed IP: the hosted git remote is the only rendezvous and authority (adaptive polling, `ls-remote` short-circuit); an optional outbound-only WebSocket relay carries only rate-limited wake-up hints and opaque encrypted mailbox blobs (V1); direct P2P rejected. Tailscale-dependent features move to signed enrollment/trust bundles, local `skep logs` + heartbeat summary (remote logs over the relay in V1), and relay hints. Design in §17 | Deviates from PRD §1, §5, §6.1, §11.2, §15.2 and §18, which assume a tailnet. Devices behind NAT, laptops and phones cannot rely on inbound reachability; correctness already comes from signed git (PRD §10), so a transport needs only availability. Polling latency (~10 s active) is small next to work-item durations, so the relay is an optimisation, not a dependency; P2P would need the relay for signalling anyway plus TURN. |

---

## 16. Provider config sync (D17)

> Status: design, not implemented. Tasks: SK-309 (protocol), SK-506 (redaction), SK-701..SK-704, SK-708.
> **PRD deviation:** PRD §3.2 lists "no secret storage or secret distribution through the
> blackboard" as a non-goal, and §16.1/§18 defer `skep provider copy` to V2. D17 brings a narrow,
> end-to-end encrypted point-to-point copy forward as an MVP+ feature (Wave 7, after the core MVP
> path). It keeps the spirit of the non-goal: **plaintext never touches the blackboard**, `main`
> carries only non-secret metadata, and ciphertext lives only in a transient mailbox (§17.3), never
> on `main`.

### 16.1 Goal and scope

The human's controller device (the Mac) selects **one** provider entry from its local
provider-switcher database (e.g. cc-switch) and sends it to **exactly one** `(device, agent)` slot.
A "provider config" is the set of environment values the agent CLI needs: API key(s), base URL,
model id, and a few CLI-specific options. Nothing else is in scope (no account management, no
installation of CLIs, PRD §3.2).

Threats addressed (on top of PRD §11.1): a passive or active attacker on the transport (git host,
relay, network), replay of an old bundle (rollback to a revoked key), cut-and-paste of a bundle to
another device or agent, leakage through logs, journals, prompts, events, notifications or the
agent's git output. Not addressed: a compromised target daemon user/host, or a compromised
controller (PRD §11.1 out of scope). The agent necessarily sees its own key (it calls the provider),
so a misbehaving agent can exfiltrate **that** key; the mitigations are scoping (one entry per
slot), per-device provider keys with provider-side limits, and fast rotation (§16.8).

### 16.2 Cryptography choice

| Option | Verdict |
|---|---|
| **age, X25519 recipients** (`age-encryption.org/v1`, `age-encryption` npm package, pinned) | **Chosen.** Well-specified, small, widely reviewed format (X25519 + HKDF-SHA-256 + ChaCha20-Poly1305, fresh ephemeral key per file). Interoperable with the `age`/`rage` CLIs, so a human can inspect or recover a bundle by hand. Pure TypeScript implementation, no native build. One new dependency, authorised by SK-702. |
| libsodium sealed boxes (`crypto_box_seal`) | Equivalent security (X25519 + XSalsa20-Poly1305, anonymous sender), but needs a WASM/native libsodium dependency that is larger than age, and offers no file format, armor or CLI tooling for recovery. |
| SSH-key-derived (ed25519 → X25519, or age `ssh-ed25519` recipients) | Rejected. It reuses the daemon's **signing** key for encryption (no key separation), so rotating one forces rotating the other, and a signing-key compromise also exposes every secret ever sent. A separate encryption key costs one extra file. |
| Hand-written HPKE (RFC 9180) on `node:crypto` | Fallback only if the dependency is vetoed: no new dependency, but it is our own crypto composition and must be checked against the RFC 9180 test vectors. |

Sender authentication is **not** age's job (age is anonymous-sender). Bundles are signed with the
existing human SSH key through the existing `Signer` (§7.3) in a dedicated namespace,
`skep-secret-bundle@v1`, so a bundle signature can never be confused with a commit signature
(namespace `git`). Verification uses only the local trust root (principal `human`).

### 16.3 Device encryption keys

* Each device generates an X25519 age identity at `skep init` (`$SKEP_HOME/keys/device.age`, mode
  0600, owned by the daemon user; the agent user cannot read `$SKEP_HOME`, PRD §11.4).
  `key_id = "dk_" + first 16 hex of sha256(recipient string)`.
* The daemon publishes the public recipient on `main` with a **`device.key_published`** event
  signed by its own daemon key (§16.6). Because the daemon principal is already in every device's
  trust root, the controller learns the recipient key with the same authenticity as any other
  event; there is no separate TOFU step.
* The controller encrypts **only** to the latest non-retired `key_id` of the target device on its
  replayed state.
* V1: identity kept in the macOS Keychain / Linux Secret Service where the daemon user can access
  it non-interactively; MVP: 0600 file (the same protection as the daemon's signing key).

### 16.4 Bundle format `skep.secret_bundle/v1`

Outer document (transported; contains no plaintext; strict Zod schema; ≤ 32 KiB):

```jsonc
{
  "schema": "skep.secret_bundle/v1",
  "bundle_id": "sb_<uuid v4>",
  "blackboard_id": "<from skep.json>",
  "device": "vps",                       // target device
  "agent": "vps.coding",                 // target slot; must live on `device`
  "version": 3,                          // per (blackboard, agent), strictly increasing
  "recipient_key_id": "dk_0123456789abcdef",
  "alg": "age-x25519",
  "ciphertext": "-----BEGIN AGE ENCRYPTED FILE-----\n…",
  "ciphertext_sha256": "sha256:…",
  "created_at": "2026-01-01T00:00:00Z",  // display only
  "signature": "-----BEGIN SSH SIGNATURE-----\n…"   // human key, namespace skep-secret-bundle@v1,
                                                    // over canonicalJson(outer minus signature)
}
```

Inner plaintext (only ever in memory on the controller and the target; strict schema
`skep.provider_config/v1`):

```jsonc
{
  "schema": "skep.provider_config/v1",
  "bundle_id": "sb_…", "blackboard_id": "…", "device": "vps", "agent": "vps.coding", "version": 3,
  "agent_cli": "codex",                          // must equal the slot's AGENT.md agent_cli
  "provider": { "name": "example-provider", "model": "example-model-1" },  // non-secret labels
  "env": { "EXAMPLE_API_KEY": "…", "EXAMPLE_BASE_URL": "https://api.example.invalid/v1" },
  "secret_env": ["EXAMPLE_API_KEY"],             // values the redactor must never let through
  "source": { "tool": "cc-switch", "entry_id": "…" }
}
```

* The binding fields (`bundle_id`, `blackboard_id`, `device`, `agent`, `version`) appear in both
  layers and must be equal. The signature covers the outer binding fields and the ciphertext hash;
  the inner copy defends against a bug that would decrypt one bundle under another's header.
* `env` keys must be in the adapter's **provider env allowlist** (`AgentAdapter.providerEnv`, SK-704;
  e.g. the API-key, base-URL and model variables that CLI documents). Anything else is rejected,
  so a bundle cannot inject `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `GIT_*`, etc.
* Scoping: the controller exports exactly one provider entry for one agent; the format has no
  list of entries, so "send everything" is not representable.

### 16.5 Flow

```text
controller (human, Mac)                       untrusted transport            target skepd (device d, slot a)
1. replay main → recipient key of d (§16.3), last version v of a
2. read ONE cc-switch entry (read-only, in memory)
3. inner → age-encrypt to recipient → outer → sign (human key, touch)
4. publish provider.bound {a, v+1, bundle_id, ciphertext_sha256, key_id} on main   (metadata only)
5. Mailbox.put(a, outer)  ─────────────────────►  (git ref or relay, §17.3)
                                                                    6. hint / poll → Mailbox.fetch(a)
                                                                    7. verify (§16.7) → decrypt → store
                                                                    8. publish provider.applied {a, v+1, sha}
                                                                    9. Mailbox.ack (delete) 
```

`main` is authoritative for **which** version is current; the mailbox only carries the bytes.
The target applies a bundle only if it matches the latest accepted `provider.bound` for its agent
(same `bundle_id`, `version`, `ciphertext_sha256`, `recipient_key_id`). This anchors replay and
rollback protection in the signed, linear log instead of in the transport.

### 16.6 Events (planned; SK-309)

All are `_skep` events (`task_id: null`; the §4.1 rule "null iff `agent.registered`" becomes "null
iff the type is a registry event": `agent.registered`, `device.key_published`, `provider.*`).

| Type | Actor / signer | Payload | Reducer effect |
|---|---|---|---|
| `device.key_published` | agent on device `d` / `daemon:d` | device, key_id, alg `age-x25519`, recipient, retires: key_id \| null | `devices[d].enc_keys[key_id] = {recipient, seq}`; `retires` marks the old key retired |
| `provider.bound` | human | agent, version, bundle_id, recipient_key_id, ciphertext_sha256, provider_name, transport (`git_ref` \| `relay`) | rejects unless agent registered, version == previous + 1 (`pre_mismatch`), key_id current for the agent's device (new reason `unknown_key_id`); sets `agents[a].provider = {…, status: "pending"}` |
| `provider.applied` | the target agent / `daemon:d` | version, bundle_id, ciphertext_sha256 | must match the pending binding; status `applied` |
| `provider.revoked` | human | agent, version, reason | status `revoked`; the target deletes its stored bundle and stops starting invocations for that slot until a newer `provider.bound` is applied |

No event carries a secret, a hash of plaintext (low-entropy fields such as a base URL could be
brute-forced), or the ciphertext. `skep status` shows per slot: provider name, version, pending /
applied / revoked, and whether a newer version is pending (freeze attack visible). PRD §13.3 step 3
("records only provider name + config hash") becomes provider name + bound version +
`ciphertext_sha256`.

### 16.7 Verification on the target (order = rejection precedence)

1. Outer schema; size; `blackboard_id`, `device`, `agent` are mine (else drop: not for me).
2. Human signature valid in namespace `skep-secret-bundle@v1` against the **local** trust root.
3. `sha256(ciphertext) == ciphertext_sha256`.
4. Matches the latest accepted `provider.bound` for the agent on my replayed `main`, and `version`
   > my stored version (replay/rollback protection; an older or unannounced bundle is dropped and
   alarmed).
5. `recipient_key_id` is one of my non-destroyed identities.
6. Decrypt; inner schema; binding fields equal; `agent_cli` equals the slot; `env` keys within the
   adapter allowlist.
7. Atomically store (16.9), destroy the previous version, publish `provider.applied`, ack the
   mailbox.

Any failure ⇒ no state change, a local alarm (`skep status`, ntfy) naming the step, never the
content; the bundle bytes are not logged.

### 16.8 Rotation and revocation

* **Provider secret rotation:** rotate at the provider, update cc-switch, `skep provider push`
  again (version + 1). Applied at the next invocation boundary; a running invocation keeps its
  environment. `skep provider status` lists slots still on an older version.
* **Device key rotation:** `skep device rotate-key` (target side) generates a new identity,
  re-encrypts its stored bundle locally to the new key, publishes `device.key_published{retires:
  old}`, then destroys the old identity. Controllers encrypt only to the new key; a bundle in flight
  to the retired key fails at step 5 and is re-pushed. Recommended every 90 days and whenever the
  device is re-imaged.
* **Device compromise / decommission:** human removes `daemon:<d>` from every trust root (PRD §11.2),
  publishes `provider.revoked` for each slot on `d`, and **rotates every provider secret that was
  ever sent to `d`** (the controller keeps a local, non-secret inventory: agent, version,
  provider_name, entry id, date). Revocation on the log stops an honest daemon; only provider-side
  rotation defeats a thief.
* **Forward secrecy limit (explicit):** age uses an ephemeral sender key but a static recipient key,
  so whoever captured old ciphertext and later steals a device identity can decrypt it. Mitigations:
  transient mailboxes (deleted on ack; relay mailboxes never persist past ack), key rotation that
  destroys old identities, and secret rotation after any device compromise.

### 16.9 At rest on the target and hand-off to the agent CLI

* Stored as the **age ciphertext** (re-encrypted to the device key) at
  `$SKEP_HOME/providers/<agent>.age`, 0600, daemon user; `$SKEP_HOME` is 0700 and not readable by
  the agent user. Decrypted into memory only when an invocation starts.
* Hand-off = **environment variables of the agent process only**: `AdapterInvocation.env` =
  sanitized base env (§9, PRD §11.4) ∪ the bundle's allowlisted `env`. Never in `skepd`'s own
  `process.env`, never passed to trusted checks (§9.6), the secret scan, git, `gh`, hooks or
  notifications. On Linux `/proc/<pid>/environ` is readable only by the same uid (the agent user,
  which needs the value anyway) and root.
* CLIs that only read a config file: the adapter writes it into an invocation-scoped directory
  (0700, owned by the agent user, under the scratch dir, pointed to by the CLI's documented home
  variable), deleted when the invocation ends and by restart reconciliation (§11.4).
* Prompts never contain provider values; plan/review/work prompts are built from the log and the
  worktree only.

### 16.10 Redaction and scanning

* `Redactor` (SK-506): built from every `secret_env` value currently loaded (plus derived forms:
  base64, URL-encoded); replaces matches with `[REDACTED:<NAME>]`. Applied to journal records, the
  adapter's captured stdout/stderr and JSONL logs, check logs, IPC responses (`logs.tail`, status),
  notifications and error messages, **before** they are written or sent.
* Before any publication (event, PR body, commit, snapshot, work-report-derived text) the daemon
  runs gitleaks (existing) **and** an exact-match scan against the loaded secrets; a hit fails the
  attempt with `work.failed{secret_detected}` and nothing is published (PRD §9.6 step 7).
* The controller never writes plaintext to disk: the cc-switch entry is read into memory,
  encrypted, and the buffer is overwritten after use (best effort in JS).
* Telemetry: none in the MVP; any future telemetry goes through the same redactor.

### 16.11 Failure modes

| Failure | Behaviour |
|---|---|
| Target offline | Mailbox keeps the bundle; `provider.bound` shows `pending`; target applies when it returns. |
| Mailbox lost / tampered / replayed | Steps 2–4 reject; status stays `pending`; human re-pushes (new version). |
| Target key rotated in flight | Step 5 fails; alarm "re-push needed"; controller re-encrypts to the new key. |
| Newer version announced but bytes never arrive | Keep using the applied version (no outage) and show "pending v+1" in status; `provider.revoked` is the explicit stop. |
| Revoked while an invocation runs | The running invocation finishes (cannot be fenced, PRD §9.5 limitation); no new invocation starts. |
| Decryption or inner validation fails | Alarm; bundle discarded; nothing stored. |
| Leak detected in output | `secret_detected`; rotate the secret (history is immutable, PRD §11.5). |

### 16.12 MVP vs later

* **MVP+ (Wave 7):** device key + `device.key_published`; `skep.secret_bundle/v1`; `provider.bound`
  / `applied` / `revoked`; git-ref mailbox (§17.3); cc-switch read-only import of one entry; env
  hand-off; redactor + exact-match scan; `skep provider push|status|revoke`, `skep device
  rotate-key`. Protocol events land in Wave 3 (SK-309) so they are part of the frozen protocol
  before the first live blackboard (§4.4).
* **Later:** OS keychain storage (V1); relay mailbox (V1, with D18 relay); scheduled key rotation
  reminders; multiple controllers; phones as targets; writing back into the target's cc-switch.

### 16.13 Open questions

1. cc-switch storage format and stability across versions (spike in SK-703); whether to read its
   database directly or use an export command if one exists.
2. Exact provider env variable names and config-file needs per pinned CLI version (Codex, Claude
   Code, pi) — determined by the adapter spikes (SK-207) and encoded in each adapter's allowlist.
3. Provider terms for using one account's key on several devices or unattended (PRD R11).
4. Whether the launchd daemon user can use the macOS Keychain without a GUI session (V1).
5. Git hosts may keep unreachable objects (deleted mailbox refs) for some time; acceptable only
   because content is ciphertext — prefer the relay mailbox once it exists.

---

## 17. Transport and discovery without a mesh VPN (D18)

> Status: design. Tasks: SK-308, SK-302 (changed), SK-705..SK-707, SK-607/SK-608 (changed).
> **PRD deviation:** PRD §1, §5 (principle 10), §6.1 ("Networking honesty" and the diagram's
> Tailscale edge), §11.2 (trust root "installed over Tailscale SSH"), §15.2 (`skep logs` "over
> Tailscale SSH") and §18 (notification hint "over Tailscale") assume a tailnet between devices.
> D18 removes that assumption: **no Skep feature requires device-to-device reachability, a mesh
> VPN or a fixed IP.** Every device only makes outbound connections (git over SSH/HTTPS, provider
> APIs, optionally one outbound WebSocket). Tailscale or plain SSH remain usable conveniences for
> the human, never dependencies.

### 17.1 Options evaluated

| Option | Latency (event visible on another device) | Cost / ops | Verdict |
|---|---|---|---|
| **A. Hosted git remote as sole rendezvous + adaptive polling** (current §7, §11.1) | mean ≈ half the poll interval + one fetch: ~10–12 s while a task is active (20 s ±25 %), ~45 s idle (90 s); immediate after a local publish | none beyond the git host; works behind any NAT that allows outbound SSH/HTTPS | **Default and authority.** Already required; the only component every device must reach. |
| **B. Outbound-only relay** (e.g. a serverless WebSocket relay: one small worker + one stateful object per blackboard topic) forwarding wake-up hints and opaque encrypted mailbox blobs | ~1–3 s (hint push < 1 s, then a normal fetch) | one small deployment on a serverless platform (free or entry tier for a few devices; verify current pricing); one config value per device | **Recommended accelerator (V1, optional).** Never an authority; system is fully correct when it is down. |
| C. Git host webhooks → relay → hints | ~2–10 s (webhook delivery) | needs B plus a webhook secret | Optional add-on to B; useful when some publishers do not run the relay client. |
| D. NAT traversal / direct P2P (ICE/STUN/TURN, hole punching) | sub-second when it works | needs signalling (i.e. B anyway) and a TURN fallback for symmetric NAT and mobile networks; large attack surface; complex to test deterministically | **Rejected for MVP and V1.** Buys latency we do not need (work items take minutes). |
| E. Mesh VPN (Tailscale etc.) | sub-second | third-party dependency, account, per-device agent | No longer required (this decision). Allowed as a human convenience. |

Ordered fallbacks: **relay hints (if configured) → adaptive polling of the git remote (always on) →
offline queueing** (publications queued in the journal, fail closed, §7.2 step 9; resumed with
lease re-verification, PRD §10.6).

### 17.2 Authority vs hints

* **Authoritative:** only the git remote — `main` (signed linear log) and `hb/*` (signed heartbeat
  refs). All protocol decisions come from replaying `main` (§5). The relay and the git host are
  untrusted for integrity (everything is signed and verified against the local trust root) and for
  confidentiality of secrets (D17 payloads are end-to-end encrypted); they are trusted **only for
  availability**. Non-secret blackboard content (task text, plans) is visible to the git host, as
  today (private repo, PRD §8.2).
* **Hint-only:** a hint can only make a daemon fetch **earlier**. It never changes state, never
  skips verification, and its contents are not trusted: a forged hint costs at most one extra
  fetch (rate-limited); a dropped hint costs at most one poll interval.
* **Mailbox:** store-and-forward of opaque, self-authenticating blobs (D17 bundles; V1 log
  snippets). The mailbox may lose, delay, duplicate, reorder or replay; the payload's own signature,
  encryption and the anchoring event on `main` handle that (§16.7).

### 17.3 Transport interfaces (`src/transport/types.ts`, SK-308)

```ts
export type Hint =                                   // Zod-validated, ≤ 1 KiB, strict
  | { v: 1; kind: "tip"; topic: string; ref: "main" | `hb/${string}`; sha: Sha }
  | { v: 1; kind: "mailbox"; topic: string; to: AgentId }
  | { v: 1; kind: "wake"; topic: string; device: string };

/** Best-effort, never authoritative. Implementations: NullHintChannel (default), RelayHintChannel (V1). */
export interface HintChannel {
  readonly name: string;
  start(onHint: (h: Hint) => void): Promise<void>;
  publish(h: Hint): Promise<void>;                   // never throws to callers; failures only logged
  stop(): Promise<void>;
  health(): { connected: boolean; lastMessageMonoMs: number | null };
}

/** Store-and-forward of opaque blobs; one slot per recipient (put replaces). */
export interface Mailbox {
  readonly name: string;                             // "git_ref" (MVP+) | "relay" (V1)
  put(to: AgentId, id: string, blob: Uint8Array): Promise<void>;
  fetch(me: AgentId): Promise<{ id: string; blob: Uint8Array } | null>;
  ack(me: AgentId, id: string): Promise<void>;       // delete if `id` is still the stored one
}
```

* `topic = base32(sha256("skep-relay/v1\0" + blackboard_id + "\0" + relay_secret))[0..26]`: the
  relay cannot link a topic to a repository; `relay_secret` comes from `device.toml` / the
  enrollment bundle (§17.6).
* **Sync integration (SK-302):** the poller keeps its adaptive interval (Clock-driven). A `tip`
  hint for `main` or `hb/*` triggers an early cycle, at most one per 2 s per daemon; before a full
  fetch the cycle may run `git ls-remote` for `main` and `hb/*` and skip the fetch if nothing
  moved. After every accepted local publish the publisher calls `hints.publish({kind: "tip"})`.
* **`GitRefMailbox` (SK-308):** `refs/heads/mbx/<agent>` on the blackboard remote, a single orphan
  commit with `blob.bin` (like `hb/*`, §8.1), written with `--force-with-lease`, deleted on ack.
  Never on `main`. Signed by the writer (human for D17), verified like heartbeats.
* **`RelayHintChannel` / `RelayMailbox` (SK-705, V1):** one outbound WebSocket per daemon to
  `wss://relay.example.invalid/v1/<topic>`, bearer `relay_token` (abuse control only, not trust),
  exponential reconnect via `util/backoff`; relay mailbox entries have a TTL (default 7 days), are
  ≤ 64 KiB and are deleted on ack. The relay stores nothing else and logs no payloads.

### 17.4 Security model

1. Every authoritative record is signed and verified locally (unchanged, §7.3); transports add no
   trust. 2. Secret payloads are end-to-end encrypted to the target device (D17); transports see
   ciphertext only. 3. The relay sees topics, connection timing and blob sizes (metadata) — accepted.
4. Denial of service by the git host or relay = no progress (fail closed), never wrong progress.
5. Hints are rate-limited and size-capped, so a hostile relay cannot amplify load beyond one fetch
   per 2 s per daemon. 6. Webhook ingestion (option C) verifies the host's HMAC signature, but even
   an unverified webhook could only produce a hint.

### 17.5 Offline and eventual consistency

Unchanged protocol rules make offline operation safe: no time-based lease expiry on `main` (§6.2);
re-verification before every externally visible delivery step (§6.3); publications queued and
retried through the write loop; observer-relative liveness (§8.2) shows a silent device as
`stale`/`lost` and the human may revoke. A laptop that sleeps or loses network simply falls behind
and catches up by replaying; hints missed while offline are irrelevant because the first poll after
waking observes the current tip. Phones do not run `skepd` (MVP and V1): they are notification
targets (ntfy) and, at most, read-only viewers; the human key stays on the controller.

### 17.6 Features that assumed Tailscale

| Feature | Without a mesh VPN |
|---|---|
| Installing / updating `allowed_signers` (PRD §11.2) | **Enrollment bundle** `skep.enroll/v1` (SK-706): `skep enroll export --device <d>` on the controller produces a file with blackboard URL, `blackboard_id`, genesis sha, the trust root lines, relay config (optional) and is signed by the human key. The human moves it by any channel (copy/paste in a provider web console, scp, QR code). `skep enroll import <file>` on the new device shows the human key fingerprint and requires the human to type its short fingerprint (out-of-band comparison; first trust is never taken from the transport). Later trust-root updates are `skep.trust_bundle/v1` files signed by the already-trusted human key, so they may travel over any untrusted channel, including the mailbox; they are still applied locally by `skep trust import` (PRD "changing trust requires a local edit" is preserved as an explicit local command). |
| Provisioning a device (daemon key, `device.toml`) | `skep init` on the device itself (console or any shell); prints the daemon public key line for the controller's trust root; the controller adds it and re-issues trust bundles. No inbound connection to the device. |
| `skep logs <agent>` for a remote device (PRD §15.2) | MVP: local agents only; for a remote agent the CLI prints the agent's last heartbeat (state, task, item, epoch) and the journal path to inspect on that device. V1 (SK-707 + relay): `logs.request` over the relay; the remote daemon returns redacted (§16.10) log chunks encrypted to the controller's age key and signed by the daemon key. |
| Notification hint channel (PRD §18) | The relay hint channel (§17.3) replaces it. |
| Human-layer bridge / herdr main manager reaching other devices | Out of MVP scope; any future bridge uses the same mailbox (signed + encrypted), not inbound SSH. |

### 17.7 MVP vs later

* **MVP:** option A only (already designed); `HintChannel`/`Mailbox` interfaces with the null hint
  channel and the git-ref mailbox; `ls-remote` short-circuit in sync; enrollment and trust bundles
  replace Tailscale SSH provisioning; `skep logs` local + heartbeat summary for remote agents.
* **V1:** relay (hints + mailbox), webhook ingestion, remote `skep logs` over the relay, D17 relay
  mailbox. **Not planned:** direct P2P, mesh VPN dependency.

### 17.8 Open questions

1. Git host behaviour under many devices polling (fetch throttling, per-ref push limits for
   `mbx/*`), to be measured in SK-609.
2. Choice of relay platform and who operates it (the user's own account); self-hosting story for a
   plain VPS.
3. Whether phones should get a signed read-only status feed via the relay (V2).
