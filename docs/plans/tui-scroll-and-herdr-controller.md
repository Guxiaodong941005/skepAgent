# Plan: TUI scrollback + herdr-style master controller (SCROLL / ORCH)

Status: **decisions locked (2026-10-13); Phases 0–2 implemented, Phase 3 rescoped and in
progress.** The parent answered every open question in §9; those answers are normative and are
applied throughout this document. Phase 0 is done (`spike/master-agent-cli`,
`docs/spikes/master-agent-cli.md`), Phase 1 is done on `feat/tui-scroll` (SCROLL-1..3,
S2/S3/S8), Phase 2 v1 is done on `feat/master-orchestrator` (ORCH-0..4, branched from
`feat/tui-scroll`). Phase 3 was rewritten around the human's split-panel multi-peer joint-debug
ask (§0 item 3, §7, §9 questions 6–8) and runs on `feat/orchestrator-multipeer` (branched from
`feat/master-orchestrator` @ `0693085`). Not merged, no version bump, no tag and no publish from
these branches (§10). Written against `main` @ `cebee66` (v0.1.13).

Implementation notes (where the code differs from the text below, the code and this list win):

* No `onIntentChanged` master callback (§3.6): the existing `item-*`/`intent-*` master events,
  the 250 ms tick and the external-status probe already signal every change, so the
  orchestrator polls on those and `MasterOptions` stays as it was.
* `SKEP_ORCHESTRATE=auto|confirm|off` overrides `[orchestrate] mode` per process (scripts,
  tests). `/cancel <O-n>` stops an orchestration on this side (its intent keeps running).
* Confirm mode asks in the input line (`enter` send, `e` edit as one line, `n` cancel) rather
  than binding Esc; Ctrl+C on the question also cancels.
* `/top` and `/bottom` exist; `/find` moves to Phase 3 ORCH-5 (panels), `/expand` to ORCH-7.
* A master agent turn that fails with a non-zero exit while a conversation exists is retried
  once in a fresh, ledger-seeded conversation; a timeout or unreadable output is not retried.
* ORCH-5 (done): panels are filtered views of the one transcript (D34). The main panel title
  is `main` (`/focus master` also works); `skep ui` keeps its single-agent screen. Split layout
  applies only while a session is live; without one the shell draws the single view.

Locked decisions in one line each (§9 has the verbatim answers):

* Default orchestration mode is **auto**; `confirm` and `off` remain available.
* S8 is fixed **inside the larger Phase 1/2 change**, not as a standalone patch release.
* Transcript retention: **same session keeps context, max 500K** (§3.7, §5.1, §5.3).
* Master agent CLIs for v1: **claude, codex and pi**.
* Phase 3 wire / session protocol v2: **accepted** (still negotiated, §3.6).
* Phase 3 panels: remote peer **live output is off by default**, opt-in only; key information
  (phase, progress line, blocked notices, results) always flows.
* Phase 3: **no per-peer follow-up from a panel** for now; input always goes to the master.
* Phase 3: **no real herdr split screen**, not even on one machine; Skep's own panels only.
* ORCH-6: `/share-output on` lasts for the **current session only**; live output is **≤20 lines
  / 2 KB per frame, at most once per 500 ms**; the **changed-files list** joins the key
  information that always reaches the master (§9.9–§9.11).

Normative sources: `docs/PRD-v0.4.md` (product), `docs/ARCHITECTURE.md` (D27–D31 especially),
prior plans `unified-tui-shell.md`, `tui-session-reliability.md`, `session-ux-rethink.md`,
`intent-peer-pick.md`, `peer-progress-bee.md`.

---

## 0. The ask (preserved, not reduced)

The human asked for two things. Both are in scope; neither is shrunk into a smaller feature.

1. **The TUI must scroll.** Today it shows one screen of information, the page cannot load
   earlier messages, and a lot of content is cut off or incomplete.
2. **A herdr-style controller across devices.** When the master sends an intent and a peer
   works on it:
   1. the human's question first goes through the **master's current agent**;
   2. the master agent's refined, organized problem goes to the **peer agent**;
   3. when the peer finishes, the result goes back to the **master agent** to read;
   4. the master agent combines it with the **original master-agent context** and produces a
      **final summary shown to the user**.

   Overall the interaction should feel like **herdr**: a main controller drives other peers'
   agents. Skep additionally supports cross-terminal / cross-device calls. Integrating
   open-source herdr code is on the table and is evaluated in §4.
3. **Split-panel multi-peer joint debugging (Phase 3, asked 2026-10-13).** Verbatim: 「关于
   Phase 3 ，我是想根据 herdr 分panel 的方式。来进行多peer 联调。 herdr 是开源的，可以参考它的代码，
   自己实现么？」 — "For Phase 3, I want multi-peer joint debugging in the herdr split-panel style.
   herdr is open source — can we reference its code and implement it ourselves?" Answer: yes, as
   a TypeScript reimplementation of the UX in Skep's own TUI (herdr is Apache-2.0 at v0.9.3 and
   HEAD; no code is copied, §4). The scope decisions are §9 questions 6–8; the work is §7
   Phase 3.

---

## 1. Where things stand (facts from the code)

### 1.1 Which screen is "the TUI"

