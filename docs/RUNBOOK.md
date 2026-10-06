# Skep runbook

Operating procedures for one human and the MVP devices (`mac`, `vps`). Normative detail is in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §3, §6.4, §11, §16, §17 and
[`PRD-v0.4.md`](PRD-v0.4.md) §11, §13.3, §15.2. This document says what to do; it does not change
the protocol.

Every example host is `example.invalid`. Nothing below is a real address, and no command copies a
credential off the machine you are typing it on.

## What a device runs

One `skepd` per device (ARCHITECTURE §3). It holds `$SKEP_HOME/skepd.lock`, replays the blackboard,
and is the only process that writes git. The `skep` CLI talks to it through the Unix socket
`$SKEP_HOME/skepd.sock` (mode 0600, directory 0700). When `skepd` is not running, the CLI falls
back to its own private clone (`$SKEP_HOME/cli-blackboard`) and the same publisher.

```text
human ──► skep ──unix socket──► skepd ──fetch/push──► git remotes (example.invalid)
                                  └─ spawn ──► agent CLI, as the agent OS user
```

**Outbound only (D18).** Devices never connect to each other. There is no mesh VPN, no inbound
port and no fixed IP. Each `skepd` makes outbound connections to the blackboard remote, the code
remotes and, if configured, one ntfy URL. Tailscale or SSH are conveniences for the human, never
dependencies. The optional hint relay (Wave 7, SK-701) is not part of this runbook.

**No provider credentials (D19).** Skep never transports, stores, syncs or brokers provider
credentials, API keys or provider configurations between devices, in any form: not as plaintext,
not as ciphertext, not as a hash, and not as a label. Configure each device's agent CLIs locally,
on that device. `skep doctor` checks that the pinned CLI is installed at the pinned version; it
does not read how the CLI is logged in.

Service units: [`deploy/skepd.service`](../deploy/skepd.service) (systemd) and
[`deploy/com.skepagent.skepd.plist`](../deploy/com.skepagent.skepd.plist) (launchd). Both pass the
flags `skepd` actually accepts (`--home`, `--role-dir`, `--agent-user`, `--agent-home`,
`--agent-path`) and neither opens a port.

## Layout on a device

`$SKEP_HOME` defaults to `~/.skep` (override with `--home` or `SKEP_HOME`). Mode 0700, owned by the
daemon user.

| Path | What it is |
|---|---|
| `device.toml` | Local config (`skep.device/v1`): device name, blackboard URL, repo allowlist, signing key path, optional ntfy URL. Never read from the blackboard. |
| `keys/daemon`, `keys/daemon.pub` | Daemon SSH signing key (ed25519, no passphrase, mode 0600). The private half never leaves this device. |
| `allowed_signers` | **The** trust root. Local file, not the copy in the blackboard repo. |
| `blackboard/` | Daemon's private clone. Do not edit it; `skepd` resets it. |
| `skepd.sock`, `skepd.lock` | CLI socket and the single-daemon lock. |
| `roles/<role>/AGENT.md` | Role policy. Owned by the daemon user, not writable by the agent user. |

The agent OS user (`skep-agent` in the units) can read its role directory and its worktrees. It
cannot read `keys/`, `device.toml` or the blackboard clone.

## 1. Setup

Do this from the device's own console or shell. No step dials the device from another machine.

### 1.1 Controller (the Mac that holds the human key)

The human key lives only here, in `ssh-agent` (a presence-confirming key where possible). It is
never copied to `vps` and never readable by the agent user.

```bash
# On mac, as the daemon user.
ssh-keygen -t ed25519 -C human@example.invalid -f ~/.skep/keys/human
# Load it into the agent. The private key stays on mac.
ssh-add ~/.skep/keys/human

skep init \
  --device mac \
  --blackboard git@git.example.invalid:example/blackboard.git \
  --genesis \
  --human-key ~/.skep/keys/human \
  --repo demo=git@git.example.invalid:example/demo.git
```

`skep init` writes `device.toml`, generates `keys/daemon`, and with `--genesis` creates the
human-signed root commit of the blackboard. It prints two public lines: the daemon's
`allowed_signers` line and, when `--human-key` is set, the local trust root text. It refuses to
overwrite an existing `device.toml` or daemon key. Re-running with the same `--device`,
`--blackboard` and `--genesis --human-key` retries a failed genesis without minting a new key.

Write the trust root it printed (human line, then daemon line), mode 0600:

```text
human namespaces="git" ssh-ed25519 AAAA... human@example.invalid
daemon:mac namespaces="git" ssh-ed25519 AAAA... skepd
```

