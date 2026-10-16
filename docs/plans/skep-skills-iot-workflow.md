# Plan: Skep Skills + IoT BLE multi-stack feature workflow (SKILL)

Status: **MVP implementation design** (2026-10-16), amended by D36. Website and release work remain separate. Normative sources: `docs/PRD-v0.4.md`, `docs/ARCHITECTURE.md` (D19, D27, D29,
D31–D35), `docs/plans/tui-scroll-and-herdr-controller.md` (§3, the master orchestrator, "ORCH").

## 0. The ask (preserved, not reduced)

1. A new **primary workflow scenario**: **IoT BLE hardware products**. Shipping one feature
   usually touches a **C++ software layer** (device-side service / SDK layer), **server HTTP
   APIs**, and **app frontends: iOS, Android, H5**.
2. Each role/post is a Skep **peer**. The **master** issues the feature requirement once.
3. Add **skills** to Skep: different scenes get different skills. After the user **selects a
   skill**, Skep uses **scene-fit prompts and workflows** (briefs, sequencing, synthesis).
4. The **official website** (skepagent.com) presents this scenario as the **current main
   workflow scene**.

Scope guard: this is **software-layer, multi-repo collaboration**. Skep does not claim RF,
antenna, radio certification, or firmware-flashing expertise. "C++ layer" means the code the
team's agents can edit and build in a checkout: a device-side service, a BLE protocol/codec
library, an embedded application layer, or a host SDK. Hardware-in-the-loop testing stays with
humans and is named as such in every synthesis.

## 1. Where things stand (facts from the code)

| Fact | Where |
|---|---|
| Free text in the master shell is refined by the master's own agent CLI (read-only turn), dispatched as intents, and the results are synthesized in the same conversation. Modes `auto` (default) / `confirm` / `off`. | D32; `src/orchestrator/orchestrator.ts`, `settings.ts` |
| Refine output is strict JSON: `title`, `brief`, optional `targets[{repo,title?,brief?}]` (≤16, **each repo once**), `questions` (≤3), `notes`. | `src/core/orchestration/schemas.ts` |
| Prompts are English constants with `PROMPT_VERSION = 2`; peer results are inserted between delimiters as untrusted data. | `src/orchestrator/prompts.ts` |
| Each peer already has a free-form `role` (`/join … --role <role>`), and v2 `peer-info` can carry repo and role before the first intent. | `src/cli/shell/join-args.ts`; D35 |
| Peers prompt their agent from the intent text (title line + brief, ≤8000 on v2, first 4000 on v1). | D32, D35 |
| One dispatch wave: all targets are sent at once and the orchestration waits for all of them. | ORCH §3.2, §3.5 |
| Routing is by repo name; two peers on one repo get one plan item. Per-peer targeting would need an additive `peerIds`. | `docs/plans/intent-peer-pick.md` "Known limits" |
| Project home is `~/.skep/projects/<projectId>/` (or `SKEP_HOME`); `device.toml` and the `orchestrations/` ledger live there. | `src/config/paths.ts`; ORCH §3.7 |
| The npm package ships only `dist`, `README.md`, `LICENSE`, `CHANGELOG.md`. | `package.json` `files` |
| `src/cli/agent-guide/SKILL.md` is the existing *agent-facing* guide (how an agent uses the Skep CLI). It is unrelated to the user-facing skills designed here. | — |

What is missing for the IoT scene: the master prompt is scene-agnostic, it does not know which
peer plays which post, it cannot make five briefs agree on one interface, it has no notion of
"the API contract comes first", and the synthesis does not check cross-stack consistency.

## 2. Concepts and naming

* **Skill** — a versioned, declarative bundle that specializes the master orchestrator for one
  scene: master guidance, role definitions, per-role brief guidance, a shared-artifact contract,
  stages, and a synthesis checklist. A skill is **data, not code**: Skep never executes anything
  from a skill.
* **Role** — a post defined by a skill (`device`, `server`, `ios`, `android`, `h5`). Roles are
  bound to connected **peers**.
* **Binding** — the mapping `role → peer` (and therefore its repo) for the current shell session.
* **Feature contract** — the shared artifact the master drafts once per feature (HTTP endpoints,
  payload shapes, app-facing BLE command/event mapping, error codes, feature flags) and embeds in
  every role brief so that five agents implement one interface.
* **Active skill** — at most one per master shell session. No active skill = the built-in
  `generic` skill = exactly today's v0.1.15 behavior.

Naming in the UI: the commands are `/skills` and `/skill`. To avoid confusion with
`agent-guide/SKILL.md`, the docs call that file the "agent guide"; skill manifests are named
`skill.toml`, never `SKILL.md`.

## 3. Skill model

### 3.1 What a skill contains

