# Plan: peer progress bee (session TUI)

Status: plan only — nothing implemented yet. Target release: 0.1.3 (do **not** bump yet).
Integration branch: `feat/peer-progress-bee`.
Source brief: `/tmp/skep-peer-progress-brief.md`. Where this plan differs from the brief, this
plan wins. Each difference is called out with **(deviation)** and a reason.

---

## 0. Facts from the current code this plan depends on

* `src/session/messages.ts` `SessionMsgSchema` is a strict `discriminatedUnion`. **A peer that
  does not know a `type` fails `SessionMsgSchema.parse`, which throws `ChannelError` and drops the
  connection.** That is true on both sides (`master.ts` `phase === "session"` branch and the
  `sub.ts` frame handler). So mixed versions must be designed for (see §2.6).
* A sub only knows the master. It has no roster of other peers. `welcome` carries only
  `sessionId`/`peerId`. So a relayed frame must carry the subject's `device` (and `role`), not
  just its `peerId`. **(deviation: the brief has `peerId` only)**
* The master is not a peer and has no `peerId`. In the usual two-device setup, device A runs
  `skep session start`, **and also** `skep session join` (it finds the local master through
  `session.json`). Device B runs `skep session join --host A`. "A sees B" therefore means
  *sub-on-A sees sub-on-B through the master's relay*. Master `skep ui` sees everyone through
  `status`.
* `src/cli/commands/session.ts` keeps its **own strict copy** of `SessionStatusSchema`
  (lines ~139–170, "duplicated from the shared contract"). Any new field the master puts into
  `status()` must be added there as well, or `skep ui` / `skep session status` reject the reply.
* The master marks an item `done` when it accepts a result. That includes a **blocked** agent's
  result (`submit.state: "pending"`) and a **failed** agent's result (`checks` with `fail`). Only a
  dropped or missing assignee produces the item state `failed`.
* Both sides already have an injected `Clock` and a `timer(ms, fn)` helper (`SessionMaster.timer`,
  `SessionWire.timer`). Use them for coalescing. Never use `setTimeout` or `Date.now()`.
* The TUI redraws the whole screen on every change (`Screen.draw`). `truncate` counts **code
  points**, and the inverse-row padding uses `[...text].length`. A 2-column emoji like 🐝 would
  make lines one column too wide, and they wrap. This must be fixed (§4.5).
* Zod is v4 (`^4.6.5`). `.refine()` on a `z.strictObject` stays a `ZodObject`, so it can still be
  a `discriminatedUnion` member, and the union runs the refinement. This was checked against the
  installed zod while writing this plan. Keep one schema test that pins this behaviour.
* `SessionWire.timer(ms, fn) => cancel` is public, so `sub.ts` can use it for coalescing.
  `src/cli/commands/session.ts` already imports from `../../session/index.js`, so it can import
  `type PeerProgress` / `type PeerPhase` from there. Its comment about not importing src/session
  only covers the duplicated *wire schemas*.
* `workItem` sets the final `agentState` (`failed` / `blocked` / `done`) directly, not through
  `report()`, and then calls `result()`, which calls `view.update`. So `result()` is the right
  place for the final `onAgentState` call.

---

## 1. Product MVP

When A and B are in the same live session, each session TUI shows **one status strip per peer**:

```
Peers
  mac  backend  🐝    [███░░░░░]  37%  3/8  working  add a health check
> mac  backend  I-3 e1  claude/pty  running
  vps  frontend ·     [░░░░░░░░]   0%  0/0  idle
```

* The **flying bee** animates while the peer's phase is `working`. It pulses slowly while
  `blocked`. It shows `✓` when `done` and `·` when `idle`.
* The **progress bar** to the right shows overall % for the peer's assigned items.
* It works **both ways**: sub-on-A shows B, and sub-on-B shows A. Master `skep ui` shows all
  peers. Everything goes over the existing encrypted session channel: no blackboard, no new socket.
* The heartbeat stays liveness-only. Progress never rides on it.

---

## 2. Wire protocol

### 2.1 Shared types (`src/session/progress.ts`, new, owned by Claude)

