# AGENTS.md — conventions for coding agents

You are implementing one task from `docs/DEV-PLAN.md` in your own git worktree/branch. Other
agents are implementing other tasks in parallel. Read your task row (and brief, if any), then
`docs/ARCHITECTURE.md` sections it references. The PRD (`docs/PRD-v0.4.md`) is the normative
source when in doubt.

## Commands

```bash
npm ci                         # first thing in a fresh worktree
npx vitest run <path>          # focused tests while working
npm test                       # full test suite (must pass before you finish)
npm run lint                   # biome check + tsc --noEmit (must pass before you finish)
npm run fix                    # auto-fix formatting/import order
npm run build                  # tsc emit to dist/ (sanity check)
```

## Rules

1. **Stay inside your task's files.** Only create/modify the files listed for your task (plus
   colocated `*.test.ts` and test helpers you own). Do not edit files owned by other tasks, shared
   contracts in `src/core/**` (unless your task owns them), `package.json`, or configs. If a
   contract seems wrong, implement against it and explain the problem in your final commit message.
2. **No new dependencies** unless your task says so.
3. **Run tests before finishing:** `npm run lint && npm test` must be green.
4. **Commit on your branch** (never on `main`, never push, never add remotes). Small, focused
   commits are fine; the last one must leave the tree green.
5. Do not modify anything outside the repository.

## Code style

* TypeScript strict, ESM. Relative imports **must** end in `.js` (`import { x } from "./foo.js"`).
  Use `import type` for type-only imports.
* Formatting/linting by Biome (2-space indent, double quotes, semicolons, trailing commas, 100
  cols). Run `npm run fix` rather than formatting by hand.
* `src/core/**` is **pure**: no `fs`, `child_process`, network, `Date.now()`, `Math.random()`,
  `process.env`. Everything else takes I/O dependencies (GitRunner, Clock, RandomSource,
  RuntimeBackend, CodeHost) as constructor/function parameters so the simulator can inject fakes.
* Never call `Date.now()`, `performance.now()`, `setTimeout` for protocol timing — use the injected
  `Clock` (`src/util/clock.ts`). Never use `Math.random()` — use `RandomSource`.
* Subprocesses: `execFile`/`spawn` with `shell: false` only. Never build shell strings.
* Validate every external input (files, model output, socket frames) with the Zod schemas in
  `src/core/schemas`. Protocol objects are strict (unknown keys rejected).
* Reducer state is plain JSON (no Map/Set/Date/undefined) and must be deterministic.
* Errors: throw typed `Error` subclasses with actionable messages; no silent catches.
* Comments explain *why* (and cite PRD/ARCHITECTURE sections for protocol rules), not *what*.
* All text is English (code, comments, docs, commit messages, event content).

## Tests

* Vitest. Unit tests colocated as `foo.test.ts`; cross-module tests in `test/integration/`.
* Tests must not touch `~/.skep` or the real network: use temp dirs (`SKEP_HOME`), local bare
  repos, and fake adapters. Real agent CLIs only behind opt-in env vars (e.g. `SKEP_REAL_CODEX=1`).
* Pure reducer tests build logs with `test/helpers/log-builder.ts`.
* Each acceptance criterion in your task should map to at least one test.

## Commit messages

Conventional style, imperative, ≤ 72-char subject, task ID in the subject:

```text
feat(reducer): implement structural rules and replay (SK-101)

Body: what and why, notable decisions, anything left for later.
```

Types: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`.
