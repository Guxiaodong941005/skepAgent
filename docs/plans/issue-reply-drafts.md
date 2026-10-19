# Issue reply drafts for 0.3.0

Drafts only; nothing has been posted.

## Issue #1 — Cross-NAT access

Thanks for raising cross-network connectivity. A small clarification: the signed git log and
lease design was removed in v0.1.2. Sessions now use an in-memory master and peers over an
AES-256-GCM encrypted TCP connection after a join-code handshake.

0.3.0 adds `--via-ssh` for joining through an SSH host and exposing a master through an SSH
reverse tunnel, plus guidance for Tailscale/WireGuard and port forwarding. The tunnel carries
already encrypted session bytes. Hosted relay, TURN/STUN and hole-punching are outside 0.3.0.

## Issue #2 — Sudden disconnection

Thanks for describing the recovery need. The signed git log and epoch-fenced leases were removed
in v0.1.2; today's master keeps session items in memory, with heartbeats over encrypted TCP.
Only orchestration records are persisted.

0.3.0 distinguishes lost work from agent failures, warns at 20 seconds of silence when work is
running, and supports explicit retry. Staged runs hold when a required provider is lost, with
`/retry` or deliberate `/skip` to continue. A disconnected peer aborts its agent and keeps its
checkout, printing the path and item state. Session resume and automatic reconnect are outside
0.3.0; a retry can redo work that completed just before the connection was lost.

## Issue #3 — Audit reports

Thanks for the report export suggestion. The signed git event log and leases were removed in
v0.1.2. Current sessions keep master/peer state in memory over encrypted TCP; the orchestration
ledger stores requests, briefs and results locally.

0.3.0 adds offline, read-only `skep session report` and TUI `/report` exports from that ledger,
in Markdown or validated JSON, including stages, per-peer outcomes, changed files and synthesis.
It does not add session event logging, so raw intents and join/leave history are outside the
report. HTML timelines and session resume are outside 0.3.0.
