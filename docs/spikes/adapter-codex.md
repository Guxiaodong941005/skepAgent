# SK-207: pinned Codex CLI adapter spike

## Decision and evidence

Use **Codex CLI**, pinned to the exact version string **`codex-cli 0.160.0`**. Set the agent's
`AGENT.md` `cli_version` to that entire string. Do not silently upgrade the executable.
`CodexAdapter.probe()` runs only `codex --version`, reports the exact version, rejects a different
pin, and never installs anything. The daemon must also compare the returned version with the
agent's `AGENT.md` before invoking (ARCHITECTURE §9.2; PRD §13.1).

Locally verified without a model invocation: `codex --version`, `codex --help`, and
`codex exec --help` on the installed binary. These establish the pin, non-interactive exec mode,
stdin prompt, configuration override, sandbox, schema, last-message, and JSONL flags. The CLI
printed a read-only PATH-alias warning on stderr; the version probe ignores such diagnostics.
The official OpenAI documentation endpoint
<https://developers.openai.com/codex/cli/reference/> could not be fetched because DNS/network
access is unavailable in this environment; no claim here relies on an unfetched page.

**Live model output, CLI-local authentication, and cooperative SIGINT handling have not been
verified in this sandbox.** Real CLI calls require the explicit opt-in below. Fixtures are
hand-made examples, not recordings of a live session. Unit tests establish adapter behavior,
including stopping a still-running process on approval, timeout, and abort. The opt-in integration
tests are the remaining device-level check, not permission to change provider configuration.

Codex exposes every required interface flag, so there is no demonstrated reason to select a
fallback. Keep Codex as the MVP adapter; require the real smoke tests before deploying it on a
device. If that device's pinned binary cannot produce schema output or stop with the signal
ladder, evaluate pinned `claude -p --output-format json` (and its schema flag if supported).
`pi -p` remains the secondary fallback. Neither fallback is implemented or silently selected.

## Exact invocation

The following is a readable rendering of an argv array, **not a shell command built by Skep**:

```text
codex -c approval_policy="never" exec --json
  --output-schema <scratch>/schema.json
  --output-last-message <scratch>/last.json
  --sandbox workspace-write --skip-git-repo-check -C <cwd> -
```

`RuntimeBackend.spawn()` receives each flag/value as a separate argument, `cwd` as the worktree,
the caller's complete sanitized `env`, and the prompt as `stdin`. The runtime must close stdin
after writing the prompt. The prompt and credentials never appear in argv; no shell interprets
prompt metacharacters. Production runtime uses a detached process group (ARCHITECTURE §10.1).
`codexPath` can select an absolute executable path when the binary is outside the runtime's PATH.

The explicit `-c` TOML override pins `approval_policy` to `never` even when the human's local
config has another default. No approval or sandbox bypass is used. `--sandbox workspace-write`
limits CLI tools to the worktree according to the CLI sandbox; agent-user isolation and the
sanitized environment remain the daemon's responsibility (§16). The `-` argument tells exec
to read the prompt from stdin. `--skip-git-repo-check` permits read-only planning checkouts and
isolated test directories that do not have git metadata.

The daemon owns the scratch directory and supplies a distinct scratch/log location per concurrent
invocation. The adapter creates `schema.json` from `AdapterInvocation.outputSchema`, removes any
old `last.json`, and starts a fresh combined stdout/stderr log at `logPath`. `--output-schema`
constrains the CLI's final response; `--output-last-message` writes the raw final assistant text.
The adapter returns that file verbatim, including malformed JSON, or `null` when absent. Zod
validation and the single repair belong to SK-307's structured runner (§9.1–§9.3); a zero exit
code is not a validated work report and a nonzero exit still returns the raw result.

## JSONL events and usage

`--json` requests newline-delimited events on stdout; the runtime sends stdout and stderr into
the supplied capture log. `test/fixtures/codex/*.jsonl` illustrates:

```json
{"type":"thread.started","thread_id":"example-thread"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"ok\":true}"}}
{"type":"turn.completed","usage":{"input_tokens":120,"cached_input_tokens":40,"output_tokens":12}}
```

Usage is taken from the last valid `turn.completed.usage` (also accepting `thread.completed`
fixtures and legacy `token_count.info.total_token_usage`, including a `codex/event.msg` wrapper).
Map `input_tokens` and `output_tokens` to the strict shared `UsageSchema`. Both must be
nonnegative integers. Cached input is already part of the CLI input count; do not add it again.
`cached_input_tokens` and `total_tokens` have no shared fields and are omitted. No dollar cost
is inferred: `cost_usd` remains absent because these events do not report it. Missing or malformed
usage returns `null`; unknown usage is never fabricated from final-message text. Counters and
capture logs are local attempt information, never blackboard events (D19).

CLI event envelopes are validated with local Zod schemas that allow telemetry additions; they
are not Skep protocol objects. Projected usage is validated with the strict core schema. Unknown
events, plain stderr warnings, non-event JSON, and torn JSONL records do not become telemetry.
They remain in the raw capture for diagnostics. Poll the append-only log every 50 ms using the
injected `Clock`, read only new bytes, and preserve partial UTF-8/JSONL records between reads.
After process exit, drain the remaining bytes, including a final JSON record without a newline.
A record exceeding 1 MiB or a capture failure throws `CodexAdapterError` after stopping the CLI.

