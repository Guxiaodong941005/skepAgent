import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { AgentCliSchema } from "../core/schemas/common.js";
import { ExecError, type ExecOptions, type ExecResult, execFileChecked } from "../util/exec.js";
import type { AgentSessionBackend, AgentSessionHandle, AgentSessionStart } from "./types.js";

/**
 * ARCHITECTURE D28 / §11.4: native fallback is allowed only before a prompt is accepted.
 * After acceptance, callers fail the item with the error text; an unknown invocation is never
 * replayed. This also applies when the acknowledgement is lost or prompt startup stalls.
 */
export class AgentSessionError extends Error {
  constructor(
    message: string,
    readonly fallbackSafe: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentSessionError";
  }
}

export class HerdrUnavailableError extends AgentSessionError {
  constructor(
    message = "herdr is unavailable or its server is not running",
    options?: ErrorOptions,
  ) {
    super(message, true, options);
    this.name = "HerdrUnavailableError";
  }
}

export class HerdrSchemaError extends AgentSessionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, true, options);
    this.name = "HerdrSchemaError";
  }
}

export class HerdrCallError extends AgentSessionError {
  constructor(
    readonly code: string,
    message = code,
    promptAccepted = false,
    options?: ErrorOptions,
  ) {
    super(message, !promptAccepted, options);
    this.name = "HerdrCallError";
  }
}

export const SUPPORTED_HERDR_PROTOCOLS: readonly number[] = Object.freeze([22]);
const TextSchema = z.string().refine((text) => !text.includes("\0"), "text contains NUL");
const IdSchema = TextSchema.min(1).refine((id) => !id.startsWith("-"), "id starts with '-' ");
const NameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const EnvSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), TextSchema);
const StartSchema = z.strictObject({
  name: NameSchema,
  kind: AgentCliSchema,
  cwd: TextSchema.min(1),
  env: EnvSchema,
  args: z.array(TextSchema).optional(),
});
const StatusSchema = z.enum(["working", "idle", "done", "blocked", "unknown"]);
const CounterSchema = z.number().int().nonnegative();
const SessionSchema = z.strictObject({
  source: z.string(),
  agent: z.string(),
  kind: z.enum(["id", "path"]),
  value: z.string(),
});
const TokensSchema = z
  .record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string())
  .refine((tokens) => Object.keys(tokens).length <= 32);
const SharedInfo = {
  terminal_id: IdSchema,
  agent_status: StatusSchema,
  workspace_id: IdSchema,
  tab_id: IdSchema,
  pane_id: IdSchema,
  focused: z.boolean(),
  revision: CounterSchema,
  agent: z.string().nullable().optional(),
  agent_session: SessionSchema.nullable().optional(),
  cwd: z.string().nullable().optional(),
  foreground_cwd: z.string().nullable().optional(),
  display_agent: z.string().nullable().optional(),
  terminal_title: z.string().nullable().optional(),
  terminal_title_stripped: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  tokens: TokensSchema.optional(),
  state_labels: z.record(z.string(), z.string()).optional(),
};
const AgentSchema = z.strictObject({
  ...SharedInfo,
  name: z.string().nullable().optional(),
  completion_seq: CounterSchema.nullable().optional(),
  state_change_seq: CounterSchema.optional(),
  interactive_ready: z.boolean().optional(),
  launch_pending: z.boolean().optional(),
  screen_detection_skipped: z.boolean().optional(),
});
const PaneSchema = z.strictObject({
  ...SharedInfo,
  label: z.string().nullable().optional(),
  restore_error: z.string().nullable().optional(),
  scroll: z
    .strictObject({
      offset_from_bottom: CounterSchema,
      max_offset_from_bottom: CounterSchema,
      viewport_rows: CounterSchema,
    })
    .nullable()
    .optional(),
});
const TabSchema = z.strictObject({
  tab_id: IdSchema,
  workspace_id: IdSchema,
  number: CounterSchema,
  label: z.string(),
  focused: z.boolean(),
  pane_count: CounterSchema,
  agent_status: StatusSchema,
});
const CreatedSchema = z.strictObject({
  type: z.literal("tab_created"),
  tab: TabSchema,
  root_pane: PaneSchema,
});
const StartedSchema = z.strictObject({
  type: z.literal("agent_started"),
  agent: AgentSchema,
  argv: z.array(z.string()),
});
const PromptedSchema = z.strictObject({ type: z.literal("agent_prompted"), agent: AgentSchema });
const WaitedSchema = z.strictObject({ type: z.literal("agent_info"), agent: AgentSchema });
const OkSchema = z.strictObject({ type: z.literal("ok") });
const ErrorSchema = z.strictObject({
  id: z.string(),
  error: z.strictObject({ code: z.string().min(1), message: z.string() }),
});
const EnvelopeSchema = z.strictObject({ id: z.string(), result: z.unknown() });
const CompatibilitySchema = z.strictObject({
  protocol: CounterSchema,
  schema_version: CounterSchema,
  $schema: z.string().optional(),
  schemas: z.record(z.string(), z.unknown()).optional(),
  title: z.string().optional(),
});