| Entry | Code | Scrolls? |
| --- | --- | --- |
| `skep` / `skep tui`-less default: the unified shell | `src/cli/shell/run.ts` (`Shell`), `src/cli/shell/model.ts` (`ShellModel`) | Partly: PgUp/PgDn only |
| `skep ui`, `skep session join --ui` (D30 control screen) | `src/cli/tui.ts` (`TuiModel`, `Tui`, `TuiJoinView`), `src/cli/commands/ui.ts` | No |
| `skep tui` (raw agent TUI escape hatch) | `src/cli/commands/agent-tui.ts` | n/a (agent's own UI) |

Both Skep screens render through `Screen` (`src/cli/tui.ts:268`): alternate screen
(`?1049h`), raw mode, **full redraw** with `ESC[H ESC[2J` on every frame (`Screen.draw`,
`tui.ts:321`). The alternate screen disables the terminal emulator's own scrollback, so anything
Skep does not keep and render itself is gone from the user's point of view.

### 1.2 Why the shell "only shows one screen" and content is "cut off"

Concrete causes, each of which Phase 1 removes:

| # | Symptom | Cause | Where |
| --- | --- | --- | --- |
| S1 | Long lines end in `…` | Only `warn`/`error` tones wrap; `info`/`event`/`muted` lines are cut to one row | `WRAPPED_TONES`, `ShellModel.entryRows` (`model.ts:38`, `model.ts:182`); final `truncate`/`fitSpans` in `frame()` (`model.ts:175`) |
| S2 | A peer's result shows only a few lines | `scrollbackSummary` caps an accepted result at 8 lines / 600 chars before it reaches the shell | `SCROLLBACK_SUMMARY_LINES/CHARS`, `scrollbackSummary` (`src/session/master.ts:46–70`), used by `itemBlock` → `item-result` event → `Shell.masterEvent` (`run.ts:787`) |
| S3 | Agent output on the peer has gaps / only the end | `JoinViewModel.tail` is a sliding window of at most 4000 chars; `ShellJoinView.newTailLines` re-syncs on the last seen line, so anything that scrolled out of the window between two updates is lost. A native run (`claude -p`, `codex exec -`) delivers its output only at exit, so the shell sees only the last 4000 chars | `JoinViewModel.tail` (`commands/session.ts:1019`), `ShellJoinView.newTailLines` (`run.ts:1328`), `runNative` (`session.ts:1322`) |
| S4 | Earlier messages vanish | In-memory ring of 1000 entries, dropped forever; nothing is persisted, so quitting the shell loses everything | `SCROLLBACK_CAP` (`model.ts:27`), `ShellModel.append` (`model.ts:94`) |
| S5 | "Can't scroll up" in many terminals | Only `ESC[5~`/`ESC[6~` are decoded. No Shift+PgUp, Home/End, Ctrl+arrows, no mouse wheel; wheel events in alt-screen arrive as Up/Down (alternate-scroll mode) which the shell spends on the slash menu or ignores. Page step is a fixed 10 rows, not the viewport height | `csiKey` (`src/cli/shell/input.ts`), `PAGE_LINES` (`run.ts:70`), `Shell.onKey` (`run.ts:239`) |
| S6 | No sign that there is more above/below | No "N more above" / "N new below" indicator; Enter silently snaps to the bottom | `ShellModel.frame`, `Shell.onEnter` (`run.ts:356`) |
| S7 | `skep ui` output pane is a fixed tail | `TuiModel.frame` shows `tail.slice(-room)` with a "last N of M" label; there is no scroll state at all; peer list capped at `MAX_LIST_ROWS = 6` | `tui.ts:594–654` |
| S8 | The peer agent gets a truncated task | `buildPlan` sets `title: intent.text.slice(0, 200)`, and the peer's agent prompt is `${item.title}\n\n${PROMPT_PREAMBLE}`. The sub *does* receive the full intent text (≤4000) in the `intent` frame but only emits it as an event | `src/session/state.ts:36`, `executeItem` (`session.ts:1468`), `sub.ts:171` |
| S9 | Escape sequences split across `data` chunks become garbage keys | Decoders consume a sequence only if it is complete in one chunk | `decodeShellKeys` (`input.ts`), `decodeKeys` (`tui.ts:159`) |
| S10 | Rendering cost grows with history | `sourceLines()` re-wraps the whole scrollback on every frame; the session ticker redraws every 250 ms (`TICK_MS`) | `model.ts:188`, `run.ts:1175` |

S8 is listed here because it is literally "content is cut off" (the peer agent never sees more
than 200 characters of the human's request) and because Phase 2 depends on fixing it.

### 1.3 How an intent flows today (what Phase 2 sits on)

```
human types free text in the master shell
  → Shell.freeText → Shell.sendIntent (run.ts:455)
      → SessionController.intentRoute()   own master | external master (control port) | refused
      → (multi-peer) pickPeers picker → repos
      → own:      MasterHandle.submitIntent(text, repos)           (master.ts:379)
        external: submitIntentAt(endpoint, text, repos)  control frame {op:"intent"} (messages.ts:32)
  master: broadcast {type:"intent", text} → capability → route (matchSub / lone-peer) →
          datalist-request → plan {items[title = text[:200]]} → claim → claim-ack
  peer:   onItem(item) → executeItem → agent (native/pty/herdr) with prompt = item.title
          → result {summary ≤4000, redacted, control-stripped, checks, submit}
  master: applyResult → event "item-result"/"item-failed"/"item-pending"
          (summary cut to 8 lines/600 chars) → intentFinished → "intent-done"/"intent-failed"
  shell:  masterEvent → scrollback lines
```

Key properties to keep:

* **No agent runs on the master today.** The master is a router; the human's text goes to the
  peer verbatim (redacted). There is no "master agent" and no conversation context.
* **D27:** full transcripts stay on the executing device; only a redacted, control-stripped
  summary ≤4000 chars crosses the wire.
* **Wire objects are strict** (`z.strictObject`, `SessionMsgSchema` discriminated union,
  `messages.ts:204`). An old peer receiving an unknown message type or key ends the session
  with `protocol_error`. Any wire change needs negotiation (§3.6).
* Results are already available structurally to the master process: `MasterHandle.status()`
  → `intents[].items[].result.summary/checks/submit` (`SessionStatusSchema`, `messages.ts:250`),
  and the same shape over the control port for a master in another process.
* The master device's agent CLI is already a setting: `/agent` → `device.toml [agent] cli`
  (`run.ts:1054`, `loadAgentSetting` `session.ts:1121`, `resolveAgentCli` `session.ts:1188`),
  non-interactive argv in `NATIVE_ARGV` (`session.ts:1050`: `codex exec -`, `claude -p`,
  `pi -p`).

### 1.4 herdr in Skep today

* herdr is referenced by D27/D28/D30 and the PRD (G8, S7 "herdr main manager", §13.2).
* SK-620 shipped `src/runtime/herdr.ts` + `pty.ts` in v0.1.1 (`fdeebae`), verified against
  herdr 0.9.3 (protocol 22). They were **deleted** in v0.1.2 (`08cc13e`, "remove signed git
  blackboard and skepd"). Only the contract survives: `AgentSessionBackend` in
  `src/runtime/types.ts`. `loadAgentRuntime` (`session.ts:942`) imports them dynamically and
  today reports "the PTY/herdr runtime is not in this build", so `--view pty|herdr` falls back
  to native.
* `ARCHITECTURE.md` §17 lists "herdr main manager reaching other devices" as out of scope "via
  inbound SSH"; this plan respects that: cross-device control stays on Skep's own encrypted
  session channel.

---

## 2. herdr: what it is and how its controller pattern maps

**Project:** <https://github.com/ogulcancelik/herdr> (canonical; `herdrdev/herdr` and several
forks/mirrors exist). Rust, single binary, "a terminal workspace for running coding agents".
Latest release **v0.9.3** (checked 2026-10-13 via the GitHub API); ~43k stars.

**License:** the `LICENSE` file at `HEAD` is **Apache-2.0** and the GitHub API reports
`spdx_id: Apache-2.0`. Some third-party listings describe an AGPL-3.0-or-later / commercial dual
license, which suggests the license changed at some point. **Phase 0 must pin a tag and read
`LICENSE` at that tag** before anything is copied (even snippets). Apache-2.0 is compatible with
Skep's MIT for vendoring (keep `LICENSE`/`NOTICE`, mark modified files); AGPL would not be
acceptable for an MIT npm package.

**Architecture (from its README and bundled `skills/herdr/SKILL.md` @ v0.9.3):**

* A background **server** owns terminals (workspaces → tabs → panes); the TUI is a client that
  can detach/reattach (also over SSH).
* It **recognizes agents** inside panes (claude, codex, pi, opencode, …) and classifies each as
  `idle | working | blocked | done | unknown` (`blocked` = an approval/question UI is up; `idle`
  and `done` both mean ready for input; `unknown` never proves completion).
* A **CLI + local Unix socket API** lets an agent running inside a pane control the session:
  `pane split`, `agent start <name> --kind … --pane …`, `agent prompt <name> "<text>" --wait
  --timeout <ms>`, `agent wait --until blocked`, `agent read <name> --source recent-unwrapped
  --lines N`, `agent send-keys`, `pane run` / `pane wait-output`.
* The **controller pattern** is *agent-driven*: a main agent, taught by the herdr skill
  (`HERDR_ENV=1` gate), splits a sibling pane, starts a worker agent, prompts it with `--wait`,
  reads its output, and decides what to do next. Prompt-wait semantics are careful: a prompt
  must produce observed `working`/`blocked` activity within 5 s or it is `agent_prompt_stalled`;
  a timeout does not prove the prompt was not delivered ("do not blindly submit again").
* Cross-machine: `herdr --machine <saved-profile>` forwards the API over SSH to another
  machine's herdr server.

**Mapping to Skep:**

| herdr concept | Skep equivalent today | Skep after this plan |
| --- | --- | --- |
| main agent in a pane, controlling others | none (master is a router) | **master agent** run by the master shell (§3) |
| worker agent in a sibling pane | peer agent run by `executeItem` on another device/terminal | unchanged, but receives the master agent's brief |
| `agent prompt --wait` | `submitIntent` + plan/claim/result | orchestration step "dispatch + await settle" |
| `agent read` | `result.summary` (≤4000, redacted) via `status()` | input to the master agent's synthesis turn |
| `idle/working/blocked/done/unknown` | peer phases `idle/working/blocked/done` (`progress.ts`), agent states `starting/running/blocked/done/failed` | unchanged vocabulary; orchestration phases added (§3.3) |
| `--machine` over SSH | Skep session: PAKE join code + encrypted channel, outbound only | unchanged: cross-device stays on Skep's channel |
| pane TUI with scrollback | shell scrollback (partial) | Phase 1 scrollback |
| herdr skill teaching the agent the CLI | `src/cli/agent-guide/SKILL.md` (for `skep tui`) | Phase 4 option: agent-driven mode (§3.8) |

The lesson Skep takes from herdr is the **controller loop** (prompt → wait for a settled state →
read → decide), its **state vocabulary**, and its **safety rules** (never auto-answer `blocked`,
never blindly resubmit after an ambiguous timeout, prefer stable names/ids, read before acting).
Skep's addition is that the workers are on **other terminals and other devices**, reached through
the session protocol instead of a local socket or SSH.

---

## 3. Architecture: master-agent → refine → peer-agent → master-agent synthesize

### 3.1 Topology decision

Two ways to build a herdr-like controller:

* **T1 — Skep-driven pipeline (recommended for v1).** Skep owns the loop and calls the master
  agent for exactly two kinds of turns: *refine* and *synthesize*. Dispatch, waiting, retries
  and display stay in deterministic TypeScript. Testable with fakes, bounded cost, no agent
  needs to learn a CLI, nothing depends on an agent following tool instructions.
* **T2 — Agent-driven (herdr's own model).** The master agent gets a Skep skill and calls
  `skep peer prompt --wait` / `skep peer read` itself, deciding how many rounds to run.
  More flexible, but nondeterministic, harder to test, needs a stable machine CLI, and gives
  the agent the ability to fan out work by itself (security and cost exposure).

v1 implements **T1**, but shapes the internals (an `Orchestrator` with dispatch/await/read
primitives) so a later T2 can expose the same primitives as CLI commands (§3.8, Phase 4).

### 3.2 End-to-end flow (v1)

```
┌──────────── master device (shell where the human types) ───────────────────────────┐
│ human: "make the login page remember the last user"                                │
│   │                                                                                 │
│   ▼  (1) REFINE  — master agent turn, read-only, same conversation as before        │
│ MasterAgent.turn(refinePrompt{userText, peers[{peerId,device,repo,role}],          │
│                  ledger of recent orchestrations})                                  │
│   → fenced JSON  {brief, title, targets?, questions?, notes?}  (Zod-validated)      │
│   │  questions? → shown, human answers in the input box, loop (≤ 2 rounds)          │
│   ▼  (2) CONFIRM — only in mode "confirm": brief shown, Enter send · e edit ·       │
│   │               Esc cancel. Default mode "auto" shows the brief and sends it      │
│   ▼  (3) DISPATCH — existing path: intentRoute → (picker) → submitIntent(brief,     │
│   │               repos)   one intent per target group (§3.5)                       │
└───┼─────────────────────────────────────────────────────────────────────────────────┘
    │  session protocol (unchanged in v1): intent / capability / datalist / plan /
    │  claim / result / progress
┌───▼──────── peer device(s) / other terminal(s) ─────────────────────────────────────┐
│ (4) PEER AGENT — executeItem with prompt = full brief (S8 fix), not the 200-char    │
│     title; runs in the peer's folder (D31); result summary ≤4000 redacted (D27)      │
└───┬─────────────────────────────────────────────────────────────────────────────────┘
    ▼
┌──────────── master device ─────────────────────────────────────────────────────────┐
│ (5) AWAIT — orchestration watches status() (own master) or control status          │
│     (external master) until every item of its intents is terminal                   │
│ (6) SYNTHESIZE — MasterAgent.turn(synthPrompt{original userText, the brief,         │
│     per-item results as UNTRUSTED data}) in the SAME agent conversation as (1)      │
│ (7) SHOW — "summary" block in the scrollback (full, wrapped, persisted)             │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

"Combine with the original master-agent context" is met by running (1) and (6) as turns of **one
resumed agent conversation** (§3.4), so the synthesis sees the human's original words, its own
refine reasoning, any clarifying answers, and earlier orchestrations in that session.

### 3.3 Orchestration state machine

One `Orchestration` per human request. Plain JSON state (AGENTS.md: deterministic, no Map/Set
in reducer state), driven by events; the reducer is pure so it can be unit-tested like the
session reducers.

```
draft ─► refining ─► (asking ─► refining)* ─► confirming ─► dispatching ─► awaiting
  │          │                                   │              │            │
  │          └─► failed(refine)                  └─► cancelled  └─► failed   ├─► synthesizing ─► done
  │                                                              (no_match)  │        └─► done(raw)  ← synth failed: show raw results
  └─► raw (mode off / "/intent" / refine unavailable → today's path)         └─► stalled (pending items; human can /summarize)
```

`confirming` is entered only in mode `confirm`; in the default mode `auto` (locked §9.1) a valid
refine goes straight to `dispatching`.

Events: `refined{json}`, `refineFailed{cause}`, `answered{text}`, `confirmed{brief}`,
`edited{brief}`, `cancelled`, `dispatched{intentIds}`, `dispatchFailed{cause}`,
`itemsChanged{items}`, `settled`, `synthesized{text}`, `synthFailed{cause}`, `summarizeNow`.

Terminal-item rule (reuses `itemVerdict`, `master.ts:98`): `done | failed | submit-failed |
declined` are terminal; `running` is not; `pending` (agent blocked in its own view, D29) is
**not** terminal → the orchestration goes `stalled`, the footer says which peer waits for a
human, and `/summarize <id>` lets the human synthesize with what exists.

### 3.4 The master agent (`MasterAgent`)

A new I/O adapter, constructor-injected (AGENTS.md: no direct `spawn` in pure code; simulator
fakes):

```ts
// src/orchestrator/master-agent.ts (new; shape, not final code)
export interface MasterAgent {
  readonly cli: AgentCli;                     // claude | codex | pi, from /agent (device.toml)
  /** One turn in this shell's persistent conversation; resumes it when one exists. */
  turn(input: { prompt: string; signal?: AbortSignal; timeoutMs: number }):
    Promise<{ text: string; conversationId: string }>;
  reset(): void;                              // /orchestrate new or 500K cap → fresh conversation
}
```

* **Which agent:** the same resolution as `/join` (`resolveAgentCli`): `/agent` setting →
  `SKEP_AGENT_CLI` → first of `AGENT_ORDER` on PATH. Shown in the header (`master agent:
  claude`).
* **Where it runs:** the master shell's own device and cwd (the master's project root), using
  the sanitized env (`AGENT_ENV_KEYS`, D19).
* **How:** non-interactive, one process per turn, argv only (`execFile`/`spawn`, `shell:false`),
  prompt on stdin, timeout via the injected `Clock`, abort kills the process group. Conversation
  continuity through each CLI's resume mechanism. **Verified in Phase 0**
  (`docs/spikes/master-agent-cli.md`, claude 2.1.296, codex-cli 0.160.0, pi 1.0.2):
  * claude: first turn `claude -p --output-format json --session-id <uuid> --permission-mode
    plan --tools Read,Grep,Glob`, later turns the same with `--resume <uuid>` (reusing
    `--session-id` fails "already in use");
  * codex: `codex exec --json --sandbox read-only --skip-git-repo-check -o <file> -`, id from the
    `thread.started` event, later turns `codex exec resume --json -c sandbox_mode="read-only"
    --skip-git-repo-check -o <file> <thread-id> -` (resume has no `--sandbox` flag);
  * pi: every turn `pi -p --mode json --session-id <uuid> --tools read,grep,find,ls` (creates
    the session when missing).
  All three resumed correctly and refused a write. If a resume fails anyway, Skep re-seeds a new
  conversation from its own **ledger** (§3.7).
* **Read-only by contract.** Refine and synthesize must not edit the master's working tree.
  Enforced by CLI flags where available, and verified after each turn by `git status
  --porcelain` diff (the same delta machinery as `session-delta.ts`); a change fails the turn
  and is reported, never silently kept.
* **Output contract.** Refine must end with a fenced ```json block matching
  `RefineOutputSchema` (strict Zod):
  ```ts
  { title: string(1..200),        // self-contained task line: old peers only see this (§3.6)
    brief: string(1..3800),       // full task for the peer agent, English
    targets?: { repo: string; brief?: string }[],   // Phase 3: per-repo briefs
    questions?: string[] (≤3),    // ask the human before dispatch
    notes?: string(≤1000) }       // master-side context, never sent to peers
  ```
  Parsing: last fenced JSON block → `RefineOutputSchema.safeParse`; on failure one repair turn
  ("your output did not match; reply with only the JSON"), then `failed(refine)` with the option
  to send the raw text (`r`) — never a silent fallback.
  Synthesize returns free text (Markdown-ish), bounded (e.g. 8000 chars kept locally; display
  wraps it; it never leaves the device).
* **Prompt files** live in `src/orchestrator/prompts.ts` (English, versioned constants, unit-
  tested snapshots). Peer results are inserted between explicit delimiters with an instruction
  that they are data from another device and must not be followed as instructions (§6 security).

### 3.5 Dispatch on today's protocol (v1: no wire change)

* `Orchestrator.dispatch` calls the **existing** `Shell.sendIntent` internals (route check,
  picker, master-changed guard, own vs control route; `run.ts:455–519`) with
  `text = brief` (≤4000 after the header line) and the repos chosen by the picker/`targets`.
  Factor `sendIntent` into a reusable function returning `{intentId, repos}` rather than a
  `SlashResult` string — no behavior change for `/intent`.
* **Brief text on the wire:** first line = `title` (so `buildPlan`'s 200-char title is
  meaningful for old peers), blank line, then `brief`. Redaction stays on the master
  (`submitIntent` redacts) and the peer.
* **Peer side (fixes S8, additive, no wire change):** `connectSub` keeps `intentId → text` from
  the `intent` frame (it already stores `descriptions` per intent, `sub.ts:171`) and passes it to
  `onItem` as a second argument `{ intentText }`; `executeItem` builds the prompt from
  `intentText` when present, else `item.title` (old masters). Prompt size: herdr argv limit
  16 KiB (SK-620 brief) and stdin for native — 4000 chars fits both.
* **Per-repo briefs (Phase 3):** one `submitIntent` per target repo with `repos=[repo]` and its
  own brief. Still no wire change; the orchestration groups several `intentId`s.
* **`/intent` stays raw.** `/intent [--repo …] <text>` keeps today's semantics (escape hatch,
  scripts, old muscle memory). **Free text** goes through the orchestrator when mode ≠ `off`.
* **Modes:** `/orchestrate auto|confirm|off` (**default `auto`**, locked decision §9.1),
  persisted in `device.toml` `[orchestrate] mode` next to `[agent] cli`. `auto` shows the full
  brief in the scrollback and dispatches it without a prompt; `confirm` waits for Enter / e / Esc;
  `off` is exactly v0.1.13 behavior.

### 3.6 Awaiting results and protocol compatibility

* **Own master** (shell started it): add an **additive** callback to `MasterOptions`:
  `onIntentChanged?(intentId, items: ItemStatus[])`, fired from `applyResult`/`plan`/`dropPeer`
  paths (`master.ts:657–700, 857`). Fallback without it: read `handle.status()` on the existing
  250 ms tick (`run.ts:1175`) — already cheap and already done for the footer.
* **External master** (another process on this device, `IntentRoute.kind === "control"`): poll
  control `status` (already polled every `EXTERNAL_POLL_TICKS`), read
  `intents[intentId].items[].state/result`. No control-protocol change.
* **Peers on other devices / terminals**: unchanged. A peer on ≤0.1.13 still works; it prompts
  its agent with the 200-char title only (the master agent is instructed to make `title`
  self-contained). The shell cannot detect peer versions today (no version on the wire); the
  plan's Phase 3 adds that.
* **Session protocol v2 (Phase 3, only if needed):** for briefs >4000, structured result
  details, or peer version reporting. Because every frame is strict, negotiation must happen
  before any new frame flows: a v2 sub sends `join{v:2}`; a v2 master accepts `v:1|2` and only
  sends v2 frames to v2 peers; a v1 master rejects the first frame (`bad_request`) and the v2
  sub retries once with `v:1` and logs "master is older (≤0.1.13); orchestration features
  limited". Results stay ≤4000 redacted per item (D27 is not relaxed); "more detail" means more
  structured fields (changed files, checks, last agent message), not raw transcripts.

### 3.7 Context, persistence, the ledger

* **Ledger** `<home>/orchestrations/<orch-id>.json` (0600, `home` = `SKEP_HOME` or
  `~/.skep/projects/<projectId>`, `src/config/paths.ts`): user text, refine output, final brief,
  intent ids, item results as received (already redacted), synthesis, timestamps from `Clock`,
  agent conversation id. Used to (a) re-seed a conversation when resume fails, (b) `/history`,
  (c) crash recovery (an orchestration `awaiting` when the shell died can be re-attached if the
  master still runs, else marked `abandoned`).
* **Context budget (locked §9.3: "same session keeps context, max 500K"):** one master-agent
  conversation is kept and resumed for every orchestration of the same shell session, so later
  turns see earlier requests, briefs and summaries. Skep counts the characters it has sent into
  that conversation (prompts + peer results, as recorded in the ledger); when the next turn would
  take it past **500 000 characters**, Skep starts a fresh conversation and re-seeds it from the
  ledger (last K = 3 summaries) and says so in the scrollback. Per synthesis, results are still
  bounded (≤16 items × ≤4000 chars ≈ 64 KB worst case; prompt cap 24 000 chars of result text,
  head+tail like `clipSummary`, cuts announced). `/orchestrate new` starts a fresh conversation
  by hand. A new shell session starts a new conversation.

### 3.8 Phase 4 option: agent-driven (herdr's T2)

Expose the orchestrator primitives as a local, token-guarded machine CLI, mirroring herdr's verbs:
`skep peer list --json`, `skep peer prompt <peer|repo> --wait --timeout <ms> --json` (= one
intent + await), `skep peer read <intent> --json`, gated by an env flag analogous to
`HERDR_ENV=1` (`SKEP_CONTROLLER=1`) and the existing control token. Teach it in
`src/cli/agent-guide/SKILL.md`. Then the master agent can run multi-round loops itself. Not in v1.

### 3.9 Module layout and file ownership (for DEV-PLAN rows)

| New / changed | Owner task | Notes |
| --- | --- | --- |
| `src/cli/shell/transcript.ts` (new) | SCROLL-1 | entry store, wrap cache, persistence |
| `src/cli/shell/scroll.ts` (new) | SCROLL-1 | viewport math shared by shell and `skep ui` |
| `src/cli/shell/model.ts`, `input.ts`, `run.ts` (keys/render only) | SCROLL-1/2 | |
| `src/cli/tui.ts` (`Screen` mouse/1007 toggles, `TuiModel` output pane) | SCROLL-3 | |
| `src/session/master.ts` (`scrollbackSummary` use), `index.ts` (`onIntentChanged`) | SCROLL-2 / ORCH-2 | additive |
| `src/session/sub.ts` (`onItem(item, {intentText})`) + `commands/session.ts` prompt | ORCH-1 | S8 fix, additive |
| `src/orchestrator/{master-agent,prompts,schemas,orchestrator}.ts` (new) | ORCH-2/3 | I/O injected |
| `src/core/orchestration/reducer.ts` (new, pure) | ORCH-2 | state machine §3.3 |
| `src/cli/shell/run.ts` (free-text routing, `/orchestrate`, `/summarize`, `/history`) | ORCH-4 | |
| `docs/ARCHITECTURE.md` new decisions D32 (master agent, read-only, T1) and D33 (TUI scrollback persistence) | ORCH-0 | |

---

## 4. herdr integration options

| | (A) Inspiration only — reimplement patterns | (B) Vendor / adapt herdr modules | (C) Hybrid — patterns + optional herdr runtime via its CLI |
| --- | --- | --- | --- |
| What | Port the controller loop, state vocabulary, prompt/wait/read semantics and safety rules into Skep's TypeScript (§2 mapping) | Copy herdr source (Rust) into the repo, or port files line-by-line into TS | (A), plus restore the deleted SK-620 `src/runtime/herdr.ts`/`pty.ts` (git `fdeebae`) so the master agent and peer agents can *optionally* run in visible herdr panes when herdr is installed |
| License | Nothing copied; no obligations | Apache-2.0 at HEAD: keep LICENSE + NOTICE, mark changes; **must verify the pinned tag** (AGPL history reported by third parties) | CLI calls only; no code copied |
| Language fit | Native TS, ESM, Zod, no deps | Rust ≠ TS: either ship per-platform native binaries in an npm package (new build chain, supply-chain growth) or rewrite → effectively (A) with license baggage | TS client spawning `herdr` argv (`shell:false`), already designed and fixture-tested once |
| Architecture fit | Fits D28 ("never embedded or forked"), D30 (no multiplexer in Skep) | Contradicts D28/D30 and "No new dependencies"; herdr is a terminal multiplexer + emulator, exactly what D30 refuses to rebuild | Fits D28 exactly (optional, fallback order herdr ⇒ PTY ⇒ native) |
| Cross-device | Skep channel | herdr's `--machine` is SSH-based; ARCH §17 rules out inbound-SSH control | Skep channel for cross-device; herdr only for local panes |
| Cost | Medium (Phase 2) | Very high, ongoing rebase against a fast-moving upstream (0.4 → 0.9.3 in months) | Medium + small (restore + re-verify fixtures against current herdr) |
| Risk | Low | High (maintenance, license, binary distribution, security review of a terminal emulator) | herdr CLI drift (pinned `protocol`/`schema_version` check already designed) |

**Recommendation: (C) Hybrid, executed as (A) first.** Phase 1–2 are pure (A). Restoring the herdr
runtime is a Phase 3 item (watch the master agent and peer agents in herdr panes, `a` to focus),
re-verified against the then-current herdr release. **No herdr source is vendored**; if a later
need arises to copy code, it requires a new decision record plus a license check at the pinned
tag. This keeps D28/D30 intact; only D30's wording needs a note that the shell (not just `skep
ui`) is a scrolling control screen.

**Superseded for Phase 3 by locked decision §9.8 ("no real herdr split screen"):** Phase 3 is
option **(A) only**. The herdr runtime is not restored; the split-panel view is Skep's own
(§7 Phase 3, D34). D28 still describes the optional herdr pane order, but nothing in this plan
ships it.

---

## 5. TUI scroll design (Phase 1)

### 5.1 Model: transcript + viewport

* **`Transcript`** (replaces `ShellModel.scrollback`): append-only entries
  `{ seq, tone, text, kind: "system"|"input"|"event"|"tail"|"result"|"brief"|"summary", group?:
  string }` where `group` is an item key (`I-4-e1`) or orchestration id. Text is stored **whole**
  (no truncation, no 8-line cap); control characters are stripped on append (`printable`).
* **Every tone wraps** (S1). `entryRows(entry, width)` wraps with a hanging indent; `tail` rows
  keep the `I-4 │ ` gutter on continuation rows. `WRAPPED_TONES` is removed.
* **Wrap cache:** `Map<seq, rows>` valid for one width; a resize clears it. A running prefix
  sum of row counts lets the viewport find "row R" by binary search, so a frame costs
  O(visible rows + log n), not O(history) (S10). The tick redraw stays cheap.
* **Viewport (`ScrollState`):** `{ anchor: "bottom" } | { anchor: "pinned", seq, rowInEntry }`.
  Pinned by entry+row (not by raw row count), so a resize or new output keeps the same text at
  the top. Bottom-anchored follows new output (today's behavior).
* **Indicators (S6):** when pinned, the rule above the input shows `↑ 132 lines above · ↓ 18
  new — End to follow` (ASCII fallback `^ … v …`). Enter on a non-empty input still jumps to the
  bottom (the human just said something), an empty Enter does not.
* **Retention cap (locked §9.3):** the same session keeps its whole context, up to **500 000
  characters** of entry text (`TRANSCRIPT_MAX_CHARS`). Past that the oldest entries are evicted
  and a single `— earlier output dropped (500K limit) —` marker row stays at the top, so the
  reader knows the history is not complete. Peer local agent transcripts (S3) count against the
  same cap; they are not kept in a separate store.

### 5.2 Keys and mouse (S5, S9)

| Input | Action | Notes |
| --- | --- | --- |
| PgUp / PgDn, Shift+PgUp / Shift+PgDn | page = body rows − 1 | replaces `PAGE_LINES = 10` |
| Shift+↑ / Shift+↓, Ctrl+↑ / Ctrl+↓ | one row | `ESC[1;2A`, `ESC[1;5A`, … |
| ↑ / ↓ when menu, picker and question are closed | one row (3 per wheel notch arrives as 3 keys) | wheel in alt-screen arrives as arrows (alternate-scroll) |
| Home / End (`ESC[H`, `ESC[1~`, `ESC[7~`, `ESC[F`, `ESC[4~`, `ESC[8~`), Ctrl+Home/End | top of loaded history / follow bottom | Home with a non-empty input moves nothing in the input (no cursor yet) — scroll wins |
| Mouse wheel | ± 3 rows | default: request alternate-scroll mode `ESC[?1007h` (wheel → arrows, **native text selection still works**); opt-in full SGR mouse `ESC[?1000h ESC[?1006h` with `/mouse on` or `SKEP_TUI_MOUSE=1` (decodes `ESC[<64;x;yM` / `<65`), always disabled in `Screen.restore` and on `suspend` |
| `/top`, `/bottom`, `/find <text>` (stretch: `n`/`N` next) | jump | `/find` highlights matches in the visible rows |

Decoder changes (`input.ts`): full CSI parsing with parameters and modifiers, SGR mouse,
**a carry buffer** for sequences split across `data` chunks (flushed as `escape` after a short
`Clock` timeout so a lone Esc still works). Same fix for `decodeKeys` in `tui.ts`.

### 5.3 "Load earlier messages": same-session retention

Locked answer §9.3 ("same session keeps context, max 500K") replaces the earlier design of
day-rotated history files with 14-day / 50 MiB retention:

* Everything a session showed stays scrollable for the life of that shell session: nothing is
  dropped by an entry count (`SCROLLBACK_CAP = 1000` goes away), only by the 500 000-character
  cap of §5.1. "Earlier messages" are therefore always loadable by scrolling up — Home goes to
  the first retained entry.
* No cross-session history file in v1: a new shell session starts with an empty transcript (the
  welcome screen). Context does not leak from one session into the next, and no transcript text
  is written to disk by the shell (the item journal and native-run transcript files that already
  exist are unchanged).
* The cap is enforced on append in O(1) amortized (running character total; evict from the
  head), so it never blocks rendering.

### 5.4 Removing the truncation sources (S2, S3, S7, S8)

* **S2:** the shell shows the **whole** received summary (≤4000, already redacted). Keep
  `scrollbackSummary` for the plain `skep session` CLI output; the master event carries the full
  block, or the shell builds it from `status()`. Long result blocks are folded in Phase 3
  (`… 54 more lines — /expand I-4`), never dropped.
* **S3:** the peer shell renders the **local transcript file** of a finished native run (the
  file `runNative` already writes, `session.ts:1334`), redacted and control-stripped, instead of
  the 4000-char window; while running (PTY/herdr), it streams from the tail as now. Needs an
  additive `JoinViewModel.transcriptPath?` (local only, never on the wire).
* **S7:** `TuiModel`'s OUTPUT pane uses the same `scroll.ts` viewport (`PgUp/PgDn` scroll the
  selected entry's tail; the "last N of M" label becomes the indicator). The peer list keeps
  `MAX_LIST_ROWS` with its existing "↑↓ to scroll" behavior.
* **S8:** the `{intentText}` fix (§3.5). Locked decision §9.2: it is **not** shipped as a
  separate patch release; it lands with the larger change (implemented on `feat/tui-scroll`
  together with S2/S3 and carried into `feat/master-orchestrator`, released with them).

### 5.5 Rendering

* Keep full redraw for correctness, but stop clearing: write each row with `ESC[K` (erase to
  end of line) instead of `ESC[2J` to remove flicker on fast terminals and over SSH. Optional
  row diff (skip unchanged rows) behind `SKEP_TUI_DIFF=1` until proven.
* `Screen.start/resume` enables `?1007h` (and mouse when opted in); `restore` disables all
  enabled modes before `?1049l` — the same "every exit path restores" invariant (`tui.ts:263`).

---

## 6. Risks and mitigations

| Area | Risk | Mitigation |
| --- | --- | --- |
| Protocol compatibility | Strict schemas: any new frame/key breaks ≤0.1.13 peers with `protocol_error` | v1 adds **no** wire changes (§3.5–3.6). v2 only with join-version negotiation and retry-as-v1. Integration tests: new master × old-shape peer frames, old master × new peer |
| Old peers | They prompt from the 200-char title | `title` is required to be self-contained; shell notes "peers on ≤0.1.13 see only the title"; Phase 3 version reporting |
| Latency | Two extra agent turns (refine 5–60 s, synth 10–90 s) on top of peer work | Live phase in the bee footer (`master agent refining 12s`), Esc cancels refine (kills the process group), `auto` is the default (no confirm wait), `/intent` raw path, synth runs while the human can keep typing |
| Agent context size | Many orchestrations bloat the master conversation; results up to 64 KB | same-session conversation capped at 500K characters (locked §9.3), then a fresh conversation re-seeded from the ledger; per-synthesis cap + head/tail clipping with "cut" notes; `/orchestrate new` |
| Agent CLI drift | Resume / JSON / read-only flags differ between versions of claude/codex/pi | Phase 0 pins flags per CLI in a spike note; `MasterAgent` per-CLI adapters with a capability probe; graceful degrade (no resume → ledger re-seed; no read-only flag → post-turn git check is the guard) |
| Model output validity | Refine JSON malformed, over-long, or asks endless questions | strict Zod, one repair turn, ≤2 question rounds; the brief is always shown in full before it leaves (auto) and can be edited first in `confirm` mode |
| Multi-peer | Same repo on two peers → one item (routing by repo, INTENT-PEER known limit); partial failures; one peer blocked forever | v1: one brief, picker semantics unchanged; synth on settle, `stalled` + `/summarize` for pending; per-peer briefs in Phase 3 via one intent per repo; peer-level (not repo-level) routing needs a wire change → out of scope v1 |
| Security: prompt injection | A peer's summary (from its agent, from its repo) can contain instructions aimed at the master agent | results wrapped as delimited untrusted data; master agent turns are **read-only**; post-turn `git status` guard; the master agent can't dispatch on its own in T1 (only Skep dispatches, exactly one refine → one dispatch per human request; a synthesis never dispatches) |
| Security: data leaving the device | The brief is new text derived from the master's repo context and is broadcast to all connected peers (as intents are today) | default `auto` (locked §9.1) shows the full brief in the scrollback as it is sent; humans who want a gate use `/orchestrate confirm`; redaction on master and peer as today, `notes` never sent; doc the broadcast behavior; Phase 3 sends intents only to targeted peers (wire v2, accepted §9.5) |
| Security: credentials | Master agent needs provider credentials on the master device | it runs with the same sanitized env rules as peer agents (D19): its own CLI login, no Skep-forwarded secrets |
| Security: transcript retention | A long session holds sensitive text | kept in memory for the same session only (locked §9.3), max 500K characters, never written to disk by the shell; producers redact wire text |
| UX: mouse capture | Full mouse reporting breaks native selection/copy | default to `?1007h` alternate-scroll only; full mouse is opt-in |
| UX: key conflicts | ↑/↓ used by menu/picker; future input history | arrows scroll only when no menu/picker/question is open; history (if added) moves to Ctrl+P/N |
| Terminal restore | New modes (1007, 1000/1006) left on after a crash | added to `Screen.restore` steps (each runs even if another throws) and to signal/exit hooks; test with the fake TTY |
| Performance | Bigger history (up to 500K characters) with 250 ms redraws | wrap cache + prefix sums; 500K cap |
| herdr | License ambiguity, CLI drift | no vendoring; pin protocol/schema check; license re-check at the pinned tag before any copy |

---

## 7. Phases and exit criteria

### Phase 0 — research spike (1–2 days) · `spike/master-agent-cli`

* Verify, per agent CLI (claude, codex, pi; record exact versions): non-interactive turn, JSON
  output, conversation id capture, resume by id, read-only mode, timeout/abort behavior, typical
  latency for a 300-word refine and a 4 KB synthesis.
* Terminal matrix for scrolling: iTerm2, Terminal.app, GNOME Terminal/VTE, kitty, WezTerm,
  Windows Terminal (WSL), tmux and over SSH: which keys arrive for PgUp/Shift+PgUp/Home/End,
  whether `?1007h` is honored, wheel behavior.
* herdr: pin a tag, read `LICENSE` at that tag, record `herdr api schema --json` protocol, decide
  whether the SK-620 client can be restored as-is.
* **Exit:** `docs/spikes/master-agent-cli.md` with pinned argv per CLI and a decision table;
  ARCHITECTURE D32/D33 drafted; this plan amended where the spike disagrees. **Done
  2026-10-13**: all three CLIs verified (turn, JSON, id, resume, read-only); herdr v0.9.3 is
  Apache-2.0 at the tag, protocol 22 = SK-620's; GUI terminal matrix replaced by a superset
  decoder plus a manual RUNBOOK check (no GUI terminals in the spike environment).

### Phase 1 — TUI scroll (SCROLL-1..3) · `feat/tui-scroll`

* SCROLL-1: `transcript.ts`, `scroll.ts`, wrap all tones, wrap cache, pinned viewport,
  indicators, full CSI/mouse decoder with carry buffer, keys of §5.2, `?1007h` on/off.
* SCROLL-2: same-session retention with the 500K cap (§5.3); full result summaries in the shell
  (S2); peer full local transcript (S3); S8 prompt fix (locked §9.2: lands with this larger
  change, not as its own patch).
* SCROLL-3: `skep ui` output pane uses the shared viewport (S7); `ESC[K` rendering.
* **Exit criteria** (each maps to tests with the fake TTY at 80×24 and 120×40):
  1. A 5 000-line history can be scrolled from bottom to the first line with PgUp, Home, arrows
     and (simulated) wheel input; End returns to follow mode.
  2. No line in the shell ends with `…` because of width: a 600-char `info` line renders as
     wrapped rows, all characters present.
  3. A 4000-char peer summary appears in full in the master shell.
  4. A peer native run producing 50 KB of output shows all of it (from the local transcript).
  5. While scrolled up, new lines do not move the view and the indicator counts them.
  6. Resize while scrolled keeps the same top entry.
  7. Within one session nothing is dropped below 500 000 characters of history (Home reaches
     the first entry); past the cap the oldest entries go and a marker row says so. A new shell
     session starts empty (locked §9.3).
  8. Escape sequences split across chunks decode correctly; terminal modes are restored on quit,
     error and SIGINT (existing restore tests extended).
  9. `npm run lint && npm test` green; frame time with 20 000 entries stays within one tick
     (benchmark test with a fixed budget, skipped on CI if flaky).

### Phase 2 — master refine → peer → master synthesize (ORCH-0..4) · `feat/master-orchestrator`

* ORCH-0: D32/D33 in ARCHITECTURE; DEV-PLAN rows with owned files (§3.9).
* ORCH-1: peer prompt from full intent text (`onItem(item, {intentText})`), backwards compatible
  (implemented early on `feat/tui-scroll` as S8, locked §9.2; carried forward here).
* ORCH-2: pure reducer (§3.3) + `RefineOutputSchema`; `onIntentChanged` additive master
  callback.
* ORCH-3: `MasterAgent` adapters for **claude, codex and pi** (locked §9.4; argv per Phase 0),
  prompts, read-only guard, ledger, 500K same-session context cap.
* ORCH-4: shell wiring: free text → orchestrator (default mode `auto`);
  `/orchestrate auto|confirm|off|new`, `/summarize <id>`, `/history`; confirm UI (Enter / e / Esc) in the input area; footer phases;
  summary block rendering.
* **Exit criteria:**
  1. With fake agents and two in-process peers (local sockets, temp `SKEP_HOME`): free text →
     refine turn → (auto: no prompt; confirm mode: Enter) → intent with the brief → peer
     agent receives the **full** brief → results → synthesis turn receives the original text, brief and both results → summary shown.
  2. The synthesis turn uses the same conversation id as the refine turn (fake CLI asserts
     resume argv).
  3. `off` mode and `/intent` are byte-for-byte today's behavior (existing tests untouched).
  4. Malformed refine JSON → one repair turn → clear failure with a raw-send option; questions
     loop ends after 2 rounds.
  5. A peer that ends `pending` → orchestration `stalled`, `/summarize` works with partial data.
  6. A master agent turn that modifies the working tree fails the turn and says which files.
  7. External master (control route) works the same via control `status` polling.
  8. A ≤0.1.13-shaped peer (no `intentText` support) still completes and the master still
     synthesizes.
  9. Optional real-CLI test behind `SKEP_REAL_CLAUDE=1` / `SKEP_REAL_CODEX=1` / `SKEP_REAL_PI=1`.
  10. The conversation is reused across orchestrations of one session and replaced (ledger
      re-seed) once it would exceed 500 000 characters.

### Phase 3 — split-panel multi-peer joint debugging (ORCH-5..7) · `feat/orchestrator-multipeer`

Rewritten 2026-10-13 for the human's ask (§0 item 3) and locked decisions §9.6–§9.8. The
original Phase 3 list (per-repo briefs, `/expand`, `/find`, herdr runtime restore, protocol v2)
is redistributed below; the herdr runtime restore is dropped (§9.8).

* **ORCH-5 — Skep panels on today's protocol (no wire change).** A `/layout split|single` mode
  in the unified shell: a **master panel** (the whole transcript as today) plus one **peer
  panel** per connected peer. Wide terminals put the master panel left and the peers stacked
  right; narrow ones stack them. Each panel scrolls on its own with the shared viewport
  (`scroll.ts`, D33); `Tab` (empty input, no menu) cycles focus, `/focus <master|peer|device>`
  names it, `/zoom` shows the focused panel alone, and the scroll keys act on the focused
  panel. A peer panel shows what already reaches this shell: that peer's join/leave lines, its
  item results and failures (≤4000, redacted), and a **timeline of its progress reports**
  (phase + the 120-character progress line, recorded each time it changes; the timeline lives
  only in the panel, the master panel is unchanged). On a joined shell the device's own panel
  also gets its own agent output, which is local (D27). Panels render Skep's own text: no
  terminal emulation, no vendor TUI parsing (D30 stands, amended by D34). `/find <text>` jumps
  the focused panel to the previous entry containing the text. Input always goes to the master
  (no per-peer follow-up, §9.7). `skep ui` stays the single-agent screen (D30).
* **ORCH-6 — session protocol v2 (accepted §9.5).** Negotiation per §3.6 (≤0.1.13 peers stay on
  v1); peer version reporting; intents sent only to targeted peers instead of broadcast; briefs
  >4000; structured result details (changed files, checks, last agent message). Plus an
  **opt-in live output stream** (§9.6): a peer sends a redacted, control-stripped, bounded tail
  (≤20 lines / 2 KB per frame, at most once per 500 ms, locked §9.10) **only when its human
  opted in** (`/share-output on` on the peer, default **off**, for the current session only and
  never remembered on the device, locked §9.9); the master's peer panel shows it. Off or on,
  phase changes, the 120-character progress line, blocked notices, results and — new in v2 —
  the **changed-files list** of each result always flow (locked §9.11). Needs a D27 amendment
  written with the code. Peer-level routing is **not** part of v2 (§9.7).
* **ORCH-7 — multi-peer orchestration in panels.** Per-repo briefs (one intent per target,
  grouped under one orchestration); synthesis across groups; partial-failure wording; the
  orchestration's phases and summary shown in the master panel with each brief and result
  linked to its peer panel; per-item folding and `/expand I-4`.
* ~~ORCH-8 — herdr runtime restore~~ — dropped by §9.8; no task.
* **Exit:** three peers on two devices, two repos, one failing and one blocked, in split
  layout: each peer panel shows its own timeline and outcome, the master panel shows one
  coherent summary naming each outcome; live output appears in a peer panel only after that
  peer opted in; mixed v1/v2 sessions pass the compatibility matrix; single layout and `off`
  mode are unchanged.

### Phase 4 (later, optional) — agent-driven controller (T2)

`skep peer list|prompt --wait|read --json` behind `SKEP_CONTROLLER=1` + control token, taught in
the agent guide, so the master agent can run multi-round loops like herdr's main agent. Needs a
separate security review (agent-initiated fan-out, cost limits).

---

## 8. Out of scope for v1 of this work

* Vendoring, forking or embedding herdr code; a terminal multiplexer/emulator inside Skep
  (D28/D30 stand). Real herdr panes, including for peers on the same machine (§9.8).
* Follow-up text typed into a peer panel and sent to that peer only (§9.7, "not for now").
* Agent-driven control (T2) and any agent-initiated dispatch without Skep in the loop.
* Raw transcripts or unredacted output crossing the wire; relaxing the 4000-char result cap (D27).
* Peer-level routing (two peers on the same repo each getting distinct work) — needs a wire
  change; not in Phase 3 (§9.7).
* Interactive master-agent chat that is not an orchestration (free text answered locally
  without dispatch); the refine step may ask questions, but a general "talk to my agent" mode is
  a separate feature.
* Auto-approving blocked agents or sending keys to them (D29 stands).
* Chinese human layer (PRD G8/S7) — orthogonal; this plan keeps English agent-to-agent text.
* Windows-native console support beyond what `Screen` supports today.
* Input editing upgrades (cursor movement, multi-line input, history) beyond the key conflicts
  noted in §5.2.

---

## 9. Decisions (locked by the parent, 2026-10-13)

The questions below were open in the design draft. The parent answered each one; the answers are
recorded verbatim and are normative for every phase.

1. **Q:** Default orchestration mode: `confirm` (recommended: the human sees what leaves the
   device) or `auto`?
   **Answered — locked:** "Default orchestration mode: **auto** (not confirm)."
   Applied: §3.2, §3.5, §6, §7. `confirm` and `off` remain as modes.
2. **Q:** Should S8 (peer prompt = full intent text) ship immediately as a patch release ahead of
   Phase 2? It is a standalone bug fix with no wire change.
   **Answered — locked:** "S8 (peer 200-char slice): **do not ship a separate patch** — fix
   together with the larger change."
   Applied: §5.4, §7 (SCROLL-2 / ORCH-1).
3. **Q:** Transcript retention defaults (14 days / 50 MiB) and whether the peer's local agent
   transcripts belong in the shell history file or stay only in the item journal.
   **Answered — locked:** "Transcript retention: **same session keeps context, max 500K**."
   Applied: §3.7 (master-agent conversation reused within the session, 500K characters, then
   ledger re-seed), §5.1 and §5.3 (shell transcript kept for the whole session up to 500K
   characters, no cross-session history file; peer transcripts count against the same cap).
   The plan reads "500K" as 500 000 characters of text.
4. **Q:** Which agent CLIs must be supported as master agent in v1 (all three, or claude + codex
   first depending on Phase 0 resume support)?
   **Answered — locked:** "Master agent CLIs for v1: **yes** — support claude, codex, and pi (as
   skep already does for agents)."
   Applied: §3.4, §7 (ORCH-3); Phase 0 pins argv for all three (`docs/spikes/master-agent-cli.md`).
5. **Q:** Is a Phase 3 wire v2 acceptable at all, given every device must then upgrade for the new
   features?
   **Answered — locked:** "Phase 3 wire / protocol v2: **accepted**."
   Applied: §3.6, §6, §7 (Phase 3). Negotiation per §3.6 keeps ≤0.1.13 peers working on v1.
6. **Q:** In split panels, may remote peers' live agent output (redacted, bounded) appear on the
   master (a D27 amendment)?
   **Answered — locked:** "Remote peer live output: **default OFF**; only if the user opts in.
   Key/important info can still be received."
   Applied: §7 Phase 3 (ORCH-5 uses only what flows today; ORCH-6 adds the opt-in stream).
7. **Q:** Is a follow-up typed into one peer's panel, sent to that peer only, required (peer-level
   routing in v2)?
   **Answered — locked:** "Per-peer panel follow-up: **not for now**" (「暂时不可以」).
   Applied: §7 Phase 3 (input always goes to the master), §8.
8. **Q:** For peers on the same machine, real herdr split panes (herdr installed) or only Skep's
   panels?
   **Answered — locked:** "Same-machine: **no real herdr split-screen**; Skep's own panels only."
   Applied: §4 (Phase 3 is option A only), §7 (ORCH-8 dropped), §8.

ORCH-6 follow-up questions, answered by the human on 2026-10-13 (verbatim, normative):

9. **Q:** Does `/share-output on` on a peer apply to the current session only, or is it
   remembered on the device?
   **Answered — locked:** "`/share-output on` applies to the current session only (not
   remembered on the device)."
   Applied: §7 Phase 3 ORCH-6 (the opt-in lives on the join; every new join starts with it off;
   nothing is written to `device.toml`).
10. **Q:** Live output limits: about 20 lines / 2 KB per frame, at most once per 500 ms?
    **Answered — locked:** "Live output limits of about 20 lines / 2KB, at most once per 500ms:
    OK."
    Applied: §7 Phase 3 ORCH-6 (≤20 lines and ≤2048 UTF-8 bytes per `output` frame, at most one
    frame per 500 ms per peer, enforced by the sending peer and checked by the master).
11. **Q:** Which key information must always reach the master, whatever the live-output
    setting?
    **Answered — locked:** "Key info that must reach master: yes, ADD the changed-files list (in
    addition to phase, 120-char status, blocked, final result)."
    Applied: §7 Phase 3 ORCH-6 (a v2 `result` carries a structured changed-files list; phase,
    the 120-character progress line, blocked and the ≤4000 redacted result keep flowing as
    today, live output on or off).

---

## 10. Branches, sequencing, release

* `spike/master-agent-cli` (Phase 0; docs only — also carries this plan's locked-decision update)
* `feat/tui-scroll` (Phase 1; SCROLL-1 → SCROLL-2 → SCROLL-3; SCROLL-3 can run in parallel with
  SCROLL-2, no shared files except `tui.ts` restore steps owned by SCROLL-1)
* `feat/master-orchestrator` (Phase 2; ORCH-1 and ORCH-2 in parallel, then ORCH-3, then ORCH-4)
* `feat/orchestrator-multipeer` (Phase 3; from `feat/master-orchestrator` @ `0693085`;
  ORCH-5 → ORCH-6 → ORCH-7)
* Umbrella name if one branch is preferred: `feat/herdr-style-controller`.

Version: no bump in any of these branches (reconfirmed with the locked decisions). Suggested
later: Phase 1 → 0.1.14 (no protocol change), Phase 2 → 0.2.0 (new default interaction for free text), Phase 3 → 0.2.x or 0.3.0 if
the session protocol v2 lands. The release task decides.
