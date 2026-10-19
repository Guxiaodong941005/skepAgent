# Next release plan (after v0.2.0) — evaluation

Status: **approved for v0.3.0 implementation** (2026-10-19). The product owner approved all §4 recommendations; the release task locks their scope. Inputs: the 3 open
GitHub issues (all of them, fetched 2026-10-19), `docs/plans/skep-skills-iot-workflow.md` §8–9,
and the code at `1161608` (v0.2.0).

## 0. One fact that changes the triage

All three issues describe Skep as a **"signed git linear event log" with "epoch-fenced leases"**.
That architecture was **removed in v0.1.2** (`08cc13e chore!: remove signed git blackboard and
skepd`; README "What was removed in 0.1.2"). `docs/ARCHITECTURE.md` §6 (lease protocol) still
describes it, so it is easy to read the docs and get the wrong picture. Today a session is:

* an in-memory master (`src/session/master.ts`) and subs (`src/session/sub.ts`) on one TCP stream
  each, AES-256-GCM after a join-code handshake (`channel.ts`, `handshake.ts`);
* items tracked in master memory (`planned → claimed → result`), no leases, no epochs;
* the only thing persisted is the **orchestration ledger**
  `~/.skep/projects/<id>/orchestrations/O-*.json` (`src/orchestrator/ledger.ts`, read by `/history`).

So the issues are valid as user needs, but each fix has to target the current session layer, not
the old lease model. Recommended: reply on each issue with this correction once scope is agreed
(see Q1).

## 1. Issue triage

| # | Title | Type | Severity | Effort | In next release? |
|---|---|---|---|---|---|
| 2 | Handle device sudden disconnection and lease timeout recovery | robustness | **High** | M | **In** (scoped) |
| 1 | Relay/TURN or hole-punching for cross-NAT sessions | feature | Medium-High | S (SSH) / L (relay) | **In: SSH helper only**; relay out |
| 3 | Export session logs to readable audit report / HTML timeline | feature | Low-Medium | S-M | **In: Markdown/JSON report**; HTML and TUI tree out |

### #2 — Device disconnection and stuck work (robustness, High, M)

**What the code already does.** Much of the request exists already:

* Heartbeat every 10 s both ways; a link dies after **30 s of silence** (`SessionWire.received`,
  `heartbeat_timeout`).
* The master drops a dead peer: its `planned`/`claimed` items become `failed`, the intent rolls
  up as `intent-failed`, and bounded datalist/capability waits are released (`dropPeer`,
  `master.ts:995`). **Nothing waits forever.**
* The TUI shows `quiet Ns` in red at 20 s (`QUIET_AFTER_MS`), `master quiet Ns` on the sub, and
  on `left` it explains the reason and prints the rejoin line (`run.ts:1241`).

**Real gaps** (these are what users will hit):

1. **No retry / reassign.** A failed item cannot be re-dispatched. A rejoin gets a *new* peerId,
   and items are bound to the old one.
2. **Staged skills keep going after a lost provider.** Failed counts as final
   (`FINAL_VERDICTS`), so in `iot-ble-feature` a `device` peer that drops in `providers` still
   lets `clients` start, with a missing provider result. This is a correctness problem.
3. **"Peer lost" looks the same as "agent failed".** Both show as `failed` in the rollup and in
   the synthesis input.
4. **A link blip kills the peer's work.** When the join closes, the peer aborts its running agent
   (`session.ts:3406`, `abort.abort()`). A 30 s Wi-Fi drop throws away a long agent run.

**Minimal scope for the next release:**

* (a) A distinct `lost` outcome for items whose assignee dropped (keep the `failed` wire state;
  derive `lost` in the master and the reducer). It shows in the rollup, in `/status` and in the
  synthesis prompt. S.
* (b) Staged runs: a `lost` item in a **required** role holds the stage (`awaiting-retry`)
  instead of advancing. The TUI prints `/retry <O-id>` and `/skip <O-id>`. M (reducer + orchestrator
  tests).
* (c) `/retry <item|intent|O-id>`: re-dispatch the lost/failed items to a peer that is connected
  now (same repo/role binding), reusing the original brief. Master-local, with no protocol change
  if it goes through `submitIntent`. S-M.
* (d) A one-time scrollback warning when a peer **with running items** goes quiet (20 s), before
  the 30 s drop. S.
* (e) Peer side: on link loss, do not discard the result. Print the item's checkout/worktree
  path and state so the human can recover the work. Whether to keep the agent running is Q3. S.

**Out (later):** session resume across reconnects (keeping the same peerId with a resume token in
`welcome`, the sub reconnecting on its own, the result delivered after reconnect). This is a
protocol v3 change, effort L. It is the real fix for gap 4 and the best candidate for the release
after this one.