Compare fingerprints before trusting the file you just wrote (see §2). `policy/allowed_signers.txt`
inside the blackboard repo is an informational copy; no device reads it for trust.

### 1.2 Any other device (`vps`)

On `vps`, from its own console:

```bash
skep init \
  --device vps \
  --blackboard git@git.example.invalid:example/blackboard.git \
  --repo demo=git@git.example.invalid:example/demo.git
```

Copy the printed line somewhere you can read on the controller. Any channel is fine (a terminal
you are already sitting at, paste, QR): the line is a public key, and the private key never
leaves `vps`. On the controller, append that line to `allowed_signers`:

```text
daemon:vps namespaces="git" ssh-ed25519 AAAA... skepd
```

Then install the **whole** trust root back onto `vps` by any channel, and compare fingerprints
out of band before `skepd` starts using it (§2). Until that comparison succeeds, `vps` must not
treat the file as trusted. This manual copy is the MVP; signed enrollment bundles (SK-702) replace
it later and still carry public keys only.

`vps` has no human key. Human-signed commands (`task new`, `plan approve`, `lease revoke`,
`decide`) are run on the controller, which asks `ssh-agent` to sign.

### 1.3 Install the daemon

Build `dist/bin/skepd.js` (`npm run build`) and install it where the unit points
(`/usr/local/lib/skep/skepd.js`), with `node` on the path the unit uses.

Linux (`vps`), as root:

```bash
install -d -m 0755 -o skep -g skep /var/lib/skep
install -m 0644 deploy/skepd.service /etc/systemd/system/skepd.service
systemctl daemon-reload
systemctl enable --now skepd.service
```

macOS, as the daemon user (substitute the account name in the plist first):

```bash
cp deploy/com.skepagent.skepd.plist ~/Library/LaunchAgents/
launchctl bootstrap "gui/${UID}" ~/Library/LaunchAgents/com.skepagent.skepd.plist
```

Create the role directory before starting, or `skepd` will exit and the supervisor will restart
it. One slot per device in the MVP:

```bash
install -d -m 0755 ~/.skep/roles/coding
# AGENT.md is daemon-owned and must not be writable by the agent user (PRD §7.3).
```

`AGENT.md` front matter (`skep.agent/v1`) pins `agent_cli` and `cli_version`. `skepd` refuses the
slot unless `probe()` reports exactly that version.

### 1.4 Configure the agent CLI locally (D19)

On **each** device, as the agent OS user, log the agent CLI in the way that CLI documents, into
that user's own config directory. Skep does not read, copy, pass or log that configuration, and
there is no command that copies it to another device.

The units pass `--agent-home` and `--agent-path`. `--agent-path` is the only `PATH` the agent
subprocess gets. To point the CLI at a config directory other than its default, add
`--agent-config-dir <dir>` to the unit's arguments; that sets the CLI's own config variable
(`CODEX_HOME` for the Codex adapter) and nothing else.

### 1.5 `GH_TOKEN` for headless `gh` (code host, not a provider)

Opening and merging PRs uses the `gh` CLI as the **daemon user**. Authentication is `gh`'s own
local config (`gh auth login` as the daemon user). That is the preferred setup, and the shipped
units set no token.

On a headless host where `gh auth login` is impractical, a fine-grained token that can see only
the allowlisted code repos may be passed **explicitly** to `skepd` as `GH_TOKEN`. This is a
code-host credential of the daemon, not a provider credential, and D19 does not forbid it — D19
forbids provider credentials and forbids moving any credential between devices. The rules:

* Create the token on the code host. Carry it to this device yourself; Skep never fetches it.
* Put it in a file mode 0600 owned by the daemon user, for example `/etc/skep/gh-token`, and load
  it in a systemd drop-in (`EnvironmentFile=/etc/skep/gh-token`) or the launchd plist's
  environment. Do not write it into `device.toml`, the blackboard, a unit file committed to git,
  or the agent user's environment.
* `GH_TOKEN` in `skepd`'s own environment is visible to `gh`, which reads it itself. It is not
  forwarded to agent subprocesses or to check commands (see the denylist below). `GITHUB_TOKEN` is
  not read.
* Rotate it like any other host credential: replace the file, restart `skepd`. Nothing in the
  blackboard changes.

### 1.6 Check environment denylist

Agent subprocesses and trusted checks start from a stripped environment (PRD §11.4,
`src/exec/sandbox-env.ts`, `src/exec/checks.ts`). An agent receives only:

