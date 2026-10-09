# Skep

**Cross-device, decentralized collaboration for AI coding agents.**

Skep lets AI coding agents running on different machines (a laptop, an always-on server, a
build box with special tooling) work together as a small, accountable team. They coordinate
through a **signed git "blackboard"**: an ordinary git repository whose `main` branch is a
linear, SSH-signed event log. A per-device daemon (`skepd`) replays that log with a
deterministic reducer, plans and executes work through a local agent CLI, and publishes results
as stacked pull requests. The human stays in charge through a CLI (`skep`): you create tasks,
approve plans, resolve escalations and merge. There is no central server; any git host works.

Website: [skepagent.com](https://skepagent.com)

> [!NOTE]
> **Project status: v0.1.1 (session TUI on the v0.1.0 MVP), still early.** Bare `skep` opens the
> local agent. `skep ui` and `skep session join --ui` are the session screen (peers, item, agent
> state, redacted tail, submit choice). The signed blackboard, reducer, daemon and stacked
> delivery from v0.1.0 are still here. The real two-device acceptance run (**SK-609**) has
> **not** been done — the user waived it for v0.1.0. Expect breaking changes while 0.x. See
> [`docs/RELEASE.md`](docs/RELEASE.md) and [`docs/DEV-PLAN.md`](docs/DEV-PLAN.md).

## What Skep never does

> **Hard rule (D19):** **Skep never transports, stores, syncs or brokers provider credentials,
> API keys or provider configurations between devices, in any form: not as plaintext, not as
> ciphertext, not as a hash, and not as a label.** Each device's agent CLIs are configured
> locally by the human on that device; Skep neither reads nor records that configuration.
>
> **No inbound connectivity (D18):** no Skep feature requires device-to-device reachability, a
> mesh VPN or a fixed IP. Devices never connect to each other. Each `skepd` makes outbound
> connections to the hosted git remote (the only rendezvous and authority) and, optionally, one
> wake-up hint channel. Tailscale or SSH are human conveniences, never dependencies.
>
> Skep also never auto-merges. The human holds plan approval, lease revocation, escalation
> decisions and merges.

## Install

npm registry publish of `@skepagent/skep` is **deferred** (org `skepagent` may not exist yet).
Until then, install from the git tag or clone and build.

```bash
# from the v0.1.1 tag (bins: skep, skepd)
npm install -g github:Guxiaodong941005/skepAgent#v0.1.1
```

```bash
git clone https://github.com/Guxiaodong941005/skepAgent.git
cd skepAgent
git checkout v0.1.1
npm ci
npm run build
# put dist/bin/skep.js and dist/bin/skepd.js on PATH, or npm link
```

## Quickstart

Prerequisites on **each** device:

* Node.js **≥ 22.12** and npm
* `git` ≥ 2.34 (SSH signing)
* OpenSSH `ssh-keygen` ≥ 8.9 (`-Y sign/verify`)
* `gh`, `gitleaks`
* the pinned agent CLI (Codex in this MVP), **installed and logged in locally** on that device
  (D19 — Skep will not copy the login)

Then, following [`docs/RUNBOOK.md`](docs/RUNBOOK.md):

1. Create an empty **private** blackboard git repo (no README; genesis must be the root commit).
2. On each device, run `skep init` (generates the daemon key and prints an `allowed_signers`
   line). Compare fingerprints out of band and install the local trust root.
3. On the controller, `skep init --genesis` to write the signed genesis commit.
4. Run `skepd` as a service (`deploy/skepd.service` or `deploy/com.skepagent.skepd.plist`).
5. `skep doctor` on each device, then:

   ```bash
   skep task new "…" --repo <allowlist-name> --owner <agent>
   skep plan approve <task>
   skep status
   ```

The runbook covers trust setup, revoke, re-genesis, Mac vs Linux homes, and `--socket-group`.

On one machine, with an agent CLI already logged in locally:

```bash
skep                  # no subcommand: open claude, else codex, else pi
skep session start    # master for a multi-device session
skep ui               # full-screen session view (a sub uses `skep session join --ui`)
```

The agent keeps its own TUI. Skep does not copy that login to any other device (D19).

## Why

Coding agents are good at working alone in one checkout on one machine. Real work often spans
machines: one device has the GPU, another has Xcode, a third is always on while your laptop
sleeps. Today, coordinating agents across devices means copy-pasting between terminals or
trusting a hosted orchestrator with your code and credentials.

Skep takes a different approach:

* **No coordinator to run or trust.** Coordination state lives in a git repository you already
  know how to host, back up and audit.
* **Deterministic code enforces the protocol; models only produce content.** Agents propose plans,
  reviews and code. Daemons validate, authorize, sequence, test, sign and publish.
* **The human holds the important gates:** task creation, plan approval, lease revocation,
  escalation decisions and merges.
* **Single-agent fast path by default.** Team mode (several work items, one peer review, leases on
  different devices, stacked PRs) only when the task needs it.

## Key ideas

* **Signed, linear event log.** Every state change is one JSON event file added in one commit on
  `main`, signed with an SSH key. Each device verifies signatures against its **local** trust root
  (`allowed_signers`); unsigned, forged or malformed commits are recorded as no-ops and raise an
  alarm. Writers never rebase: they fetch, reset, recompute and push.
* **Deterministic reducer.** A pure function folds the log into state. Two devices at the same tip
  compute byte-identical state, so they agree on who owns what without talking to each other.
  Events carry preconditions (`task_rev`, `owner_gen`, `plan_hash`, `expected_epoch`) for audit and
  defence in depth.
* **Epoch-fenced leases.** A work item is claimed by an event that bumps its epoch. Every
  downstream event and code branch is fenced by that epoch, so a device that wakes from sleep
  after its lease was revoked can never deliver stale work.
* **Simulation first.** A deterministic simulation harness (seeded RNG, virtual clocks with skew
  and suspend, fault-injecting git, crash points) exercises the protocol and checks invariants
  before any real agent runs.

## Architecture at a glance

```text
 human ──► skep (CLI) ──unix socket──► skepd (one per device)
                                         ├─ sync: fetch blackboard → reducer → state
                                         ├─ publisher: single writer, signed commits
                                         ├─ heartbeats: hb/<agent> refs
                                         └─ slots: plan · review · claim · execute
                                               └─ agent CLI (e.g. Codex) in a worktree
                                                     └─ checks → push → stacked PR

 blackboard repo (main = signed event log) ◄──────► every device's skepd
 code repo (branches, PRs)                 ◄──────► executing devices
```

* [`docs/PRD-v0.4.md`](docs/PRD-v0.4.md): product requirements (normative).
* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): module layout, event schema, reducer, leases,
  git write path, adapters, simulation harness, decisions log (including D18 and D19).
