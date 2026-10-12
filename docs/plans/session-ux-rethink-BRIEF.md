# Session UX rethink: implementer brief

Read `session-ux-rethink.md` for rationale. This is the short version.

**Goal.** `/start` → peer `/join` → `/intent …` works with no cleanup, no AGENT.md, no git
vocabulary. Skep does dispatch, progress, and result aggregation. Nothing else.

**Four rules**

1. No worktrees/clones/session branches for items. The agent runs in the peer's project root.
2. No AGENT.md requirement. Agent = `--agent <cli>` > `/agent` > `SKEP_AGENT_CLI` > (AGENT.md if
   present) > auto-detect on PATH > **fail at `/join`**.
3. Never fake success. Remove the dry-run marker commit; a missing agent is an error.
4. Errors are shown whole: wrap error/warn lines, one cause + one fix.

**Don't change:** session wire/schemas, routing, bee, per-project homes, SAME-CB, redaction.

**Result the master prints:** `I-N done · <device> (<repo>) · <cli> · <time>`, changed files with
`+/−`, agent summary. Failures say what to do on the peer.

**Starts here:** `materializeItem` / `runItem` / `executeItem` / `agentCliOf` / `selectAgentView`
in `src/cli/commands/session.ts`; scrollback truncation in `src/cli/shell/model.ts`.

**Superseded, do not continue:** `fix/auto-detect-session-agent`, worktree-reuse/collision fixes.

**Do not** `npm publish` or bump the version; bump only after review of the MVP.