interface Session {
  paneId: string;
  cwd: string;
  accepted: boolean;
  promptDirs: string[];
}

function spawnCode(error: unknown): string | undefined {
  if (error instanceof ExecError) return spawnCode(error.cause);
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function cliEnvironment(): Record<string, string> {
  // D19: herdr needs its local socket location, not the daemon's provider environment.
  const env: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "TMPDIR",
    "HERDR_SOCKET",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function unavailable(code: string, message: string): boolean {
  return (
    ["not_running", "server_not_running", "connection_refused", "unavailable"].includes(code) ||
    /(?:server.*not running|connection refused|no such file.*socket|socket.*no such file|kind:\s*NotFound)/i.test(
      message,
    )
  );
}

export function createHerdrBackend(
  deps: { exec?: typeof execFileChecked; bin?: string } = {},
): AgentSessionBackend {
  const exec = deps.exec ?? execFileChecked;
  const bin = deps.bin ?? "herdr";
  const sessions = new Map<string, Session>();
  let compatible = false;

  function callError(
    code: string,
    message: string,
    session?: Session,
    cause?: unknown,
  ): AgentSessionError {
    if (!session?.accepted && unavailable(code, message)) {
      return new HerdrUnavailableError(message, { cause });
    }
    return new HerdrCallError(code, message, session?.accepted ?? false, { cause });
  }

  function sessionFor(h: AgentSessionHandle): Session {
    const parsed = z
      .strictObject({
        name: NameSchema,
        paneId: IdSchema,
        focusCommand: z.tuple([TextSchema.min(1)]).rest(TextSchema),
      })
      .safeParse(h);
    const session = sessions.get(h.name);
    if (!parsed.success || !session || session.paneId !== h.paneId) {
      throw new HerdrCallError(
        "invalid_session",
        "Use a session handle returned by start()",
        session?.accepted ?? false,
      );
    }
    return session;
  }

  async function invoke(
    args: string[],
    session?: Session,
    opts: ExecOptions = {},
    prompt = false,
  ): Promise<ExecResult> {
    let result: ExecResult;
    try {
      result = await exec(bin, args, { env: cliEnvironment(), allowFailure: true, ...opts });
    } catch (cause) {
      if (spawnCode(cause) === "ENOENT") {
        throw session?.accepted
          ? callError("unavailable", `Cannot execute ${bin}`, session, cause)
          : new HerdrUnavailableError(`Cannot execute ${bin}; install herdr or use native`, {
              cause,
            });
      }
      // A lost acknowledgement is an unknown invocation (§11.4), never safe to replay.
      if (prompt && session && !["EACCES", "EPERM", "ENOEXEC"].includes(spawnCode(cause) ?? "")) {
        session.accepted = true;
      }
      throw callError(
        spawnCode(cause) === "ABORT_ERR" ? "aborted" : "exec_failed",
        cause instanceof Error ? cause.message : String(cause),
        session,
        cause,
      );
    }
    // agent read's successful stdout is arbitrary agent text, including JSON-looking text.
    const outputs =
      args[0] === "agent" && args[1] === "read" && result.code === 0
        ? [result.stderr]
        : [result.stdout, result.stderr];
    for (const output of outputs) {
      if (!output.trim().startsWith("{")) continue;
      let value: unknown;
      try {
        value = JSON.parse(output);
      } catch {
        // Non-JSON diagnostic text is reported below; JSON calls validate their stdout in json().
        continue;
      }
      const error = ErrorSchema.safeParse(value);
      if (error.success) {
        const { code, message } = error.data.error;
        if (
          prompt &&
          session &&
          !unavailable(code, message) &&
          ![
            "agent_not_found",
            "not_found",
            "invalid_request",
            "invalid_params",
            "agent_not_ready",
          ].includes(code)
        ) {
          session.accepted = true;
        }
        throw callError(code, message, session);
      }
    }
    if (prompt && session) session.accepted = true;
    if (result.timedOut || result.code !== 0 || result.signal !== null) {
      const message =
        result.stderr.trim() ||
        result.stdout.trim() ||
        `herdr exited ${result.code ?? result.signal}`;
      throw callError(result.timedOut ? "timeout" : "call_failed", message, session);
    }
    return result;
  }

  async function json<T>(
    args: string[],
    schema: z.ZodType<T>,
    session?: Session,
    opts: ExecOptions = {},
    prompt = false,
  ): Promise<T> {
    const result = await invoke(args, session, opts, prompt);
    try {
      const envelope = EnvelopeSchema.parse(JSON.parse(result.stdout));
      return schema.parse(envelope.result);
    } catch (cause) {
      throw callError(
        "invalid_response",
        "herdr returned an invalid JSON response",
        session,
        cause,
      );
    }
  }

  const backend: AgentSessionBackend = {
    name: "herdr",
    async probe() {
      compatible = false;
      const result = await invoke(["api", "schema", "--json"]);
      let schema: z.infer<typeof CompatibilitySchema>;
      try {
        schema = CompatibilitySchema.parse(JSON.parse(result.stdout));
      } catch (cause) {
        throw new HerdrSchemaError("herdr api schema returned invalid compatibility metadata", {
          cause,
        });
      }
      if (!SUPPORTED_HERDR_PROTOCOLS.includes(schema.protocol) || schema.schema_version !== 1) {
        throw new HerdrSchemaError(
          `Unsupported herdr protocol ${schema.protocol}/schema ${schema.schema_version}; expected protocol 22/schema 1`,
        );
      }
      compatible = true;
      return { protocol: schema.protocol, schemaVersion: schema.schema_version };
    },
    async start(opts: AgentSessionStart) {
      const parsed = StartSchema.safeParse(opts);
      if (!parsed.success)
        throw new HerdrCallError("invalid_input", "Invalid herdr session start options", false, {
          cause: parsed.error,
        });
      if (sessions.has(opts.name))
        throw new HerdrCallError(
          "duplicate_session",
          `Session ${opts.name} already exists`,
          sessions.get(opts.name)?.accepted,
        );
      if (!compatible) await backend.probe();
      const args = ["tab", "create", "--cwd", opts.cwd, "--label", opts.name, "--no-focus"];
      for (const [key, value] of Object.entries(opts.env)) args.push("--env", `${key}=${value}`);
      const created = await json(args, CreatedSchema);
      const paneId = created.root_pane.pane_id;
      const session: Session = { paneId, cwd: opts.cwd, accepted: false, promptDirs: [] };
      try {
        const startArgs = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", paneId];
        if (opts.args?.length) startArgs.push("--", ...opts.args);
        const started = await json(startArgs, StartedSchema, session);
        if (started.agent.pane_id !== paneId || started.agent.name !== opts.name) {
          throw new HerdrCallError("invalid_response", "herdr started a different session or pane");
        }
      } catch (error) {
        try {
          await json(["pane", "close", paneId], OkSchema, session);
        } catch (cleanup) {
          throw new HerdrCallError(
            "start_failed",
            "herdr agent startup failed; its pane could not be closed",
            false,
            { cause: new AggregateError([error, cleanup]) },
          );
        }
        throw error;
      }
      sessions.set(opts.name, session);
      return { name: opts.name, paneId, focusCommand: [bin, "agent", "focus", opts.name] };
    },
    async prompt(h, text) {
      const session = sessionFor(h);
      if (!TextSchema.safeParse(text).success)
        throw callError("invalid_input", "Prompt contains NUL", session);
      let payload = text;
      if (Buffer.byteLength(text, "utf8") > 16 * 1024) {
        try {
          const dir = await mkdtemp(join(session.cwd, ".skep-prompt-"));
          session.promptDirs.push(dir);
          const file = join(dir, "prompt.txt");
          await writeFile(file, text, { mode: 0o600, flag: "wx" });
          payload = `Read and carry out the task in ${relative(session.cwd, file)}.`;
        } catch (cause) {
          throw callError(
            "prompt_file",
            "Cannot write the prompt file in the worktree",
            session,
            cause,
          );
        }
      }
      const prompted = await json(
        ["agent", "prompt", h.name, payload],
        PromptedSchema,
        session,
        {},
        true,
      );
      if (prompted.agent.pane_id !== h.paneId || prompted.agent.name !== h.name) {
        throw callError(
          "invalid_response",
          "herdr acknowledged a different agent's prompt",
          session,
        );
      }
    },
    async wait(h, opts) {
      const session = sessionFor(h);
      if (!z.number().int().positive().safeParse(opts.timeoutMs).success) {
        throw callError("invalid_input", "timeoutMs must be a positive integer", session);
      }
      try {
        const waited = await json(
          [
            "agent",
            "wait",
            h.name,
            "--until",
            "idle",
            "--until",
            "done",
            "--until",
            "blocked",
            "--timeout",
            String(opts.timeoutMs),
          ],
          WaitedSchema,
          session,
          {
            signal: opts.signal,
            timeoutMs: opts.timeoutMs + 1_000,
          },
        );
        const state = waited.agent.agent_status;
        if (waited.agent.pane_id !== h.paneId || waited.agent.name !== h.name) {
          throw callError("invalid_response", "herdr wait returned a different agent", session);
        }
        if (state !== "idle" && state !== "done" && state !== "blocked")
          throw callError("invalid_response", `herdr wait returned ${state}`, session);
        return state;
      } catch (error) {
        if (error instanceof HerdrCallError && error.code === "agent_blocked") return "blocked";
        throw error;
      }
    },
    async read(h, opts = {}) {
      const session = sessionFor(h);
      const lines = opts.lines ?? 200;
      if (!z.number().int().positive().safeParse(lines).success)
        throw callError("invalid_input", "lines must be a positive integer", session);
      return (
        await invoke(
          [
            "agent",
            "read",
            h.name,
            "--source",
            "recent",
            "--lines",
            String(lines),
            "--format",
            "text",
          ],
          session,
        )
      ).stdout;
    },
    async focus(h) {
      await json(["agent", "focus", h.name], OkSchema, sessionFor(h));
    },
    async close(h) {
      const session = sessionFor(h);
      await json(["pane", "close", h.paneId], OkSchema, session);
      for (const dir of session.promptDirs) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch (cause) {
          throw callError("prompt_cleanup", "Cannot remove a local prompt file", session, cause);
        }
      }
      session.promptDirs = [];
    },
  };
  return backend;
}