```ts
export const PEER_PHASES = ["idle", "working", "blocked", "done"] as const;
export type PeerPhase = (typeof PEER_PHASES)[number];
/** "left" exists only on master→sub relays: the subject disconnected; drop its row. */
export type RelayPhase = PeerPhase | "left";

/** What one peer's strip shows. Plain JSON. */
export interface PeerProgress {
  peerId: string;
  device: string;
  role: string | null;
  phase: RelayPhase;
  done: number;    // assigned items finished (done or failed)
  total: number;   // assigned items
  failed: number;  // subset of done that failed (dropped assignee or a failing check)
  percent: number; // percentOf(done, total)
  summary: string; // ≤ 120 chars, "" when idle
  itemId?: string; // the item the summary is about
}

/** MVP metric. Documented in the CHANGELOG and in a comment here. */
export function percentOf(done: number, total: number): number {
  return total === 0 ? 0 : Math.floor((100 * done) / total);
}
```

### 2.2 Message schema (`src/session/messages.ts`, owned by Claude)

Add to `SessionMsgSchema`'s union:

```ts
export const PeerPhaseSchema = z.enum(["idle", "working", "blocked", "done"]);
const SummarySchema = z.string().max(120);

export const ProgressMsgSchema = z
  .strictObject({
    type: z.literal("progress"),
    // Master-filled identity. MUST be absent sub→master, MUST be present master→sub.
    peerId: IdSchema.optional(),
    device: DeviceSchema.optional(),
    role: RoleSchema.nullable().optional(),
    phase: z.enum(["idle", "working", "blocked", "done", "left"]), // "left": master→sub only
    done: z.number().int().nonnegative().max(10_000),
    total: z.number().int().nonnegative().max(10_000),
    failed: z.number().int().nonnegative().max(10_000),
    percent: z.number().int().min(0).max(100),
    summary: SummarySchema, // "" allowed
    itemId: ItemIdSchema.optional(),
  })
  .refine((m) => m.done <= m.total && m.failed <= m.done, "done ≤ total and failed ≤ done")
  .refine((m) => m.percent === percentOf(m.done, m.total), "percent must equal floor(100*done/total)");
export type ProgressMsg = z.infer<typeof ProgressMsgSchema>;
```

**(deviation: `failed`, `device`, `role` and the phase `"left"` are added.)** `failed` covers
the brief's "failed counts as done but is marked differently". `device` and `role` are needed
because subs have no roster. `"left"` lets the master remove a disconnected peer's row.

Direction rules. `receive` enforces them, not the schema, so one discriminated member serves
both directions:

| Direction | `peerId`/`device`/`role` | `phase: "left"` | On violation |
|---|---|---|---|
| sub → master | must be absent | forbidden | master `throw new ChannelError("Progress from a sub must not name a peer")`. This matches the existing "Message is not allowed from a sub" strictness. |
| master → sub | `peerId` and `device` required (`role` may be null); `peerId !== self` | allowed | sub `throw new ChannelError("Relayed progress must name another peer")` |

`SessionStatusSchema.peers[]` in `messages.ts` gains a **required** field:

```ts
progress: z.strictObject({
  phase: PeerPhaseSchema, done, total, failed, percent, summary: SummarySchema,
  itemId: ItemIdSchema.optional(),
}) // same refinements
```

The CLI's duplicate in `session.ts` gains the same object as **`.optional()`**, so a 0.1.3
`skep ui` still reads a 0.1.2 master's status.

### 2.3 Who sends what

| Event | Sender | Frame |
|---|---|---|
| Sub receives `welcome` | sub | its own progress (`idle`, 0/0) immediately. This is the **opt-in** (§2.6). |
| Sub-local change (claim-ack, claim-reject, result-ack/reject, `reportAgent` state change) | sub | own progress, coalesced (§2.5) |
| Master receives a peer's **first** progress | master | **snapshot**: the current effective progress of every *other* peer, sent to that peer only, immediately, not coalesced |
| Master-side change for peer X: join, capability (role learned), received progress, claim, result, plan (item failed for a missing assignee), another peer dropping (its items fail) | master | X's effective progress, relayed to every **opted-in** peer **except X**, coalesced per X |
| Peer X disconnects | master | `phase: "left"`, counts 0, `summary: ""` to every opted-in peer except X, immediately. The coalescer for X is cancelled. |