* [`docs/DEV-PLAN.md`](docs/DEV-PLAN.md): MVP task breakdown in parallelizable waves, with status.
* [`docs/RUNBOOK.md`](docs/RUNBOOK.md): install, trust, revoke, re-genesis, service units.
* [`docs/RELEASE.md`](docs/RELEASE.md): package-name decision, v0.1.0 checklist, v0.1.1 notes.

## Developer quickstart

Requirements:

* Node.js **≥ 22.12** and npm
* `git` ≥ 2.34 and OpenSSH `ssh-keygen` (used by the SSH signing tests)

```bash
git clone https://github.com/Guxiaodong941005/skepAgent.git
cd skepAgent
npm ci                   # install exact dependencies
npm test                 # unit + integration tests (Vitest)
npm run lint             # Biome + tsc --noEmit
npm run build            # emit dist/
npm run skep -- --help   # run the CLI from source
```

`npm run fix` applies Biome formatting and import ordering. Tests never touch `~/.skep` or the
network; they use temp directories, local bare repositories and fake adapters.

`skep sim run` needs the fixture keys under `test/fixtures/keys/` (a git checkout). Those files
are not in the npm pack.

## Repository layout

```text
src/
  core/        pure protocol: IDs, Zod schemas, canonical JSON, reducer (no I/O)
  util/        clock, randomness, backoff, process and fs helpers
  git/         git runner, trust root, SSH signer, commit builder, signature verification
  blackboard/  clone, publisher write loop, sync, heartbeats, liveness
  lease/       re-verification before delivery, suspend detection
  exec/        worktrees, trusted checks, run journal, evidence, attempt pipeline
  adapter/     agent CLI adapters and structured output
  runtime/     process backends (native, PTY, optional herdr)
  session/     in-memory master/sub session protocol
  codehost/    code host interface (GitHub via gh, in-memory fake)
  daemon/      skepd tick loop and duties
  ipc/         CLI ↔ daemon socket protocol
  cli/         skep commands, including the session TUI
  config/      paths, device.toml, AGENT.md
  sim/         deterministic simulation harness
  bin/         skep and skepd entry points
test/
  helpers/     log builder, git fixtures
  integration/ cross-module tests
docs/          PRD, architecture, dev plan, runbook, release notes, reviews
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2 for the full tree.

## Contributing

Contributions are welcome, including AI-assisted ones. Please read
[`CONTRIBUTING.md`](CONTRIBUTING.md) first; coding agents should also read
[`AGENTS.md`](AGENTS.md). Report security issues privately as described in CONTRIBUTING.md, not
in public issues.

## License

[MIT](LICENSE) © Skep contributors