### #1 — Cross-NAT sessions (feature, Medium-High, S for SSH / L for relay)

**What the code already does.** `--listen` binds a concrete address and `--advertise <host:port>`
sets the address peers dial; the CHANGELOG describes it as for "NAT, public IP, relay". A manual
`ssh -L` / `ssh -R` tunnel works today. `SubOptions.stream` already accepts any `Duplex`, so the
transport can be swapped without touching the protocol. The channel is end-to-end encrypted and
authenticated by join code + fingerprint, so **a tunnel or relay only carries bytes and does not
need to be trusted**. That makes relays safe to add later.

**Minimal scope for the next release:**

* `skep session join --via-ssh [user@]host` and `/join … --via-ssh …`: spawn
  `ssh -W <master-host:port> user@host` (`execFile`/`spawn`, `shell: false`) and pass its stdio as
  `stream`. This needs no local port and covers "laptop dials headless GPU box".
* `skep session start --via-ssh [user@]host` / `/start --via-ssh`: spawn `ssh -N -R` so a master
  behind NAT can be reached from a public server; the printed paste line uses the remote end. This
  covers "laptop is master, GPU box is the peer".
* A README section "Across networks": SSH, Tailscale/WireGuard (no code needed), and
  `--advertise` with port-forwarding.
* Effort S-M (the ssh process lifecycle and error mapping need tests with a fake spawner).

**Out:** a hosted relay/TURN/STUN service or hole-punching (L, plus ongoing ops cost and a
privacy story to write), and Windows ssh specifics.

### #3 — Audit report export (feature, Low-Medium, S-M)

**What the code already does.** The git event log is gone. The ledger keeps one JSON per
orchestration: user text, synthesis, skill id/digest, contract, role bindings, stages and the
reducer state with per-item verdicts (all already redacted). `/history` lists recent ones as one
line each. Raw `/intent` traffic and join/leave events are **not** persisted.

**Minimal scope for the next release:**

* `skep session report [O-id|--last N] [--json]` and `/report`: render ledger records as
  Markdown. Per orchestration: request, refined brief, skill/contract, stages, per-peer items
  (device, role, repo, verdict incl. `lost`, changed files, summary), and synthesis. `--json`
  emits the validated records. Read-only and offline. S.
* Optional, if cheap: append master session events (joined/left with reason, item results) to a
  redacted `sessions/<sessionId>.jsonl` in the project home, so the report can include a timeline
  and per-device contribution. M. Decide with Q4.

**Out:** HTML timeline and the TUI tree view (reconsider after the report has real users).

## 2. Proposed scope, in order

| Order | Item | Effort | Why |
|---|---|---|---|
| 1 | #2 (a)–(e): `lost` outcome, staged hold, `/retry`, early warning, keep peer work | M | Reliability is the precondition for the "cross-device" headline. Gap 2 is a correctness bug in v0.2.0's main new feature. |
| 2 | #1 `--via-ssh` (join and start) + "Across networks" docs | S-M | Lets the headline scenario (laptop + remote GPU box) work outside a LAN. Uses the existing `stream` seam. |
| 3 | #3 `session report` (Markdown/JSON from the ledger) | S | Cheap and closes the issue honestly; also helps users debug orchestrations. |
| 4 | **Per-peer targeting** (`peerIds` on intents, additive v2; Skills Phase 4) | M | Fixes merged briefs when two peers share a repo (monorepo ios+android, R4/R7). `/retry` to a specific peer needs it too. |
| 5 | **Follow-up into a running orchestration** (`/followup <O-id> <text>`, covers Skills Phase 2 `/skill followup`) | M | The "insert new tasks into a long session" ask. It reuses the run's conversation and contract and re-briefs only the named roles. Today the only option is a separate new orchestration. |
| 6 | **Skill authoring** (`/skill new`, `skep skill lint`, `/intent --role`) | S-M | Skills Phase 2. Small, and makes Skills usable beyond the two packaged ones. Can slip without hurting the release. |

Cut line: items 1–4 are the release. 5–6 go in if time allows; 6 is the first to drop.

**Explicitly out:** session resume v3 (target the next release), hosted relay, Windows support
(PTY/herdr, path and signal handling: separate, large), Cloudflare Pages deploy (ops, not product;
see Q6), HTML report.

## 3. Version: **0.3.0**

* It adds user-facing commands (`/retry`, `/report`, `--via-ssh`, `/followup`) and an **additive**
  protocol field (`peerIds`). Under pre-1.0 semver that is a minor bump. Older peers stay
  compatible; the additive v2 field is negotiated like ORCH-6.