| Part | Purpose | Used by |
|---|---|---|
| Manifest (`skill.toml`) | id, name, version, schema, description, tags, `min_skep`, mode hint, limits | loader, `/skills` |
| Roles | `id`, label, `required`, `match` hints (role aliases, repo globs), per-role brief guidance file, per-role done checklist | binding, refine prompt |
| Master guidance (`master.md`) | Scene knowledge for the refine turn: how to read a feature request, what to ask, how to split, what each brief must contain | refine prompt |
| Contract template (`contract.md`) | Section skeleton of the feature contract the master must fill | refine prompt, briefs |
| Stages | Ordered groups of roles with dependencies (`after`), e.g. contract → server+device → clients | orchestrator and prompt (MVP, D36) |
| Synthesis guidance (`synthesis.md`) | Cross-role consistency checklist and report shape | synthesis prompt |
| Artifacts | Declared outputs: `contract` (always in briefs and ledger), optional repo-local copy path per role | refine, peers, ledger |
| Questions policy | Scene-specific clarifying questions the master should prefer (still ≤3, same contract) | refine prompt |

Everything a skill adds is **prompt text plus structure Skep validates**. A skill cannot add
commands, change sandbox flags, change the read-only rule of D32, grant tool approvals (D29), or
change what leaves a device (D19, D27).

### 3.2 On-disk layout

```text
<skill-root>/<skill-id>/
  skill.toml          # manifest (strict, Zod-validated)
  master.md           # refine guidance (≤ 6000 chars)
  contract.md         # contract skeleton (≤ 3000 chars)
  synthesis.md        # synthesis checklist (≤ 3000 chars)
  roles/
    device.md         # per-role brief guidance (≤ 1500 chars each)
    server.md
    ios.md
    android.md
    h5.md
```

Skill roots, highest precedence first:

| Scope | Path | Who writes it | Trust |
|---|---|---|---|
| Project | `<git-top-level>/.skep/skills/<id>/` | the team, committed to the master's repo | needs one-time `/skill trust` per content digest (§3.6) |
| User | `~/.skep/skills/<id>/` (`SKEP_SKILLS_HOME` override for tests) | the human on this device | trusted |
| Packaged | inside the npm package (§3.4) | Skep releases | trusted |

A same-id skill in a higher scope **shadows** a lower one; `/skills` shows the shadowing
(`iot-ble-feature (project, shadows packaged 1.0.0)`). `/skill use packaged:iot-ble-feature`
forces a scope.

### 3.3 Manifest schema (`skep.skill/v1`)

```toml
schema = "skep.skill/v1"
id = "iot-ble-feature"              # ^[a-z][a-z0-9-]{1,39}$
name = "IoT BLE feature delivery"
version = "1.0.0"                   # semver of the skill content
description = "One feature across the C++ device layer, server HTTP API, iOS, Android and H5."
tags = ["iot", "ble", "multi-stack"]
min_skep = "0.2.0"
mode_hint = "confirm"               # optional: auto | confirm; a hint only (§4.4)

[master]
guidance = "master.md"
contract = "contract.md"
synthesis = "synthesis.md"

[[roles]]
id = "device"
label = "C++ device / SDK layer"
required = true
guidance = "roles/device.md"
match = { roles = ["device", "cpp", "c++", "firmware-app", "sdk"], repos = ["*-device", "*-sdk", "*-fw*"] }

[[roles]]
id = "server"
label = "Server HTTP API"
required = true
guidance = "roles/server.md"
match = { roles = ["server", "api", "backend"], repos = ["*-server", "*-api", "*-backend"] }

# ios, android, h5: required = false (a feature may skip a client)

[[stages]]
id = "contract"
roles = []                          # master-only stage: the contract is drafted in refine
[[stages]]
id = "providers"
roles = ["device", "server"]
after = ["contract"]
[[stages]]
id = "clients"
roles = ["ios", "android", "h5"]
after = ["providers"]               # D36: providers settle before clients in MVP

[artifacts.contract]
max_chars = 3000
repo_copy = "docs/features/{feature-slug}/contract.md"   # optional; peers may write it
```

Validation rules (strict Zod, unknown keys rejected, AGENTS.md): role ids unique and ≤ 16 roles
(= `MAX_TARGETS`); every `stages[].roles` entry is a declared role; `after` forms a DAG; file
references resolve inside the skill directory (no `..`, no symlinks leaving it); text files are
UTF-8 and within the char caps above; the sum of `master.md` + `contract.md` + role guidance fits
the refine-prompt budget (§3.5). A skill that fails validation is listed as `invalid: <reason>`
and cannot be activated.

### 3.4 Packaged vs user-custom skills

* **Packaged (MVP: `generic`, `iot-ble-feature`)** are authored directly as TypeScript modules
  under `src/skills/packaged/`, exporting manifest fields and Markdown strings. D36 locks this:
  no `skills/` package directory, mirrored source directory, or generator is required.
* **User / project skills** are read from disk at `/skills` and `/skill use` time, validated the
  same way, and re-read (digest compared) at the start of every orchestration so an edit takes
  effect on the next feature, never mid-flight.
* **Customizing a packaged skill**: `/skill fork iot-ble-feature [--project]` (Phase 2) copies it to
  the user or project scope with `version = "1.0.0-local.1"` so the team can edit roles (e.g. drop
  `h5`, add `firmware-ci` or `admin-web`).