`PATH` (from `--agent-path`), `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR`, `TERM`, plus `HOME`, `USER`
and `LOGNAME` set to the agent user, plus at most one CLI config variable (`CODEX_HOME`,
`CLAUDE_CONFIG_DIR` or `PI_CODING_AGENT_DIR`).

Check commands (`.skep/checks.toml` at the plan's base commit) may add build variables, but a
name is dropped when it matches the conservative denylist:

```text
GIT_*, SSH_*, GH_*, GITHUB_*, OPENAI_*, ANTHROPIC_*, AZURE_*, AWS_*, GOOGLE_*, GEMINI_*,
CODEX_*, CLAUDE_*, PI_CODING_*
and any name containing KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL(S), AUTH or PROVIDER
```

The filter is deliberately broad: harmless names such as `CACHE_KEY` are stripped too. Checks
also cannot override `HOME`, `USER` or `LOGNAME`. Git commands the daemon itself runs keep only
`PATH`, `HOME`, `SSH_AUTH_SOCK` and `TMPDIR` from the daemon environment.

So a `GH_TOKEN` set for headless `gh` never reaches an agent or a check, and a provider key in
the daemon's environment never reaches one either. Do not rely on that as the only control: do
not put provider keys in the daemon environment in the first place.

### 1.7 Pre-flight

```bash
skep doctor
skep doctor --roles-dir ~/.skep/roles
```

`skep doctor` checks `device.toml`, the trust root (it must contain `daemon:<this device>`), the
signing key mode, each `AGENT.md`, the pinned CLI's presence and version, `gitleaks` on `PATH`,
outbound reachability of the blackboard and allowlisted code remotes, free disk, then a full
replay and the invariant check. Clock skew is a warning. A hint-relay URL, if you exported
`SKEP_RELAY_URL`, is a warning: the system is correct without it. There is no provider check.

Notifications are optional. Set `notify.ntfy_topic_url` in `device.toml` to an `https://` URL on a
host you run (an example shape is `https://ntfy.example.invalid/skep-example`). The topic URL is
not a credential; message bodies are redacted before they are sent.

## 2. Trust root and fingerprint comparison

The trust root is local on every device. Changing it is a local edit (PRD §11.2); nothing in the
blackboard can change who a device trusts.

Whenever a public key or an `allowed_signers` file arrives, compare fingerprints **out of band**
before trusting it. Read the fingerprint on the machine that generated the key and again on the
machine that will trust it, and compare them by eye (or by reading one aloud):

```bash
ssh-keygen -l -f ~/.skep/keys/daemon.pub
# On the device that received the file:
ssh-keygen -l -f ~/.skep/allowed_signers
```

`ssh-keygen -l` over `allowed_signers` prints one fingerprint per line. Check the principal
(`human`, `daemon:mac`, `daemon:vps`) as well as the fingerprint: a correctly fingerprinted key
listed under the wrong principal is still a trust-root compromise.

First trust is never taken from the channel that carried the file. A later signed trust bundle
(SK-702) will carry the same public keys and still be applied by a local command.

## 3. Key rotation

Rotate a key when it may have leaked, when a device is rebuilt, or on a schedule you choose.
History stays valid: old commits keep verifying against the old public key, so the old public key
stays in `allowed_signers` until you deliberately retire it. The private half is deleted once the
new key signs successfully.

### 3.1 Daemon key (`daemon:mac`, `daemon:vps`)

On the device, as the daemon user, with `skepd` stopped so it is not signing mid-rotation:

1. `ssh-keygen -t ed25519 -N "" -C skepd -f ~/.skep/keys/daemon.new`
2. Note the fingerprint (`ssh-keygen -l -f ~/.skep/keys/daemon.new.pub`).
3. On the controller, append a new line, do not replace the old one yet:

   ```text
   daemon:vps namespaces="git" ssh-ed25519 AAAA... skepd
   ```

4. Install the updated trust root on **every** device, with fingerprint comparison (§2). A device
   that has not received it will treat the rotated daemon's commits as `unknown_key` and alarm.
5. On the device: move `keys/daemon` to `keys/daemon.old`, move `keys/daemon.new` to
   `keys/daemon`, `chmod 0600` the new key, and point `signing_key` in `device.toml` at it if the
   path changed. `skep init` will not do this for you; it refuses to replace an existing key.
6. Start `skepd`. Publish something small (for example `skep agent start` once the slot is up) and
   confirm on another device that the commit verifies (`skep doctor` reports a clean replay).
7. Shred `keys/daemon.old`. Keep the old public line until every commit you still need to verify
   was signed by the new key; then delete the old line from every device's trust root, again by a
   local edit.

### 3.2 Human key

The human key is only on the controller. Generate the replacement there, add its public line
**above** the old `human` line (both verify during the overlap), install the trust root on every
device with fingerprint comparison, sign one event with the new key (`ssh-add` the new key and
remove the old from the agent), confirm other devices accept it, then remove the old private key
and, once you no longer need it, the old public line.

A stolen human key is a trust-root compromise, not just a leak: whoever holds it can create tasks
and approve plans. Prefer re-genesis (§5) if the old key may have signed events you did not.

### 3.3 Code-host and leaked secrets

A leaked `GH_TOKEN` or git deploy key is rotated at the code host. Revoke it there, write the
replacement into the local file from §1.5, restart `skepd`. No blackboard event is involved.

If a provider key, token or password was printed into a commit, a PR, a journal or the blackboard,
rotate it at the provider **first** (history is immutable, so rotation is what stops use). Then
decide whether the blackboard copy must disappear; if it must, re-genesis (§5) is the only purge.
`gitleaks` plus the redactor are what normally stops a publication (`work.failed` with
`secret_detected`, nothing published).

## 4. Revoke a lease

Leases do not expire on a timer. A device that sleeps shows as `stale` or `lost` in
`skep status` (observer-relative), and the status output suggests the exact command. Revocation
is manual and human-signed, on the controller (ARCHITECTURE §6.4):

```bash
skep status
skep lease revoke <task> <item> --epoch <n> --reason "holder lost"
```

The epoch must be the one the holder currently has; if the holder already moved on, the reducer
rejects the event and the CLI prints `rejected` with the reason. A successful revoke fences that
epoch: the holder's later delivery is rejected, its branch for that epoch is not merged, and the
item can be claimed again under the next epoch. The revoked daemon journals the attempt `stale`
and keeps the branch.

Run `skep log <task>` to see the `lease.revoked` outcome and `#seq`.

### 4.1 Moving an item to another agent

There is no reassign event. A claim is accepted only for the agent the approved plan names as the
item's assignee, so editing a wish-list does nothing.

**Moving an item to another agent requires a revoke plus a human-approved replan.**

1. If the item is currently leased, revoke that epoch (§4) so the holder cannot deliver.
2. Send the task back to planning. Either:

   ```bash
   skep replan <task> --reason "move W2 to vps.coding"
   ```

   or, when the task is already `escalated`:

   ```bash
   skep decide <task> --replan --note "move W2 to vps.coding"
   ```

3. The owner proposes a new plan that names the new assignee. Carried-over items (identical
   definition, already delivered or merged) stay carried over; the moved item is new work.
4. Approve that plan. The new assignee claims it under a new epoch:

   ```bash
   skep plan show <task>
   skep plan approve <task> --note "assignee moved"
   ```

Until the approval, the previous plan is still the one in force. Do not expect `skep agent stop`
on the old device to transfer the item; stop only ends that device's slot.

## 5. Re-genesis

Re-genesis is the human-only purge (PRD §11.5). Use it when blackboard history itself must go:
a secret was published, the human key was stolen and may have signed events, or you are
abandoning a log. It is not automated. It builds a **new** blackboard repository whose first
commit is a human-signed genesis plus a human-signed checkpoint of the state you chose to keep.
The old repository stays as a read-only archive until you delete it by hand.

Re-genesis does not rewrite code repos, PRs or the agent worktrees. Branches already pushed stay
pushed. Provider configuration is untouched because Skep never had it (D19).

### 5.1 Freeze

1. Stop scheduling new work: do not run `skep task new`. Let running attempts reach a delivery or
   a checkpoint, or revoke them (§4) if you cannot wait.
2. On every device, stop `skepd` (`systemctl stop skepd` / `launchctl bootout`). Stopping first
   avoids a daemon pushing one more commit to the old remote while you cut over.
3. On the controller, fetch and record the tip you are snapshotting:

   ```bash
   skep doctor
   ```

   The replay section reports the tip sha and seq. Write them down; they name the state you kept.

### 5.2 New blackboard

Create an empty private repository at the code host (example URL
`git@git.example.invalid:example/blackboard-2.git`). Do not seed it with a README; the genesis
commit must be the root.

On the controller, point a fresh home at the new remote and create the genesis. Using a separate
directory keeps the old trust root intact until the new log verifies:

```bash
skep --home ~/.skep-new init \
  --device mac \
  --blackboard git@git.example.invalid:example/blackboard-2.git \
  --genesis \
  --human-key ~/.skep/keys/human \
  --repo demo=git@git.example.invalid:example/demo.git
```

Copy the trust root you still trust (every current public key, after any rotation) into
`~/.skep-new/allowed_signers`, then compare fingerprints (§2).

### 5.3 Checkpoint of current state

The genesis commit carries no task state. Record what you are keeping as ordinary human-signed
events on the new log, using the CLI against the new home:

* Re-create each task you are keeping with `skep --home ~/.skep-new task new "..." --repo demo
  --owner <agent>`. Descriptions only; do not paste anything that triggered the purge.
* For a task whose plan you are keeping, let the owner propose again and approve it. Delivered
  work stays in the code repo; the new plan should describe the remainder, not redo merged items.
* Agents re-register themselves when their `skepd` starts against the new remote. You do not copy
  `agent.registered` events across.

There is no event that imports the old log, on purpose: an import would copy the history you are
purging.

### 5.4 Cut over

1. On each other device, replace `blackboard.url` in `device.toml` with the new remote. Install
   the same `allowed_signers` you verified on the controller (§2).
2. Move the old clone aside (`mv ~/.skep/blackboard ~/.skep/blackboard.old`) so `skepd` clones the
   new remote instead of fetching into the old one.
3. Start `skepd` on the controller, then on the other devices. Run `skep doctor` on each. Every
   device should report the new genesis tip and a clean invariant check.
4. Archive the old remote as read-only. Delete it only after you are sure nothing you need is
   solely in it. Deleting the remote does not delete clones; remove `blackboard.old` and any
   backup mirrors yourself.

If a daemon was offline during the cut over, it still holds the old URL and will keep trying the
old remote (fail closed). It does not discover the new one. Update its `device.toml` before
starting it.

## 6. Everyday commands

Run human-signed commands on the controller.

| Command | When |
|---|---|
| `skep status` | Tasks, items, liveness, sync freshness, alarms. Suggests a revoke for a stale holder. |
| `skep log <task>` | Outcomes with reasons, in log order. |
| `skep task new "<text>" --repo <name> [--owner <agent>] [--team]` | Create a task. English body; `--allow-non-english` overrides the guard. |
| `skep plan show <task>` | Plan, reviews, overrides. |
| `skep plan approve <task>` / `skep plan reject <task>` | The human gate. `--hash` pins the exact plan. |
| `skep replan <task> --reason "..."` | Human-initiated replan. |
| `skep lease revoke <task> <item> --epoch <n>` | Fence one epoch (§4). |
| `skep decide <task> --resume` / `--replan` / `--cancel` / `--owner <agent>` | Resolve an escalation. Exactly one of these. |
| `skep task cancel <task> --reason "..."` | Cancel. |
| `skep agent start --role-dir <dir>` | Register and start the local slot. |
| `skep agent stop --role-dir <dir>` | Interrupt, then checkpoint. Does not move work (§4.1). |
| `skep doctor` | Pre-flight, replay, invariants (§1.7). |
| `skep logs <agent>` | Local agents only. A remote agent's logs stay on its device (D18); `skep status` shows its last heartbeat. |

`--machine` prints one JSON line. `--home <dir>` selects a different state directory (used in §5).

## 7. Failure

| What you see | What to do |
|---|---|
| `skepd` exits on start | `skep doctor`. Common causes: missing `device.toml`, trust root without this device's principal, signing key mode other than 0600, role directory absent, pinned CLI version mismatch. |
| Two daemons, one device | The second fails to take `skepd.lock`. Stop the stray process; do not delete the lock of a running daemon. |
| Blackboard remote down | Writes fail closed. Invocations finish locally and publish after the remote returns, re-verifying the lease first. No second remote: a writable failover would split the log. |
| Code host down | Delivery retries. PR creation is idempotent; a crash mid-push is reconciled on restart. |
| Holder `stale` or `lost` | Expected while a laptop sleeps. On wake it catches up by replaying. Revoke (§4) only if you want the epoch fenced. |
| `unknown_key` alarm | A commit was signed by a key this device's trust root does not list. Usually a rotation that has not been installed here (§3), or a push that bypassed `skepd`. |
| Task `escalated` | `skep decide`. Verification failure (`passed: false`) does not retry on its own. |
| Secret in a publication | Rotate first (§3.3), then re-genesis (§5) if the blackboard copy must be purged. |

A reducer version this daemon does not implement puts it in read-only mode and raises an alarm; it
does not loop on the crash. Changing the pinned reducer version of a live blackboard is a
re-genesis, not a flag.