* A staged run now holds instead of advancing when a required role is lost. This is a visible
  behaviour change, and a patch (0.2.1) should not carry it.
* If only the issue fixes ship (items 1–3), I would still use 0.3.0 because of `/retry` and
  `--via-ssh`. 0.2.1 is right only for a hotfix of gap 2 alone.
* Suggested theme: **"Reach & Recovery"**. It fits the cross-device narrative; Skills stays a
  secondary item.

## 4. Risks and open questions (need your decision)

| # | Question / risk | Recommendation |
|---|---|---|
| Q1 | The issues rely on the removed git-log/lease design. Should we reply on GitHub to correct the premise, and fix `docs/ARCHITECTURE.md` §6 so it no longer reads as current? | Yes to both. Mark ARCHITECTURE §6 "historical (removed 0.1.2)". |
| Q2 | When a required role is lost in a staged run: hold for `/retry`, or fail the orchestration? | Hold, with `/skip` to continue on purpose. |
| Q3 | Peer side on link loss: keep the agent running (risk: orphan process editing a checkout) or abort and keep the checkout (current abort + print path)? | Abort and keep the checkout in 0.3.0. Keep the agent running only once resume v3 exists. |
| Q4 | Persist a per-session event JSONL (new data at rest, redacted, 0600) for #3, or ledger-only? | Ledger-only unless "device contribution" matters to you now. |
| Q5 | `--via-ssh` requires an `ssh` client and key auth. With `ssh -R` the master sees the peer as `127.0.0.1`, so the approval prompt shows a loopback address and the fingerprint becomes the only identity cue. Acceptable? | Yes. Label it "via ssh" in the prompt and keep the token check for control requests (already enforced). |
| Q6 | Hosted relay: ever? It would make Skep an operated service (cost, abuse, privacy wording on the site). | Not in 0.3.0. Revisit after measuring `--via-ssh` uptake. |
| Q7 | Cloudflare Pages is unused (the site is served via a tunnel). Remove the config, or move the site to Pages for availability? | Your call. It is unrelated to the npm release; keep it off this release's critical path. |
| R1 | `/retry` could double-apply work if a "lost" peer actually finished and reconnects later. | Without resume a late result is rejected (new peerId). Document it; v3 resume fixes it properly. |
| R2 | `peerIds` and `/followup` touch the reducer and prompts (`PROMPT_VERSION` bump), which conflicts with parallel work. | Land #2 reducer changes first, then `peerIds`, then `/followup`. |


## 5. v0.3.0 implementation choices

The release includes scope items 1–4. Optional follow-up injection (5) and skill authoring (6)
are deferred. The locked release task takes precedence over the original proposal above.

* Recovery is explicit and master-local: use the shell owning the live master. A retry needs
  an already advertised repo/role binding; without `--peer`, choose the first connected match.
  Retry attempts have new intent/item IDs. Prior attempts remain in the ledger but stop gating
  stage progress. A deliberately skipped item is excluded from subsequent run-level retries;
  send a new request to include that role later. Failed submits are not agent failures and are
  not automatically rerun. Quiet warnings occur once per peer connection, only with running items.
* SSH uses batch/key authentication and SSH config aliases for custom ports and destination IPv6.
  Reverse start defaults to local loopback and allocates a dynamic remote loopback port. The
  printed join line uses `127.0.0.1:<allocated-port> --via-ssh <destination>`; clients need SSH
  access to that server. This needs no GatewayPorts or public listener. Reject `--advertise`
  combined with `--via-ssh`. Wait up to 15 seconds for reverse-forward readiness, using Clock.
  Tunnel failure ends the associated session. OpenSSH handles host key/auth policy.
* Reports default to one recent record; `--last` accepts 1..100. JSON is always an array of full,
  validated records, newest first; global `--machine` retains the normal success envelope. A
  short `O-1` selector must be unambiguous; full ledger IDs from `/history` always disambiguate.
  Invalid records are reported and excluded. Existing pre-skill records remain readable.
* `peerIds` is additive on v2 intents/control requests. Routing is enforced by the master even
  for v1 or older v2 recipients. The new wire field is sent only to peers advertising 0.3.0 or
  later; older recipients get the original shape. A refused targeted control request never
  falls back to broader routing. Role briefs merge only when the bound peer is the same.
  Prompts are versioned at 5 (recovery context plus per-peer role wording).
* No relay, session resume, per-session event JSONL, HTML report, publishing, tagging, or changes
  to Cloudflare Pages configuration are included. GitHub issue replies remain local drafts.