The master never echoes a peer's progress back to that peer. The master's own `skep ui` reads
`status()` (polled every 1 s, unchanged).

### 2.4 How the master fills identity and derives values

The master never forwards the sub's frame verbatim. It **rebuilds** the relay from its own state.
The `peer` here is the authenticated `Peer` object behind the wire, never a field from the frame:

```ts
relay = {
  type: "progress",
  peerId: peer.peerId,     // from the authenticated wire, never from the frame
  device: peer.device,     // from the handshake
  role: peer.role,         // from capability, null until then
  ...effectiveProgress(peer) // §3.2
}
```

### 2.5 Rate limits

* **Coalescing, both sides:** at most 1 frame per subject per **500 ms**
  (`progressIntervalMs`, injectable for tests). A **phase change is sent immediately**. A
  value identical to the last one sent is dropped. Changes inside the window collapse into one
  trailing send of the **latest** value at `lastSentAt + 500`.
* Implement this once in `ProgressCoalescer` (`progress.ts`). It takes `monotonicMs`, a
  `schedule(ms, fn) => cancel` (the master's `this.timer` / the wire's `wire.timer`) and a
  `send(p)`.
* The master keeps one coalescer per subject peer. Its `send` fans out to the opted-in peers
  except the subject. On the sub there is one coalescer for "self → master".
* Inbound guard on the master: a progress frame identical to the stored report is ignored
  (`wire.received()` still runs). Because of the coalescer, a flooding sub cannot amplify its
  rate toward other peers.
* The TUI animation tick is 250 ms and runs **only while some peer is working or blocked**
  (§4.4).

### 2.6 Version compatibility (opt-in)

* A 0.1.3 master sends `progress` **only to peers that have sent at least one `progress`**. The
  flag is `peer.progress.optIn`. A 0.1.2 sub never sends one, so it never receives one and
  keeps working. Its strip is still **derived** by the master and shown to others.
* A 0.1.3 sub joining a **0.1.2 master** is disconnected right after `welcome`, because the old
  master cannot parse `progress`. There is no way to negotiate this without breaking strict
  `welcome`/`join` parsing on old peers. Accept it and document it: *"upgrade the master device
  first; all session devices should run ≥ 0.1.3"*.
* `SubOptions.progress?: boolean` (default `true`): `false` disables the opt-in. It exists for
  tests that simulate an old sub, and it is the escape hatch toward old masters. There is no CLI
  flag for it in the MVP.

---

## 3. MVP progress metric

### 3.1 Sub-side (what the sub reports; `sub.ts`)

The sub tracks its own `items` map. Add the internal state `"rejected"` next to `claiming |
working | sent | done`. A claim-reject sets `rejected`. Today it sets `done`.

The sub also tracks `agents: Map<itemId, JoinAgentState-like>`, fed by
`SubHandle.reportAgent(itemId, state)`. The CLI calls it.

* `total` = items not `rejected`. `done` = items `done`. `failed` = agents in `failed`.
  `percent = percentOf(done, total)`.
* `phase`, by precedence:
  1. `blocked` if any agent is `blocked`. This is sticky for the life of the join: the human
     finishes with `skep session submit` in another process, which this process never sees.
  2. `working` if any item is `claiming | working | sent`, or any agent is `starting | running`.
  3. `done` if `total > 0` and every non-rejected item is `done`.
  4. `idle` otherwise.
* `summary` = the title of the most recently claimed item that is still active (`slice(0, 120)`),
  and `itemId` = that item. When nothing is active: `""`, and no `itemId`. **The sub never sends
  free text.** No agent output and no focus commands go into the summary, so nothing new can
  leak. Titles came from the master, which already redacted them.

### 3.2 Master-side (authoritative; `progress.ts` `deriveProgress`, pure)