### 3.5 Prompt composition and budgets

The skill **wraps** the existing prompts; it does not replace the safety text.

```text
refine prompt  = ROLE (unchanged)
               + "ACTIVE SKILL: <name> <version>" + master.md
               + role table: role id, label, bound peer/repo or UNBOUND, roles/<id>.md
               + contract skeleton (contract.md) + "fill it once; every brief embeds it"
               + existing TASK / peers / REQUEST / answers sections (unchanged)
               + extended JSON contract (§5.4)
synthesis      = existing synthesisPrompt (unchanged delimiters, untrusted-data rule)
               + "ACTIVE SKILL" + synthesis.md checklist + the feature contract that was sent
```

`PROMPT_VERSION` becomes 3. Budget: skill text in one refine prompt ≤ 16 000 chars (enforced at
validation). Per brief on the wire: `title` + role brief + embedded contract ≤ `MAX_INTENT_CHARS`
(8000, v2). v1 peers only get the first 4000 chars (D35), so with an active skill Skep places the
contract **first** in each brief and warns in the binding table when a bound peer is on v1.

### 3.6 Trust, versioning, ledger

* **Versioning.** `schema` versions the manifest format (`skep.skill/v1`); `version` versions the
  content. Skep computes a **content digest** (sha256 over canonical manifest + file texts,
  `src/core/canonical.ts`). Each orchestration ledger entry records `{skillId, version, scope,
  digest, promptVersion}` so a brief can always be traced to the wording that produced it
  (same intent as `PROMPT_VERSION`).
* **Trust.** Project skills come from a repo and their text reaches peer agents that can edit
  code. So: a project skill must be trusted once per digest (`/skill trust <id>`), stored in
  `<home>/skills-trust.json` (0600). A changed digest asks again. User and packaged skills are
  trusted. The master agent stays read-only and never dispatches by itself (D32), and `confirm`
  mode shows every brief, so a hostile skill is bounded to "bad briefs a human can read".
* **Secrets.** Skill files are prompt text. Validation rejects files that trip the existing
  redaction patterns, with a fixed message, and skills never carry provider settings (D19).

## 4. UX in the Skep shell / TUI

### 4.1 Commands (all additive)

