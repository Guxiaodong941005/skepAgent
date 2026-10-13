# Spike: master agent CLIs, terminal scrolling, herdr (SCROLL/ORCH Phase 0)

Plan: `docs/plans/tui-scroll-and-herdr-controller.md` (§3.4, §5.2, §7 Phase 0). Run on
2026-10-13 on Linux (Debian, kernel 6.1), Node v22.23.3, in a throwaway git repo under `/tmp`.
Every turn below was a real model call; prompts were two-line probes ("remember the codeword
PLUM" → "what was the codeword?"), so the latency numbers are floors, not refine/synthesis
estimates.

## 1. Versions tested

| CLI | Version | Note |
| --- | --- | --- |
| claude | `2.1.296 (Claude Code)` | model reported `claude-opus-5-5`, context window 1 000 000 |
| codex | `codex-cli 0.160.0` | same pin as `docs/spikes/adapter-codex.md` |
| pi | `1.0.2` | provider/model from the device's own pi config |
| herdr | `herdr 0.9.3` | `herdr api schema --json` → `protocol: 22`, `schema_version: 1` |

## 2. Pinned argv per CLI (master agent, read-only, resumable)

All calls: `execFile`/`spawn` with `shell: false`, prompt on **stdin**, cwd = the master's project
root, sanitized env (D19). Skep chooses the conversation id itself where the CLI allows it, so
nothing has to be scraped from output before the second turn.

### claude

```text
first turn:  claude -p --output-format json --session-id <uuid> \
               --permission-mode plan --tools Read,Grep,Glob
later turns: claude -p --output-format json --resume <uuid> \
               --permission-mode plan --tools Read,Grep,Glob
```

* stdout is one JSON object: `type: "result"`, `subtype: "success"`, `is_error`, `result` (the
  reply text), `session_id` (equals the `<uuid>` Skep passed), `duration_ms`, `num_turns`,
  `usage`, `total_cost_usd`. Parse with a Zod schema that ignores unknown keys (vendor output,
  not a protocol object) and requires `type`, `is_error`, `result`, `session_id`.
* **Resume verified:** turn 2 answered `PLUM`; `session_id` unchanged.
* `--session-id <uuid>` a second time fails with exit 1 and `Error: Session ID … is already in
  use.` → the adapter must switch to `--resume` after the first successful turn (and must use a
  fresh uuid after a failed first turn it cannot prove was not recorded: re-try with `--resume`
  first, then a new uuid).
* **Read-only verified:** with `--permission-mode plan --tools Read,Grep,Glob` an explicit
  request to create a file was refused; no file appeared. The tool allow-list is the hard guard
  (no Write/Edit/Bash exist in the session); plan mode is defense in depth.
* Latency (probe turns, wall clock incl. startup): ~3–7 s.

### codex

```text
first turn:  codex exec --json --sandbox read-only --skip-git-repo-check -o <file> -
later turns: codex exec resume --json -c sandbox_mode="read-only" --skip-git-repo-check \
               -o <file> <thread-id> -
```

* stdout is JSONL. The first event is `{"type":"thread.started","thread_id":"<uuid>"}` → the
  conversation id. The reply is the last `item.completed` with `item.type == "agent_message"`
  (`item.text`); `-o <file>` additionally writes the last message to a file, which is the
  simplest reliable read. `turn.completed` carries `usage`.
* Codex chooses the id; Skep captures it from `thread.started` on the first turn.
* **Resume verified:** `codex exec resume … <thread-id> -` answered `PLUM`; the same `thread_id`
  is re-announced.
* `codex exec resume` has **no `--sandbox` flag** in 0.160.0; `-c sandbox_mode="read-only"` is
  the equivalent override and must be passed on every resumed turn.
* **Read-only verified:** asked to create a file with a shell command, codex reported "the
  filesystem is read-only"; no file appeared.
* `--skip-git-repo-check` is only needed outside a git repo; harmless inside one.
* Latency: ~3.5–5 s.

### pi

```text
every turn:  pi -p --mode json --session-id <uuid> --tools read,grep,find,ls
```

* `--session-id <id>` "uses the exact project session id, creating it if missing", so the
  **same argv** serves the first and later turns (first turn prints a warning on stderr:
  `No project session found with id …; creating a new session with that id.` — expected, not an
  error).
* stdout (JSONL) starts with `{"type":"session","id":"<uuid>",…}` and ends with `agent_end`
  (carrying `messages`) then `agent_settled`. The reply is the text content of the last
  `assistant` message in `agent_end.messages`. `--mode text` (default) prints only the reply and
  is an acceptable fallback.
* **Resume verified:** turn 2 answered `PLUM`.
* **Read-only verified:** with `--tools read,grep,find,ls` pi stated it has no write tool; no
  file appeared.
* Latency: ~2–3 s.

### Common decisions

| Capability | claude | codex | pi |
| --- | --- | --- | --- |
| Non-interactive turn, stdin prompt | yes (`-p`) | yes (`exec -`) | yes (`-p`) |
| Machine-readable output | JSON object | JSONL events (+ `-o` file) | JSONL events |
| Conversation id | chosen by Skep (`--session-id`) | chosen by codex (`thread.started`) | chosen by Skep (`--session-id`) |
| Resume by id | `--resume <id>` | `exec resume <id> -` | same `--session-id <id>` |
| Read-only | tool allow-list + plan mode | `--sandbox read-only` / `-c sandbox_mode=…` | tool allow-list |
| Verified write refused | yes | yes | yes |

* **All three support resume**, so v1 supports all three as master agents (locked decision
  §9.4) without falling back to ledger re-seeding in the normal case. Ledger re-seed stays for
  resume failures and for the 500K same-session cap (locked decision §9.3).
* **Timeout/abort:** none of the three needs a TTY in these modes; the adapter spawns with
  `detached: true` and kills the process group on timeout/abort through the injected `Clock`
  (the same pattern `runNative`/SK-207 use). Skep never re-sends a turn after an ambiguous
  timeout without resuming first (herdr's "do not blindly submit again" rule).
* **Post-turn guard:** the CLI-level read-only modes all held, but the plan's `git status
  --porcelain` diff after each turn stays: it is the only guard that does not depend on vendor
  flags staying stable.

## 3. Terminal matrix (scrolling)

Not measurable in this headless environment (no iTerm2/Terminal.app/kitty/WezTerm/Windows
Terminal here). The decoder is therefore written to accept every encoding the plan lists, taken
from xterm's control-sequence reference, instead of relying on per-terminal observation:

| Key | Accepted sequences |
| --- | --- |
| PgUp / PgDn | `CSI 5 ~` / `CSI 6 ~`, with modifiers `CSI 5 ; m ~` (Shift = 2, Ctrl = 5) |
| Home / End | `CSI H`, `CSI F`, `SS3 H`, `SS3 F`, `CSI 1 ~`, `CSI 4 ~`, `CSI 7 ~`, `CSI 8 ~`, modified `CSI 1 ; m H` / `F` |
| Arrows | `CSI A`/`B`, `SS3 A`/`B`, modified `CSI 1 ; m A`/`B` |
| Wheel | alternate-scroll mode `CSI ? 1007 h` turns the wheel into arrow keys in the alternate screen (xterm, VTE, kitty, WezTerm, iTerm2 honour it; tmux forwards arrows when its own mouse mode is off); opt-in SGR mouse `CSI ? 1000 h CSI ? 1006 h` decodes `CSI < 64 ; x ; y M` (up) / `65` (down) |

Known caveats to verify by hand before release (RUNBOOK item, not a blocker): Terminal.app sends
Shift+PgUp to its own scrollback unless "scroll alternate screen" is set; tmux with
`mouse on` consumes wheel events itself.

## 4. herdr

* Pinned tag **v0.9.3** (the installed binary). `LICENSE` at
  `https://raw.githubusercontent.com/ogulcancelik/herdr/v0.9.3/LICENSE` is **Apache License
  2.0**. The GitHub license API did not answer from this sandbox; the file at the tag is the
  authoritative check the plan asked for.
* `herdr api schema --json`: `protocol 22`, `schema_version 1` — identical to what SK-620's client
  (`fdeebae`, `src/runtime/herdr.ts`) was verified against, so the client and its fixtures
  (`test/fixtures/herdr/*.json`) can be restored as-is in Phase 3 and re-verified there.
* Decision unchanged: option (C) executed as (A) first; nothing vendored.

## 5. Decisions drafted for ARCHITECTURE (inserted by ORCH-0)

* **D32 (draft) — master agent, Skep-driven (T1).** Free text in the master shell is refined by
  the master device's own agent CLI (claude, codex or pi, resolved like `/join`), dispatched as
  an ordinary intent, and the settled results are synthesized by the same agent conversation.
  Master-agent turns are read-only (CLI read-only modes above plus a post-turn `git status`
  check), run one process per turn with the conversation resumed by id, and never dispatch by
  themselves. One conversation per shell session, capped at 500 000 characters of Skep-supplied
  context, then re-seeded from the ledger. Default mode `auto`; `confirm` and `off` remain.
  Rationale: herdr's controller loop without giving an agent fan-out power; deterministic,
  testable with fake CLIs.
* **D33 (draft) — shell transcript.** The unified shell keeps everything a session showed in an
  in-memory transcript (all tones wrap; no entry-count cap) up to 500 000 characters, then
  evicts the oldest entries behind a visible marker. It is not persisted across sessions. The
  viewport is pinned by entry, scrolls by keys and alternate-scroll wheel, and full SGR mouse
  capture is opt-in so native selection keeps working. Amends D30's wording: the shell, not only
  `skep ui`, is a scrolling control screen; it still does not multiplex terminals.

## 6. Where the plan changes

* §3.4 argv: replaced "expected" flags with the verified ones above (codex resume uses
  `-c sandbox_mode`; pi uses one argv for every turn; claude switches from `--session-id` to
  `--resume`).
* §7 Phase 0 terminal matrix: covered by a superset decoder plus a manual RUNBOOK check, because
  no GUI terminals are available to the spike.