```ts
export function deriveProgress(
  items: readonly ItemStatus[],              // all intents' items, flattened
  peerId: string,
  reported: { phase: PeerPhase; summary: string; itemId?: string } | null,
): Omit<PeerProgress, "peerId" | "device" | "role">
```

* Counts are **always derived** from the master's item states. A sub cannot inflate its %.
  * `total` = items with `assignee === peerId`.
  * `done` = those in state `done | failed`.
  * `failed` = state `failed`, **or** `done` with `result.checks.some(c => c.status === "fail")`.
* `phase`:
  1. `blocked` if `reported?.phase === "blocked"`. Only the sub can know this.
  2. `working` if any assigned item is `claimed`, or `reported?.phase === "working"`.
  3. `done` if `total > 0` and every assigned item is `done | failed`.
  4. `idle` otherwise.

  A peer that never reported (an old sub, or before its first frame) still gets a correct
  idle/working/done.

  A blocked agent's result is still accepted (`submit.state: "pending"`), so its item counts as
  `done`. The strip then reads `blocked` **with 100 %**. That is intended: the code is in, but a
  human still owes an answer or a submit. Pin it in a test so nobody "fixes" it.
* `summary` / `itemId`: the reported values if present and the `itemId` is assigned to this
  peer. Otherwise the first `claimed` item's title and id. Otherwise `""`. The master runs a
  fresh `Redactor` over the reported summary, then applies `slice(0, 120)`. This mirrors how
  `result.summary` is re-redacted.
* The master **stores** `reported` per peer. Counts and percent from the sub are informational
  and overwritten. The sub still has to send them, so the message has one shape in both
  directions.

---

## 4. TUI

### 4.1 Data shape

* `JoinViewModel.peers[number]` (in `session.ts`) gains an optional field:
  `progress?: { phase: PeerPhase; done; total; failed; percent; summary }`.
* `TuiPeer` (in `tui.ts`) gains the same optional `progress`.
* No progress means today's row (`device role state`), byte-for-byte. Existing frame tests stay
  valid.

### 4.2 Row layout (`TuiModel.listRows`)

For a peer **with** `progress`, emit one non-selectable strip row (`entry: null`) first, then its
entry rows exactly as today. For a peer without progress, nothing changes.

```
{device}  {role}  {lane:4 cols}  [{bar:8 cells}] {pct:3}%  {done}/{total}  {label}[  {summary}]
```

* `label` = the phase. When `phase === "done" && failed > 0` the label is `done (N failed)`.
* `summary` goes through `printable()`. `Screen.draw` truncates the whole line to the terminal
  width.
* Remote peers seen from a sub have no entries, so they show just the strip row. Self on a sub
  shows its strip row plus its item rows. Master `skep ui` shows a strip row plus item rows for
  every peer.
* `MAX_LIST_ROWS` (6) and the existing scroll logic already handle rows without an entry.

### 4.3 Frames (pure, exported for tests)

```ts
export type Glyphs = "unicode" | "ascii";
export const TICK_MS = 250;
export function beeLane(phase: PeerPhase, beat: number, glyphs: Glyphs): string // 4 display cols
export function progressBar(percent: number, glyphs: Glyphs): string           // 8 cells
```

| phase | unicode (beat 0,1,2,3 …) | ascii |
|---|---|---|
| working | `"🐝  "`, `" 🐝 "`, `"  🐝"`, `" 🐝 "` (ping-pong flight, 250 ms/frame) | `"~b  "`, `" ~b "`, `"  ~b"`, `" ~b "` |
| blocked | `"🐝! "` when `beat % 4 < 2`, else `"🐝  "` (1 s pulse) | `"b!  "` / `"b   "` |
| done | `"✓   "` | `"ok  "` |
| idle | `"·   "` | `".   "` |

Progress bar: `filled = Math.floor(percent / 12.5)`, so 100 → 8 and 99 → 7. Unicode uses
`█` / `░`, ASCII uses `#` / `.`. Example: 37 % gives `███░░░░░`.