| Command | Where | Effect |
|---|---|---|
| `/skills` | any shell | List skills: id, version, scope, roles, `active` marker, `invalid`/`untrusted` flags |
| `/skill` | master shell | Show the active skill and the role binding table |
| `/skill use <id>` | master shell | Activate for this shell session; prints the binding table |
| `/skill use <id> --default` | master shell | Also persist `[skill] default = "<id>"` in this project's `device.toml` |
| `/skill off` | master shell | Back to `generic` (today's behavior); `--default` clears the persisted default |
| `/skill bind <role> <peerId\|repo>` | master shell | Bind a role by hand; overrides auto-binding |
| `/skill unbind <role>` | master shell | Mark a role unbound (its brief is not sent) |
| `/skill show <id>` | any shell | Print the manifest summary, roles, stages and file sizes |
| `/skill trust <id>` | master shell | Trust a project skill at its current digest |
| `/skill fork <id> [--project]` | any shell (Phase 2) | Copy a skill to user/project scope for editing |
| `/start --skill <id>` | master | Start the session and activate the skill in one step |
| `skep session start --skill <id>` | scripts | Same for the non-shell flow |
| `/join <code> <ip:port> --role <role>` | peer | **Existing** flag; recommended values come from the skill (`device`, `server`, `ios`, `android`, `h5`) |

`/skill` subcommands go through the existing slash registry (`src/cli/shell/slash.ts`); the
command menu shows `/skills` always and `/skill` only on a master shell.

### 4.2 Role binding

Auto-binding runs whenever a peer joins, leaves, or reports `peer-info` (D35), and before every
dispatch:

1. A manual `/skill bind` wins.
2. The peer's join `--role` matches a role id or one of its `match.roles` aliases
   (case-insensitive).
3. The peer's repo name matches one of the role's `match.repos` globs.
4. Otherwise the role is **unbound**. Two peers matching one role → the earliest joined, and the
   table says `(2 candidates)` so the human can `/skill bind`.

Binding table (shown on `/skill`, `/skill use`, and in `confirm` before dispatch):

```text
skill iot-ble-feature 1.0.0 (packaged)            mode: confirm (hint)
role      label                     peer         device     repo            proto
device    C++ device / SDK layer    p-3f2a       rig-01     lock-sdk        v2
server    Server HTTP API           p-91c0       srv-02     lock-server     v2
ios       iOS app                   p-07bd       mbp-ios    lock-ios        v2
android   Android app               p-a1e4       mbp-and    lock-android    v1 ⚠ brief cut at 4000
h5        H5                        (unbound)    —          —               —   optional, skipped
```

A **required** role that is unbound blocks dispatch with an actionable message
(`role server is unbound: /join … --role server on the server checkout, or /skill bind server
<peer>`). An optional unbound role is skipped and named in the synthesis.

Monorepo case: if two bound roles resolve to the **same repo** (e.g. `ios` and `android` in one
`mobile` repo), MVP merges them into **one target** for that repo whose brief has one section per
role, because `targets` allows each repo once and routing is by repo. Per-peer targeting
(`peerIds`) is Phase 4.

### 4.3 Header and panels

* Master header gains a chip: `skill: iot-ble-feature` (nothing when `generic`).
* With `/layout split` (D34), peer panel titles show the role label: `ios · p-07bd · lock-ios`.
* Peers do not need the skill installed in MVP: they receive self-contained briefs. Phase 4 adds an
  additive v2 `welcome.skill{id,version}` and `role` echo so a peer shell shows
  `master skill: iot-ble-feature · your role: ios`.

### 4.4 Compatibility with `/start`, `/join`, `/intent`, `/orchestrate`

| Existing | With an active skill |
|---|---|
| `/start`, `/join` | Unchanged. `/start --skill` is optional sugar. `--role` on join becomes meaningful for binding. |
| Free text, `/orchestrate auto` | Refine with the skill → role briefs → dispatch without a prompt (briefs and contract shown in the scrollback). |
| `/orchestrate confirm` | Same, but the contract, the binding table and each role brief are shown; Enter sends, `e` edits, Esc cancels (existing keys). |
| `/orchestrate off` | Skill is ignored; Skep says `skill iot-ble-feature is inactive while /orchestrate is off`. Exactly v0.1.15 behavior. |
| `/intent [--repo …] <text>` | Stays **raw** (escape hatch, D32); no skill text is added. Phase 2 adds `/intent --role <role> <text>` = raw intent to the role's bound repo. |
| `/summarize`, `/history`, `/orchestrate new` | Unchanged; `/history` lines show the skill id. |
| Multi-peer picker | Skipped when the skill resolved every target by role; shown only for `generic` or when the refine output has no role targets. |

`mode_hint` never switches the mode. On `/skill use`, if the hint differs from the current mode,
Skep prints one line: `this skill suggests /orchestrate confirm for review before dispatch`.
The default mode stays `auto` (locked ORCH §9.1).

### 4.5 Defaults

* No persisted default → `generic`. New users see no change until they run `/skill use` or
  `/start --skill`.
* First `/start` in a project with no default and ≥ 1 non-generic skill available prints one hint
  line: `tip: /skills — e.g. /skill use iot-ble-feature for device + server + app features`.
* Website and README quick start lead with `/start --skill iot-ble-feature` (§7), so the main
  narrative is one command away without changing the CLI default.

## 5. Packaged skill: `iot-ble-feature`

### 5.1 Roles

| Role id | Label | Typical repo | Owns in a feature | Required |
|---|---|---|---|---|
| `device` | C++ device / SDK layer | device service, BLE protocol/codec library, embedded app layer, host SDK | GATT service/characteristic usage *as defined in the contract*, command/event encoding, state machine, C++ unit tests, version flag | yes |
| `server` | Server HTTP API | backend service | endpoints, request/response schemas, auth scope, persistence, migration, API tests, OpenAPI/contract doc | yes |
| `ios` | iOS app | Swift/ObjC app | BLE client usage (CoreBluetooth wrapper or shared SDK), API client, UI flow, permissions copy, tests | no |
| `android` | Android app | Kotlin/Java app | BLE client usage (Android BLE stack wrapper or shared SDK), API client, UI flow, runtime permissions, tests | no |
| `h5` | H5 | web / in-app webview | API client, UI flow; BLE only via a native bridge or Web Bluetooth **if the contract says so** | no |

The skill does not assume a team uses all five; any client can be unbound and is reported as
skipped.

### 5.2 Workflow (MVP)

```text
human (master): "Add auto-lock after N minutes, configurable in the app, synced to the account"
  │
  ▼ 1 REFINE (master agent, read-only, skill master.md)
  │   - classify: which roles are touched (device? server? which clients?)
  │   - ask ≤3 scene questions only if blocking (e.g. "Is the setting stored on the device,
  │     on the server, or both? Which wins on conflict?")
  │   - draft ONE feature contract (contract.md skeleton)
  │   - write one brief per touched role, each embedding the contract
  ▼ 2 CONFIRM (confirm mode / hint): contract + binding table + role briefs
  ▼ 3 DISPATCH providers: device + server, one intent per bound repo
  ▼ 4 AWAIT all provider intents (pending = stalled, D29)
  ▼ 5 DISPATCH clients: ios / android / h5, with earlier redacted results + changed files
  │   Peers work in their own folders (D31); failed providers are named explicitly
  ▼ 6 AWAIT all client intents
  ▼ 7 SYNTHESIZE with synthesis.md: per-role outcome + cross-stack consistency check
       + what needs a human on real hardware
```

**Amended by D36:** the former one-wave MVP recommendation is superseded. Staged dispatch
is included in MVP whenever stages are defined. Contract is a master-only refine stage, then
device/server providers settle, then client briefs receive earlier redacted summaries and
changed-file lists inside untrusted RESULT blocks. No stages (including `generic`) retains the
single-wave path. Failed/declined providers count as settled and their outcomes reach clients;
pending human approval stalls the stage. Shared-repo roles merge into one intent at the latest
of their stages, since MVP routing is by repo. Unstaged role/repo targets run in a final group.

### 5.3 Feature contract (`contract.md` skeleton)

```markdown
# Feature contract: <feature title>  (slug: <feature-slug>, contract rev 1)
## Behaviour      — user-visible behaviour in 3–6 bullets; out of scope
## Roles touched  — device / server / ios / android / h5, and why
## HTTP API       — METHOD /path, auth, request JSON, response JSON, error codes, idempotency
## Device link    — app-facing commands/events the C++ layer exposes: name, direction,
                    payload fields (type, unit, range), error/ack, which BLE service/
                    characteristic the EXISTING code uses (never invent UUIDs: say "TBD by
                    device role" when unknown)
## Data & sync    — source of truth, conflict rule, offline behaviour
## Compatibility  — min device software version / feature flag, old-app behaviour
## Done when      — per role, one line each
```

### 5.4 Refine output for skills (additive to `RefineOutputSchema`)

```jsonc
{
  "title": "Auto-lock after N minutes (device + server + apps)",
  "brief": "<summary brief, used for roles without their own>",
  "contract": "<filled contract.md, ≤ 3000 chars>",          // new, optional; required by iot-ble-feature
  "targets": [
    { "role": "device",  "title": "…", "brief": "…" },        // new: `role` instead of `repo`
    { "role": "server",  "title": "…", "brief": "…" },
    { "role": "ios",     "title": "…", "brief": "…" },
    { "role": "android", "title": "…", "brief": "…" }
  ],
  "questions": [],
  "notes": "h5 untouched: setting is native-only"
}
```

Rules: each target names exactly one of `repo` or `role`; a `role` must be declared by the active
skill; Skep resolves `role → repo` via the binding table **before** the existing per-repo
dispatch, so the wire and the `targets` "each repo once" rule are unchanged (two roles on one
repo merge as in §4.2). With `generic` the schema is exactly today's. The wire text per role is:

```text
[iot-ble-feature · device] Auto-lock after N minutes: device timer + config command
                                                    ← title line (old peers see only this)
FEATURE CONTRACT (shared by all roles; do not change it, report conflicts instead)
<contract>

YOUR ROLE: C++ device / SDK layer — repo lock-sdk
<role brief>

DONE WHEN: <role checklist from roles/device.md>
REPORT: list contract fields you implemented, anything in the contract you could not honour,
and tests you ran.
```

### 5.5 Role guidance (abridged content of `roles/*.md`)

* **device**: work only in the C++ layer of this repo; keep existing BLE service/characteristic
  identifiers unless the contract changes them; encode/decode exactly the contract fields with
  explicit units/ranges and endianness; add unit tests for the codec and the state machine; guard
  the feature behind the contract's version/flag; do not flash or touch hardware; say what needs
  bench testing.
* **server**: implement the contract endpoints exactly (paths, field names, error codes); add or
  update the repo's API description (OpenAPI or contract doc); migrations reversible; tests for
  happy path, auth, validation errors; note deploy order constraints.
* **ios / android**: consume the API and the device commands exactly as named in the contract;
  reuse the existing BLE wrapper/SDK; handle permission, disconnected and old-device-version
  cases; add UI strings via the repo's localization mechanism; tests with mocked API and BLE
  layer; list screens touched.
* **h5**: API client + UI per contract; BLE only through the bridge the contract names; feature
  flag for old native shells.

### 5.6 Synthesis checklist (`synthesis.md`)

The summary must contain:

1. Per role: outcome, repo, changed files count (protocol v2 list), tests the peer reported.
2. **Cross-stack consistency**, from the peers' reports and changed-file lists:
   endpoint paths and JSON field names match between `server` and each client; device command /
   event names, payload fields and units match between `device` and each app; error codes are
   handled on every consumer; version/flag gating is consistent.
   Each line: `consistent | mismatch: <what> | unknown: <role did not report it>`.
3. Contract deviations a peer reported, and which role must change.
4. Roles skipped or not sent, and why.
5. **Human-only follow-ups**: bench / real-device BLE test, app store or firmware release steps,
   server deploy order. Never call the feature done while any required role failed or a
   mismatch stands.

Skep's own tally (`describeOutcome`) is still included unchanged.

### 5.7 Scene questions the master should prefer

Source of truth for new state (device / server / both); offline behaviour; minimum device
software version; which clients are in scope this release; whether the existing BLE service is
reused or a new characteristic is needed (if new: "TBD by device role", never invented).

## 6. Orchestrator integration (how it fits D32)

| Area | Change | Wire change |
|---|---|---|
| `prompts.ts` | `refinePrompt` / `synthesisPrompt` take an optional `SkillContext`; `PROMPT_VERSION = 3`; `generic` produces byte-identical prompts to v2 except the version constant (snapshot test) | none |
| `core/orchestration/schemas.ts` | `RefineOutputSchema` additive: `contract?`, `targets[].role?` (exactly one of `repo`/`role`) | none |
| `core/orchestration/reducer.ts` | carry `skill` metadata and `contract` in state; MVP: `stage` per group and persisted stage progress (D36) | none |
| `orchestrator.ts` | resolve roles → repos via the binding before dispatch; prefix titles with `[skill · role]`; merge roles sharing a repo; record skill in the ledger | none |
| Ledger | `skill{id,version,scope,digest}`, `contract`, `bindings[]` per orchestration | — |
| Peer side | none in MVP (briefs are self-contained) | Phase 4: additive v2 `welcome.skill`, `peerIds` |

D32's guarantees are kept: read-only master turns, no self-dispatch, untrusted-data delimiters,
500K conversation cap. A new decision **D36 (Skills)** in `docs/ARCHITECTURE.md` should record:
skills are declarative prompt+structure bundles; scopes and trust; role binding; no wire change in
MVP; `generic` = v0.1.15 behavior. The non-shell start selection is stored only in the local
`session.json` so an attached master shell can inherit it; no session socket frame gains a skill field.

## 7. Website: skepagent.com makes this the main narrative

Design only. Implementation belongs to the separate site repo task (i18n keys in
`i18n/en.json` + `i18n/zh.json`). **Release gating:** the new hero ships with the Skep release that
contains `/skill` (proposed v0.2.0). Before that, the site may only preview it under a
"Coming in v0.2" label; it must not describe unreleased commands as available.

### 7.1 Page structure (top to bottom)

1. **Hero** — the IoT multi-stack story.
2. **Demo** — one feature, five roles (replaces the 3 generic peers).
3. **Skills / scenarios** — new section: featured `iot-ble-feature`, `generic`, custom skills.
4. **Quickstart** — three steps rewritten around `--skill` and `--role`.
5. **Features** ("What's in v0.2") — skills first, then the existing cards, condensed.
6. **Security** — softened, product-safe wording (§7.6), no longer a headline claim.

Nav: `Demo · Skills · Quickstart · Features · Security`.

### 7.2 Hero copy (EN, keys proposed)

| Key | EN copy |
|---|---|
| `hero.badge` | `@skepagent/skep v0.2 · Skills` |
| `hero.title` | `Ship one IoT feature across device, server and every app.` |
| `hero.lead` | `State the feature once. Skep's iot-ble-feature skill turns it into one shared contract and role briefs for your C++ device layer, HTTP API, iOS, Android and H5 agents — each working in its own repo, on its own machine.` |
| `hero.cmd` (copy box) | `skep` → `/start --skill iot-ble-feature` |
| `hero.start` | `See the workflow` (anchors to demo) |
| `hero.fineprint` | unchanged |

Alternative title for A/B: `One requirement. Five stacks. One live session.`

### 7.3 Demo: stage labels and topology

Topology SVG: master hive in the center-left, five peer hives labelled `device · C++`,
`server · HTTP API`, `ios`, `android`, `h5`. The existing `/orchestrate` mode toggle stays
(auto / confirm / off). Stage strip above the diagram, animated in order:

| Key | EN | Visual |
|---|---|---|
| `demo.stage.require` | `1 · Requirement` | master types the feature |
| `demo.stage.contract` | `2 · Shared contract` | a contract card appears on the master |
| `demo.stage.briefs` | `3 · Role briefs` | five "brief →" arrows, each tagged with the role |
| `demo.stage.build` | `4 · Parallel build` | peer progress bees |
| `demo.stage.check` | `5 · Cross-stack check` | "← summary" arrows; a check list: `API fields ✓  device commands ✓  android: mismatch` |
| `demo.title` | `One feature, every stack` | |
| `demo.sub` | `The master states the requirement; each role's agent gets a brief that fits its stack, built on the same contract.` | |
| `demo.log.joined` | `device, server, ios, android, h5 joined` (roles from --role) | |
| `demo.log.autoDispatch` | `contract drafted · 5 role briefs dispatched` | |
| `demo.log.confirmWait` | `contract + 5 role briefs ready, waiting for your confirm` | |
| `demo.log.summary` | `summary: 4 consistent · 1 mismatch to fix · bench test needed` | |

Log example (illustrative, not a metric):

```text
+ device, server, ios, android, h5 joined
→ skill iot-ble-feature · contract "auto-lock" rev 1
→ 5 role briefs dispatched
✓ server  POST /v1/locks/{id}/auto-lock     ✓ device  cmd SET_AUTO_LOCK
✓ ios     ✓ android   – h5 skipped (native-only)
✓ summary: API and device fields consistent · bench test on real hardware
```

### 7.4 "Skills" section (new)

| Key | EN |
|---|---|
| `skills.title` | `Skills: the right workflow for the job` |
| `skills.sub` | `A skill gives the master scene-fit prompts, roles and checks. Pick one with /skill use.` |
| `skills.iot.title` | `iot-ble-feature` · badge `Main workflow` |
| `skills.iot.body` | `C++ device layer, server HTTP API, iOS, Android, H5. One contract, role briefs, a cross-stack consistency check.` |
| `skills.generic.title` | `generic` |
| `skills.generic.body` | `Any repos, any split. Today's orchestrator, unchanged.` |
| `skills.custom.title` | `Your own` |
| `skills.custom.body` | `Put a skill in .skep/skills/ to share roles and prompts with your team.` |
| `skills.scope` | `Skep works on the software layer in your repos; hardware testing stays with your team.` |

### 7.5 Quickstart (rewritten)

1. **Start with a skill** — `/start --skill iot-ble-feature` on the master.
2. **Join each role** — `/join <code> <ip:port> --role server` (or `device`, `ios`, `android`,
   `h5`) in each checkout.
3. **State the feature** — type the requirement; review the contract and briefs with
   `/orchestrate confirm`, or let `auto` send them.

### 7.6 Security wording

Replace "Credentials never leave your device" as a headline with a smaller section:
`sec.title`: `Your logins stay with each device's agent`; `sec.body`: `Each device runs its own
agent with its own login. Skep does not actively detect, record, or upload your provider keys or
tokens, and a peer shares live output only if you opt in.` Update `meta.description` to the IoT
narrative and drop the absolute claim there too. (README line 8 has the same absolute claim;
align it in the README task.)

### 7.7 ZH notes

Keep identifiers, commands and role ids in English (`/skill use`, `iot-ble-feature`, `device`,
`server`, `ios`, `android`, `h5`, `H5`). Suggested ZH hero: `hero.title` = `一个 IoT 功能，设备端、
服务端与各端 App 一次协同交付。`; `hero.lead` = `只需描述一次需求。Skep 的 iot-ble-feature 技能会
生成一份共享接口契约，并为 C++ 设备层、HTTP 服务端、iOS、Android 和 H5 的智能体分别下发角色任务——
各自在自己的仓库、自己的机器上完成。`; "Skill" = `技能`, "contract" = `接口契约`, "role brief" =
`角色任务说明`, "cross-stack check" = `跨端一致性检查`. Security: `Skep 不会主动检测、记录或上传
相关密钥`. A native ZH reviewer signs off before launch.

## 8. Phased implementation plan

Rows in DEV-PLAN style. Each task stays inside its files (AGENTS.md rule 1); no new dependencies
(TOML parsing and Zod already exist: `parseTomlConfig`, `zod`).

### Phase 0 — decision (docs)

| ID | Files | Deliverable | Acceptance |
|---|---|---|---|
| SKILL-0 | `docs/ARCHITECTURE.md` (D36), this plan | Decision recorded, open questions §9 answered by the parent | D36 merged; Q1–Q4 resolved |

### Phase 1 — MVP (target v0.2.0)

| ID | Files (owner) | Deliverable | Acceptance (each → ≥1 test) |
|---|---|---|---|
| SKILL-1 | `src/core/skills/schemas.ts`, `src/core/skills/compose.ts` (+ tests) | Pure: manifest Zod schema (`skep.skill/v1`), stage DAG check, budget check, digest input, role binding function `bind(roles, peers, manual) → table`, prompt-section composer | strict schema rejects unknown keys / bad ids / cyclic `after` / missing role refs; binding precedence manual > role alias > repo glob; two candidates flagged; deterministic output |
| SKILL-2 | `src/skills/loader.ts`, `src/skills/trust.ts` (+ tests) | I/O: read packaged + user + project scopes with injected fs roots; shadowing; path containment; char caps; redaction check; trust store 0600 | temp-dir tests: shadowing order; `..`/symlink escape rejected; invalid skill listed with reason; project skill untrusted until trusted; digest change re-asks |
| SKILL-3 | `src/skills/packaged/*.ts` (+ tests) | Packaged skills (§5) and their TS module | direct TS sources (D36); both validate; `iot-ble-feature` has 5 roles, `device`+`server` required; snapshot of composed refine prompt |
| SKILL-4 | `src/orchestrator/prompts.ts`, `src/core/orchestration/schemas.ts`, `src/core/orchestration/reducer.ts`, `src/orchestrator/orchestrator.ts`, `ledger.ts` (+ tests) | Skill-aware refine/synthesis, `contract`, `targets[].role`, role → repo resolution, shared-repo merge, title prefix, ledger fields, `PROMPT_VERSION = 3` | `generic` prompt snapshot equals v2 apart from version; role target resolves to bound repo; unbound required role → dispatch refused with message; unbound optional role skipped and named in synthesis prompt; two roles one repo → one intent with two sections; contract placed first; ledger records skill+digest |
| SKILL-5 | `src/cli/shell/run.ts` (slash entries), `src/cli/shell/model.ts` (header chip, table render), `src/cli/commands/session.ts` (`--skill`) (+ tests) | `/skills`, `/skill`, `use/off/bind/unbind/show/trust`, `--default`, `/start --skill`, `skep session start --skill`, `mode_hint` line, picker skip | command tests per row of §4.1; `/orchestrate off` + skill prints inactive line and sends raw; `/intent` unchanged; persisted default read on next shell |
| SKILL-6 | `test/integration/skill-iot.test.ts` | End-to-end with loopback sockets and a fake master/peer agent: 4 peers joined with `--role`, one free-text feature → 4 role intents → synthesis with consistency section | passes in `npm test`; real CLI smoke stays manual (opt-in env) |
| DOCS-1 | `README.md` | Document skills and the IoT example without changing the generic quick start; softened credential wording | reviewed |
| SITE-1 | `site repo: index.html`, `i18n/en.json`, `i18n/zh.json`, `styles.css`, `app.js` | §7 structure and copy; five-role demo; skills section | ships only with the release containing SKILL-5; en/zh key parity check; no unreleased command shown as available |

Parallelism: SKILL-1 first; SKILL-2 and SKILL-3 in parallel on SKILL-1; SKILL-4 on SKILL-1 (+3 for
snapshots); SKILL-5 on SKILL-2/4; SKILL-6 last; SITE-1 copy can be drafted any time, merged at
release.

### Phase 2 — authoring and ergonomics

* `/skill fork`, `/skill new <id>` (scaffold), `skep skill lint <dir>` (validation + budget report).
* `/intent --role <role> <text>` raw intent to a bound role.
* `/history` filter by skill; synthesis "fix round": `/skill followup` re-briefs only roles named
  in a mismatch, reusing the same contract rev + 1.

### Phase 3 — staged dispatch (pulled into MVP by D36)

* Reducer: per-group `stage`; orchestration state `awaiting(stage k)` → next stage dispatch.
* Later-stage briefs get earlier-stage results (redacted summaries + changed-file lists, as
  untrusted data blocks) appended; contract revisions only by the master agent, shown in confirm.
* D36 supersedes this optional Phase 3 proposal: the packaged example sets `clients.after = ["providers"]` in MVP; no `--staged` switch is needed. Contract revision workflows remain future work.

### Phase 4 — protocol additions (v2, additive)

* `welcome.skill{id,version}` + echoed role so peer shells show their role and the active skill.
* `peerIds` on intents for monorepos with one peer per role (removes the merge fallback).
* Optional per-role peer-side guidance appended by the peer from its own installed skill copy
  (only when versions match).

### Later candidates (not designed here)

Other packaged scenes using the same model, e.g. `web-fullstack-feature` (API + web + mobile),
`sdk-release` (library + samples + docs). Each is a data bundle; no new code paths.

## 9. Open questions and risks

| # | Question / risk | Recommendation |
|---|---|---|
| Q1 | Packaged skills as TS module (no config change) vs `skills/` in `package.json` `files` | **Locked D36:** direct TS modules only; no packaged directory or generator |
| Q2 | Should `iot-ble-feature` become the CLI **default** skill? | **Locked D36:** `generic` stays the CLI default; `iot-ble-feature` is an example selected explicitly |
| Q3 | Contract size vs v1 peers (4000 chars) | **Locked D36:** contract first, ≤3000 chars, warn on v1 peers |
| Q4 | One wave (contract-first) vs staged dispatch in MVP | **Locked D36:** honor stage `after` dependencies in MVP; no/empty stages remain single wave |
| R1 | Master agent invents BLE UUIDs, opcodes or field layouts not in the code | `master.md` + contract skeleton say "TBD by device role" when unknown; device brief keeps existing identifiers; synthesis flags contract deviations |
| R2 | Agents drift from the contract | Every brief embeds the same contract verbatim; peers must report deviations; synthesis consistency lines. Skep cannot *verify* code-level consistency in MVP; it reports what peers say plus changed-file lists, and says "unknown" otherwise |
| R3 | Prompt injection via a project skill from a cloned repo | Trust per digest; read-only master; `confirm` shows briefs; skills cannot alter flags/approvals (D29, D32) |
| R4 | Role binding ambiguity (two peers, same role or repo) | Earliest-joined + visible `(2 candidates)` + `/skill bind`; Phase 4 `peerIds` |
| R5 | Website over-claims (hardware expertise, unreleased features, metrics) | `skills.scope` line; release gating; demo log marked illustrative; no numbers |
| R6 | Prompt budget growth (skill text + peers + answers) in the 500K conversation | ≤16 000 chars skill text per refine, validated; existing 500K re-seed rule applies |
| R7 | Monorepo teams (ios+android in one repo) get merged briefs | Documented MVP limit; Phase 4 per-peer targeting |
| R8 | Naming clash with `agent-guide/SKILL.md` | Manifest named `skill.toml`; docs call the other file "agent guide" |
| R9 | H5 BLE support varies (Web Bluetooth availability, native bridges) | Contract must name the BLE path for H5 or mark H5 API-only; no default assumption |