## Approval and interruption

Approval detection checks the event type, `item.type`, and the legacy `msg.type` for
`approval_request`, `approval_requested`, `exec_approval_request`,
`apply_patch_approval_request`, `command_execution_approval_requested`,
`file_change_approval_requested`, or `request_user_input`. A request stops the process through
the injected ladder and returns `permission_prompt`; Skep sends no approval answer. Detection
occurs while the process is alive, and the final log drain detects requests emitted just before
exit. Permission detection takes precedence when a request is captured during another stop.

Abort calls the injected `InterruptLadder(handle, clock)` exactly once and maps its result to
`completed` (a natural exit won the race), `interrupted`, or `killed`. The timeout uses the same
ladder but retains the outcome `timeout`. Both timers and duration use injected monotonic time,
including time spent preparing files and spawning. Abort before spawning returns `interrupted`
with no PID. Abort during `spawn()` is remembered and handled as soon as a handle is available.
Timers, polling, and abort listeners are cleaned up after completion.

The production ladder, supplied by SK-306, sends **SIGINT to the entire detached process group**,
allows 120 seconds for a cooperative exit, then SIGTERM, then after 30 seconds SIGKILL
(ARCHITECTURE §9.2, §10.1; PRD §9.7). SIGINT can leave a partial or missing final-message file;
the adapter does not treat that as validated completion. Exact pinned-CLI cooperative behavior
and exit codes require the opt-in signal test. The inline test ladder uses shorter grace periods
and makes no claim to implement production PID-reuse protection.

## Local authentication: D19

On **each** device (`mac`, `vps`), the human installs the pinned CLI and configures/authenticates it
locally as the OS user that will run the agent. The human must ensure a non-interactive CLI run
works under that user and its local home/config directory before enabling the daemon. Use the
CLI's local login/configuration workflow directly; Skep does not automate login or provisioning.

The CLI resolves its own configuration from the agent user's home (its default `.codex` directory)
or the user-selected `CODEX_HOME`. The installed help explicitly describes this local config
location and notes that CLI authentication uses `CODEX_HOME`. A sanitized environment may contain
ordinary directory/runtime variables such as `HOME`, `PATH`, and `CODEX_HOME` so the executable
can find the agent user's own files. This conveys a local directory, not credentials or provider
configuration. The adapter passes the supplied environment unchanged and does not merge the
daemon's `process.env`.

Skep never reads those config/auth files or asks the CLI to print them; it does not read,
copy, store, log, encrypt, hash, label, broker, or synchronize provider configuration. It adds no
provider keys/tokens, provider selection, or base URLs to env or argv. If the local CLI setup
depends on a provider-secret environment variable supplied by the daemon, that setup is
incompatible with D19; the human must use CLI-local authentication. Version probing passes an
empty environment and does not check authentication. D12–D16 and D18 do not change this adapter's
raw-output contract; it has no task-routing, lease, or transport responsibility.

Captured agent output still needs the daemon's pattern redactor before persistence/publication,
plus publication-time secret scans (§16, SK-506/SK-504). The frozen `RuntimeBackend` writes the raw
combined log itself; this task does not add a redactor or read credentials to implement one.

## Verification and frozen-contract notes

```text
npx vitest run src/adapter
npm run lint
npm test
SKEP_REAL_CODEX=1 npx vitest run test/integration/adapter-codex.test.ts
```

The last command is opt-in and can contact the CLI's locally configured service. It uses an inline
test runtime, a temporary worktree/scratch/log, a strict `WorkReportSchema` response, a whitelist
of non-secret environment variables, and a real process-group SIGINT test. Ordinary tests never
run model CLIs or contact a network. Unit tests replay generic hand-made fixtures and drive
timeouts with `FakeClock`; they cover all SK-207 acceptance criteria plus version pinning,
stale-output removal, telemetry validation, record splitting, and cleanup.

Sandbox validation: 36 adapter unit tests pass; lint/typecheck and the TypeScript build pass.
The full suite reports 600 passed, 7 failed, and 2 opt-in tests skipped. All seven failures are
pre-existing `src/util/exec.test.ts` stdout-capture checks and reproduce when run alone. A
standalone `node:child_process.execFile("node", ...)` outside the repository also captures an
empty string for `process.stdout.write`, while `fs.writeSync(1, ...)` captures correctly. This
is a sandbox/Node subprocess-stream limitation, not an adapter regression; the utility's source
and tests are outside SK-207's ownership and remain unchanged. No tests were skipped or removed
to hide these failures. The full suite must be rerun in an environment with working Node pipes.

`src/adapter/types.ts` and `src/runtime/types.ts` are unchanged. Two frozen-contract limits are
recorded for the daemon/runtime owners:

* `AdapterInvocation` has no expected version. Gate invocations on successful `probe()` plus exact
  equality with `AGENT.md.cli_version` at daemon startup; do not infer the agent's pin from output.
* `RuntimeBackend` exposes no stdout event callback, stdin-read observation, or spawn cancellation.
  The adapter polls the combined log and closes stdin via the runtime contract. It cannot detect
  a CLI that silently reads stdin again, or interrupt a backend that never resolves `spawn()`.
  Such a CLI receives EOF, cannot obtain approval, and is stopped by the invocation timeout once
  a handle exists. Live read-observation would require a future runtime contract extension.