Glyph choice: `TuiOptions.glyphs`, default `"unicode"`. `ui.ts` passes `"ascii"` when
`ctx.env.SKEP_TUI_ASCII === "1"`. Use the ASCII set for CJK-ambiguous-width terminals.

### 4.4 Animation tick

* `TuiModel.beat: number`, starting at 0. `TuiModel.animating()` is true when any
  `snapshot.peers[i].progress?.phase` is `working | blocked`.
* `Tui` gets `TuiOptions.clock?: Clock` (default `systemClock`) and `TuiOptions.animate?: boolean`
  (default `true`).
* At the end of `Tui.render()`, call `this.maybeTick()`. If `animate && model.animating()`, the
  screen is not closed, and no loop is running, start one loop:
  ```ts
  for (;;) {
    await clock.sleep(TICK_MS, controller.signal); // abort → exit quietly
    if (!this.model.animating() || this.screen.isClosed) break;
    this.model.beat += 1;
    if (this.screen.isActive) this.guard(() => this.render()); // suspended (PTY) → skip draw
  }
  ```
  The loop exits by itself when nothing animates. `close()` aborts it. It never busy-loops while
  idle. Errors other than abort go through `guard`, which restores the terminal and rethrows.
  Report them via `.catch` → `close()`. There are no silent catches.
* `uiCommand` passes `clock: ctx.clock ?? systemClock` to `new Tui(...)`. The poll loop and the
  ticker then share that clock. The `ui.test.ts` fake clock counts waiters (`time.sleeping()`) and
  releases all of them on `tick()`. Existing tests have no progress, so the ticker never starts
  and `sleeping() === 1` still holds. New `skep ui` tests with a working peer must expect
  `sleeping() === 2` (poll + ticker). Prefer `animate: false` with `model.beat` set directly for
  frame assertions.
* `joinViewFactory(ctx: CliContext)` has no clock (`CliContext` has none). Keep its signature
  unchanged: the join view uses the `systemClock` default and only gets `glyphs` from
  `ctx.env.SKEP_TUI_ASCII`. The ticker stops in `close()`, so the existing factory test
  (`ui.test.ts`, no progress) never starts it.

### 4.5 Display width fix (required for the emoji bee)

In `tui.ts` add `charWidth(cp)`: 2 for `U+1F300–U+1FAFF` (emoji, including 🐝 U+1F41D), 1
otherwise. Make `truncate` and the inverse padding in `Screen.draw` count display columns, not
code points. ASCII-only lines are unaffected, so existing truncate tests still pass.

---

## 5. File-by-file changes

### Protocol (Claude Code, VPS)

