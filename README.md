# Skep

Cross-device, decentralized collaboration for AI coding agents. A per-device daemon (`skepd`)
and a CLI (`skep`) let coding agents on several machines work as a small team, coordinating
through a signed, linear git "blackboard" whose `main` branch is an event log replayed by a
deterministic reducer.

> **Status:** MVP under construction. The protocol schemas and contracts are frozen in
> `src/core`; most runtime modules are being built per `docs/DEV-PLAN.md`.

## Documents

| Doc | What |
|---|---|
| [`docs/PRD-v0.4.md`](docs/PRD-v0.4.md) | Product requirements (normative) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Stack, modules, event schema, reducer, leases, git write path, adapters, sim harness, tests |
| [`docs/DEV-PLAN.md`](docs/DEV-PLAN.md) | MVP task breakdown in parallelizable waves |
| [`AGENTS.md`](AGENTS.md) | Conventions for coding agents working in this repo |

## Requirements

* Node.js ≥ 22.12 and npm
* `git` ≥ 2.34 and OpenSSH `ssh-keygen` (SSH commit signing)
* At runtime (later waves): `gh`, `gitleaks`, a pinned agent CLI (Codex in the MVP)

## Development

```bash
npm ci              # install exact dependencies
npm test            # vitest (unit + integration)
npm run lint        # biome check + tsc --noEmit
npm run fix         # biome auto-fix + format
npm run build       # emit dist/
npm run skep -- --help   # run the CLI from source
```

## Layout (short)

```text
src/core      pure protocol: ids, schemas (Zod), reducer — no I/O
src/git       git runner, SSH signing/verification, log reader
src/blackboard publisher (fetch→reset→recompute→push), sync, heartbeats
src/exec      worktrees, checks, journal, evidence, attempt pipeline
src/adapter   agent CLI adapters (Codex MVP)
src/daemon    skepd tick loop
src/cli       skep commands
src/sim       deterministic simulation harness
```

See `docs/ARCHITECTURE.md` §2 for the full tree.