| File | Change |
|---|---|
| `src/session/progress.ts` **(new)** | `PEER_PHASES`, `PeerPhase`, `RelayPhase`, `PeerProgress`, `percentOf`, `deriveProgress` (pure, §3.2), `subProgress` (pure fn from the sub's item/agent maps, §3.1), `sameProgress(a,b)`, `class ProgressCoalescer` (§2.5). Header comment with the MVP metric. |
| `src/session/messages.ts` | `PeerPhaseSchema`, `ProgressMsgSchema` in the union, `ProgressMsg` type, `SessionStatusSchema.peers[].progress` (required). Import `percentOf` from `./progress.js` (progress.ts must import only *types* from messages.ts to avoid a cycle). |
| `src/session/master.ts` | Extend `Peer` with `progress: { optIn: boolean; reported: … \| null; coalescer: ProgressCoalescer }`. `receive` handles `"progress"`: direction check, redaction, store, first-time opt-in → snapshot, `progressChanged(peer)`. Call `progressChanged` after join (welcome), capability, claim/result (for the assignee), `plan` (for each assignee), and in `dropPeer` (the dropped peer: `left` broadcast; other assignees whose items changed: recompute). `status()` fills `peers[].progress`. Add `MasterOptions.progressIntervalMs`. `close()` cancels the coalescers (they use `this.timer`, which is already aborted). Emit `this.event("progress", peerId)` only on phase changes, not on every frame. |
| `src/session/sub.ts` | `rejected` item state. An `agents` map. Send own progress right after `welcome` (if `o.progress !== false`). Recompute after claim-ack/claim-reject/result-ack/result-reject/`reportAgent`, then send through the coalescer (`wire.timer`) **and** call `o.onProgress?.({ ...self, self: true })` uncoalesced. `case "progress"`: validate the relay direction, then `o.onProgress?.({ ...relay, self: false })`. A callback throw → the existing `callbackFailed`. Default branch unchanged. |
| `src/session/index.ts` | `SubOptions.onProgress?(p: PeerProgress & { self: boolean }): void`, `SubOptions.progress?: boolean`, `SubOptions.progressIntervalMs?: number`, `SubHandle.reportAgent(itemId: string, state: "starting" \| "running" \| "blocked" \| "done" \| "failed"): void` (a no-op after close; an unknown `itemId` throws `ChannelError`), `MasterOptions.progressIntervalMs?: number`. Re-export the types `PeerPhase`, `PeerProgress`. |
| `src/session/messages.test.ts`, `progress.test.ts` (new), `sub.test.ts`, `master.progress.test.ts` (new) | §7 |
| `CHANGELOG.md` | An `[Unreleased]` entry: the feature, the metric, rate limits, the compat note (§2.6). No version heading. |

### CLI / TUI (Codex, box)

| File | Change |
|---|---|
| `src/cli/tui.ts` | `TuiPeer.progress?`. `Glyphs`, `TICK_MS`, `beeLane`, `progressBar`, `charWidth` + width-aware `truncate`/padding. `TuiModel.beat`, `animating()`, the strip row in `listRows`. `TuiOptions.clock/animate/glyphs`. The `Tui` ticker (`maybeTick`, aborted in `close`). `TuiJoinView` passes its options through (no other change: `absorb` already takes `model.peers` and tolerates `item: null`). |
| `src/cli/commands/ui.ts` | `masterSnapshot` maps `peer.progress` → `TuiPeer.progress` when present, and sets `state` to the phase when progress exists. `uiCommand`: pass `clock` and `glyphs` (from `SKEP_TUI_ASCII`) to `new Tui(...)`. `joinViewFactory`: pass `glyphs` only (§4.4). |
| `src/cli/commands/session.ts` | (a) The duplicate `SessionStatusSchema.peers[]` gains `progress` **optional**. (b) `JoinViewModel.peers[number].progress?`. (c) `ItemWorker.onAgentState?(itemId, state)`. In `workItem` it is called inside `report()` and inside `result()` with the final `agentState` (both places already call `view.update`). (d) `joinCommand`: keep a `roster: Map<peerId, peerRow>`, with self first and others ordered by join number (parsed from `peer-N`). `connectSub({... onProgress })`: `self` → update the self row's `progress`/`state`; `left` → delete; otherwise upsert `{ peerId, device, role: role ?? "-", state: phase, progress }`. Then `worker.peers = [...roster.values()]` and `joinView.update({ peers, item: null, agent: null, tail: "", submit: { policy: method } })`. `let subHandle: SubHandle \| undefined`; `worker.onAgentState = (id, s) => subHandle?.reportAgent(id, s)`. Note that `onProgress(self)` may fire **before** `connectSub` resolves, so the roster must not depend on `handle`. (e) `--machine`: `say({ event: "peer-progress", ...p }, human)` **only on a phase change per peer**. The human line (no `--ui`) is `peer <device> <phase> <done>/<total> (<pct>%)`. (f) `renderSessionStatus`: a `PROGRESS` column `"<phase> <pct>%"` or `-`. |
| `src/cli/tui.test.ts`, `src/cli/commands/ui.test.ts`, `src/cli/commands/session.test.ts` | §7 |

Untouched: `channel.ts`, `handshake.ts`, `codec.ts`, `state.ts`, heartbeat, `src/core/**`,
`package.json`, configs, website, docs other than this plan and the CHANGELOG.

---

## 6. Work split and sequencing

| | Claude Code (VPS) — protocol | Codex (box) — CLI/TUI |
|---|---|---|
| Branch | `feat/peer-progress-bee-protocol` (off `main`) | `feat/peer-progress-bee-ui` (off `main`) |
| Owns | `src/session/progress.ts`, `messages.ts`, `master.ts`, `sub.ts`, `index.ts` + their tests; `CHANGELOG.md` `[Unreleased]` | `src/cli/tui.ts`, `src/cli/commands/ui.ts`, `src/cli/commands/session.ts` + their tests |
| Must not touch | `src/cli/**` | `src/session/**` |

Sequencing:

1. **Contract commit first (Claude, small):** `progress.ts` types + `percentOf`, `ProgressMsgSchema`,
   the status `progress` field, and the `index.ts` interface additions. `reportAgent` and
   `onProgress` may be wired as no-ops at this point. `npm run lint && npm test` green. Codex
   rebases onto this commit as soon as it lands. Until then Codex codes against §2.1/§5 verbatim.
   The interfaces are fixed by this plan, so no redesign is needed.
2. Both implement in parallel. Codex's TUI work (§4) depends only on the `PeerPhase` type and the
   shapes in §4.1. It can be finished and tested with fake `onProgress` calls.
3. The parent merges protocol → `feat/peer-progress-bee`, then ui → `feat/peer-progress-bee`,
   runs the e2e (§7.3) and does the manual 联调 (§8).
4. Release later: bump to 0.1.3 and rename `[Unreleased]` → `[0.1.3] - <date>` in a separate
   `chore(release)` commit. **Not part of this work.**

Commit subjects: `feat(session): add peer progress messages and relay`,
`feat(tui): show peer progress bee and bar`.

---

## 7. Tests

### 7.1 Claude (protocol)

* `messages.test.ts`:
  * Accepts the sub form (no identity) and the relay form (identity, `role: null`, `phase: "left"`).
  * Rejects unknown keys, `done > total`, `failed > done`, `percent ≠ floor`, a 121-char
    summary, a bad `itemId`, a bad phase, and non-integers.
  * Status requires `peers[].progress`.
* `progress.test.ts`:
  * `percentOf`: 0/0 → 0, 1/3 → 33, 2/3 → 66, 3/3 → 100.
  * `deriveProgress`: idle with no items; `claimed` → working; all done → done; a dropped item and
    a failed check count as `failed` and `done`; reported `blocked` wins; a summary falls back to
    the claimed title; a reported `itemId` not assigned to the peer is ignored; a secret in the
    reported summary is redacted.
  * `subProgress`: a rejected claim is excluded from total; blocked is sticky.
  * `ProgressCoalescer` with a manual clock: the first push is immediate; pushes within 500 ms
    give one trailing send with the latest value; a phase change is immediate; duplicates are
    dropped; cancel stops the trailing send.
* `sub.test.ts` / `master.progress.test.ts` (real `startMaster` + two `connectSub` over
  `127.0.0.1:0`, as `session.test.ts` does; `progressIntervalMs: 0` or a manual clock):
  1. Both subs opt in after welcome. B receives a snapshot containing A (`device`, `idle`).
  2. A claims an item → B gets `progress` with `peerId = A`, `device = "mac"`, `phase: "working"`.
     A does **not** receive its own relay.
  3. A's result-ack → B sees `done`, 100 %, 1/1.
  4. `reportAgent(item, "blocked")` on A → B sees `blocked`.
  5. A sub with `progress: false` never receives a `progress` frame (an old peer stays connected),
     and its derived progress is still relayed to the other sub.
  6. A sub that sends `progress` with a `peerId` is disconnected.
  7. A disconnects → B gets `phase: "left"`.
  8. `status().peers[].progress` matches the derivation.
  9. Rate limit: 10 progress changes in < 500 ms from A → B receives ≤ 2 frames, and the last one
     is the latest.

### 7.2 Codex (CLI/TUI)

* `tui.test.ts`:
  * `beeLane` for every phase × beats 0–3, unicode and ascii.
  * `progressBar` at 0/37/99/100.
  * An 80×24 `TuiJoinView` frame with a remote working peer at 37 % contains the bee, `███░░░░░`,
    ` 37%` and `working`. Idle shows `·`; done shows `✓`; `done (1 failed)`.
  * A peer without `progress` renders exactly as before (the existing tests stay unchanged).
  * An emoji line is ≤ 80 display columns, and the inverse row is padded correctly.
  * Ticker (fake clock that counts `sleep` calls): it starts only while working or blocked,
    advances `beat`, stops when phases go idle, and `close()` aborts it. With `animate: false`
    there is no sleep.
* `ui.test.ts`: `masterSnapshot` maps progress; a status **without** `progress` still parses and
  renders (old master).
* `session.test.ts`:
  * The duplicate `SessionStatusSchema` accepts status with and without `progress`.
  * `workItem` calls `onAgentState` with starting → running → done (and the blocked/failed paths).
  * `joinCommand` with a fake `sessionApi`: invoking the captured `options.onProgress` updates
    the view's `peers` (self, upsert, `left` removes).
  * `--machine` emits `peer-progress` only on phase changes.
  * `renderSessionStatus` shows the PROGRESS column.

### 7.3 Integration (parent, after both merges; Codex writes it in `session.test.ts`)

Run a real `startMaster` and two `session join --machine` runs: `mac` on repo `app`, `vps` on
repo `api`, dry agent. Submit an intent for `app`. Assert that `vps`'s machine output contains
`peer-progress` for `mac` with `working`, then `done` with `percent: 100`. Assert that
`master.status().peers` shows both with progress.

---

## 8. Acceptance checklist (parent review + 联调)

- [ ] `npm run lint && npm test && npm run build` are green on `feat/peer-progress-bee`.
- [ ] No `Date.now`/`setTimeout`/`Math.random` was added. All timing goes through `Clock`/`timer`.
- [ ] Heartbeat code is unchanged. No blackboard code or references were reintroduced.
- [ ] Progress frames from a sub never carry identity. Relays always carry master-filled
      `peerId`/`device`. There is no echo to the sender.
- [ ] A ≤ 0.1.2 sub (`progress: false`) stays connected to a 0.1.3 master.
- [ ] Coalescing is ≤ 1 frame per 500 ms per subject, and phase changes are immediate.
- [ ] Summaries are only titles, redacted, ≤ 120 chars, and passed through `printable()` in the TUI.
- [ ] Peers without progress render byte-for-byte as before.
- [ ] Lines with 🐝 never exceed the terminal width. `SKEP_TUI_ASCII=1` shows the ASCII set.
- [ ] The ticker runs only while some peer is working or blocked. The CPU is idle otherwise.
      `q` and Ctrl-C restore the terminal.
- [ ] Manual 联调 on two devices. A: `skep session start` + `skep session join --ui`.
      B: `skep session join --host A:port --ui`.
  - [ ] Both TUIs show the other peer's strip (`idle ·`) right after the join.
  - [ ] An intent assigned to A → B's TUI shows A's bee flying, then `✓ 100%`. The reverse
        works too.
  - [ ] A blocked herdr agent on B → A shows `🐝!` pulsing and `blocked`.
  - [ ] Killing B's join → B's row disappears from A's TUI within one frame.
  - [ ] `skep ui` on A shows every peer's strip, updating each second, with the bee animating.
  - [ ] A PTY attach (`a`) suspends the screen, the ticker does not draw over the agent, and
        `resume` redraws.
- [ ] The CHANGELOG `[Unreleased]` documents the metric and the compat note. `package.json`
      is still 0.1.2.

---

## 9. Version note

Ship as **0.1.3** (a patch: the protocol addition is opt-in, and old subs keep working). The
bump and the CHANGELOG heading are a separate release commit by the parent, after 联调.
**Do not bump in this work.**

## 10. Out of scope

* Website changes. `npm publish` / any release or tag.
* The blackboard, `skepd`, or any git-ref transport.
* Token- or time-based progress, ETA, and per-item sub-progress from agent output.
* A peer roster message, or showing other peers' *items* on a sub (a sub sees strips only).
* Negotiating with ≤ 0.1.2 masters (documented as unsupported), and a CLI flag to disable progress.
* Colors and themes beyond the existing inverse/bold styles.
