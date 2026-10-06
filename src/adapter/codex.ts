import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { type Usage, UsageSchema } from "../core/schemas/work-report.js";
import type { ProcessExit, ProcessHandle, RuntimeBackend } from "../runtime/types.js";
import type { Clock } from "../util/clock.js";
import type {
  AdapterInvocation,
  AdapterProbe,
  AdapterResult,
  AgentAdapter,
  InvocationOutcome,
} from "./types.js";

export const PINNED_CODEX_VERSION = "codex-cli 0.160.0";

export type InterruptLadder = (
  h: ProcessHandle,
  clock: Clock,
) => Promise<"completed" | "interrupted" | "killed">;

export class CodexAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexAdapterError";
  }
}

function schemaRecord(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) {
    throw new CodexAdapterError(
      "Codex output schema must contain object schemas; use outputSchema: off for unsupported schemas",
    );
  }
  return parsed.data;
}

/** B1: the provider schema is a lossy generation constraint; original Zod remains authoritative. */
export function toCodexOutputSchema(jsonSchema: Record<string, unknown>): Record<string, unknown> {
  const convert = (input: unknown): Record<string, unknown> => {
    const source = schemaRecord(input);
    const result: Record<string, unknown> = {};
    // A conservative structural subset avoids model-dependent support for validation keywords.
    for (const key of ["type", "description", "enum"]) {
      if (source[key] !== undefined) result[key] = structuredClone(source[key]);
    }
    if (Object.hasOwn(source, "const")) result.enum = [structuredClone(source.const)];
    if (typeof source.$ref === "string") {
      result.$ref = source.$ref.replace(/^#\/definitions\//, "#/$defs/");
    }
    const definitions = source.$defs ?? source.definitions;
    if (definitions !== undefined) {
      result.$defs = Object.fromEntries(
        Object.entries(schemaRecord(definitions)).map(([name, schema]) => [name, convert(schema)]),
      );
    }
    const alternatives = source.anyOf ?? source.oneOf;
    if (Array.isArray(alternatives)) result.anyOf = alternatives.map(convert);
    const types = Array.isArray(source.type) ? source.type : [source.type];
    if (types.includes("object") || source.properties !== undefined) {
      const properties = schemaRecord(source.properties ?? {});
      const required = new Set(Array.isArray(source.required) ? source.required : []);
      result.type = source.type ?? "object";
      result.properties = Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => {
          const converted = convert(schema);
          return [name, required.has(name) ? converted : { anyOf: [converted, { type: "null" }] }];
        }),
      );
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    }
    const tuple = source.prefixItems ?? (Array.isArray(source.items) ? source.items : undefined);
    if (Array.isArray(tuple)) {
      const elements = tuple.map(convert);
      const rest = Array.isArray(source.items) ? source.additionalItems : source.items;
      if (rest !== undefined && typeof rest === "object" && !Array.isArray(rest)) {
        elements.push(convert(rest));
      }
      const distinct = [
        ...new Map(elements.map((element) => [JSON.stringify(element), element])).values(),
      ];
      result.items =
        distinct.length === 1
          ? distinct[0]
          : distinct.length > 1
            ? { anyOf: distinct }
            : { type: "string" };
    } else if (source.items !== undefined && typeof source.items === "object") {
      result.items = convert(source.items);
    } else if (types.includes("array")) {
      result.items = { type: "string" };
    }
    return result;
  };
  return convert(jsonSchema);
}

const POLL_MS = 50;
const MAX_LINE_BYTES = 1024 * 1024;

// CLI telemetry is not a Skep protocol object: retain forward-compatible extra fields, then
// project the supported counters through the strict shared UsageSchema (ARCHITECTURE §9.2).
const EventSchema = z.looseObject({ type: z.string() });
const TokenUsageSchema = z.looseObject({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});
const ApprovalTypes = new Set([
  "approval_request",
  "approval_requested",
  "exec_approval_request",
  "apply_patch_approval_request",
  "command_execution_approval_requested",
  "file_change_approval_requested",
  "request_user_input",
]);

/** Incremental combined-log reader; incomplete UTF-8 and JSONL records wait for the next poll. */
class CodexEvents {
  usage: Usage | null = null;
  permissionPrompt = false;
  private offset = 0;
  private pending = "";
  private readonly decoder = new StringDecoder("utf8");

  constructor(private readonly logPath: string) {}

  async read(final = false): Promise<void> {
    const file = await open(this.logPath, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (file) {
      try {
        const size = (await file.stat()).size;
        if (size < this.offset) {
          throw new CodexAdapterError("Codex capture log was truncated during an invocation");
        }
        const buffer = Buffer.alloc(64 * 1024);
        while (this.offset < size) {
          const { bytesRead } = await file.read(
            buffer,
            0,
            Math.min(buffer.length, size - this.offset),
            this.offset,
          );
          if (bytesRead === 0) break;
          this.offset += bytesRead;
          this.consume(this.decoder.write(buffer.subarray(0, bytesRead)));
        }
      } finally {
        await file.close();
      }
    }
    if (final) {
      this.consume(this.decoder.end());
      if (this.pending.trim() !== "") this.parseLine(this.pending);
      this.pending = "";
    }
  }

  private consume(chunk: string): void {
    this.pending += chunk;
    let newline = this.pending.indexOf("\n");
    while (newline !== -1) {
      this.parseLine(this.pending.slice(0, newline));
      this.pending = this.pending.slice(newline + 1);
      newline = this.pending.indexOf("\n");
    }
    this.checkSize(this.pending);
  }

  private checkSize(line: string): void {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      throw new CodexAdapterError("Codex log record exceeds the 1 MiB capture limit");
    }
  }

  private parseLine(line: string): void {
    this.checkSize(line);
    // RuntimeBackend combines stderr with stdout, so warnings and torn records are diagnostics,
    // not trustworthy telemetry. They remain in the caller-owned capture log (§9.2).
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.checkSchemaError(line);
        return;
      }
      throw error;
    }
    const parsed = EventSchema.safeParse(value);
    if (!parsed.success) {
      const response = z
        .looseObject({
          error: z.looseObject({ code: z.string().optional(), message: z.string().optional() }),
        })
        .safeParse(value);
      if (response.success) this.checkSchemaError(JSON.stringify(response.data.error));
      return;
    }
    const event = parsed.data;
    const nested = EventSchema.safeParse(event.msg);
    const item = EventSchema.safeParse(event.item);
    if (
      [event, nested.success ? nested.data : null].some(
        (candidate) =>
          candidate !== null && ["error", "turn.failed", "thread.failed"].includes(candidate.type),
      )
    )
      this.checkSchemaError(line);
    if (
      [event, nested.success ? nested.data : null, item.success ? item.data : null].some(
        (candidate) => candidate !== null && ApprovalTypes.has(candidate.type),
      )
    ) {
      this.permissionPrompt = true;
    }
    const telemetry = nested.success ? nested.data : event;
    let rawUsage: unknown;
    if (telemetry.type === "turn.completed" || telemetry.type === "thread.completed") {
      rawUsage = telemetry.usage;
    } else if (telemetry.type === "token_count") {
      const info = z.looseObject({ total_token_usage: z.unknown() }).safeParse(telemetry.info);
      if (info.success) rawUsage = info.data.total_token_usage;
    }
    const usage = TokenUsageSchema.safeParse(rawUsage);
    if (usage.success) {
      this.usage = UsageSchema.parse({
        input_tokens: usage.data.input_tokens,
        output_tokens: usage.data.output_tokens,
      });
    }
  }

  private checkSchemaError(text: string): void {
    if (
      /\binvalid_json_schema\b/.test(text) ||
      /Invalid schema for response_format ["']codex_output_schema["']/.test(text)
    ) {
      throw new CodexAdapterError(
        'Codex rejected --output-schema (invalid_json_schema); update the provider transform or explicitly select outputSchema: "off". This configuration error must not trigger a model repair.',
      );
    }
  }
}

type StopReason = "abort" | "timeout" | "permission_prompt";
type WatchResult =
  | { kind: "exit"; exit: ProcessExit }
  | { kind: StopReason }
  | { kind: "cancelled" };

export class CodexAdapter implements AgentAdapter {
  readonly cli = "codex";
  private readonly runtime: RuntimeBackend;
  private readonly interrupt: InterruptLadder;
  private readonly clock: Clock;
  private readonly codexPath: string;
  private readonly outputSchemaMode: "strict" | "off";
  private readonly probeEnv: Record<string, string>;

  constructor(opts: {
    runtime: RuntimeBackend;
    interrupt: InterruptLadder;
    clock: Clock;
    codexPath?: string;
    outputSchema?: "strict" | "off";
    probeEnv?: { PATH: string };
  }) {
    this.runtime = opts.runtime;
    this.interrupt = opts.interrupt;
    this.clock = opts.clock;
    this.codexPath = opts.codexPath ?? "codex";
    this.outputSchemaMode = opts.outputSchema ?? "strict";
    this.probeEnv = opts.probeEnv === undefined ? {} : { PATH: opts.probeEnv.PATH };
  }

  async probe(): Promise<AdapterProbe> {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-codex-probe-"));
    try {
      const started = this.clock.monotonicMs();
      const logPath = path.join(dir, "version.log");
      const handle = await this.runtime.spawn({
        argv: [this.codexPath, "--version"],
        cwd: dir,
        env: this.probeEnv,
        logPath,
        stdin: "",
      });
      const { outcome, exit } = await this.supervise(
        handle,
        new CodexEvents(logPath),
        new AbortController().signal,
        started + 5_000,
      );
      if (outcome !== "completed" || exit.code !== 0) {
        return { ok: false, version: null, detail: "Codex --version failed or timed out" };
      }
      const text = await readFile(logPath, "utf8");
      const version = text.split(/\r?\n/).find((line) => /^codex-cli \S+$/.test(line)) ?? null;
      return {
        ok: version !== null,
        version,
        detail:
          version !== null
            ? "Codex CLI is available; compare the exact version with AGENT.md before invoking"
            : "Codex --version did not report a recognizable version string",
      };
    } catch (error) {
      return {
        ok: false,
        version: null,
        detail: `Could not probe Codex CLI: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    const started = this.clock.monotonicMs();
    if (!Number.isFinite(inv.timeoutMs) || inv.timeoutMs <= 0) {
      throw new CodexAdapterError("Codex timeoutMs must be a positive finite duration");
    }
    if (inv.signal.aborted) {
      return {
        outcome: "interrupted",
        exitCode: null,
        finalMessage: null,
        usage: null,
        durationMs: 0,
        pid: null,
      };
    }
    const scratch = path.resolve(inv.scratchDir);
    const schemaPath = path.join(scratch, "schema.json");
    const lastPath = path.join(scratch, "last.json");
    const logPath = path.resolve(inv.logPath);
    try {
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
      if (this.outputSchemaMode === "strict") {
        await writeFile(schemaPath, `${JSON.stringify(toCodexOutputSchema(inv.outputSchema))}\n`, {
          mode: 0o600,
        });
      }
      // A reused scratch directory must never turn a failed attempt into an old final message.
      await rm(lastPath, { force: true });
      await writeFile(logPath, "", { mode: 0o600 });
      if (inv.signal.aborted) {
        return {
          outcome: "interrupted",
          exitCode: null,
          finalMessage: null,
          usage: null,
          durationMs: this.clock.monotonicMs() - started,
          pid: null,
        };
      }
      const handle = await this.runtime.spawn({
        argv: [
          this.codexPath,
          "-c",
          'approval_policy="never"',
          "exec",
          "--json",
          ...(this.outputSchemaMode === "strict" ? ["--output-schema", schemaPath] : []),
          "--output-last-message",
          lastPath,
          "--sandbox",
          "workspace-write",
          "--skip-git-repo-check",
          "-C",
          path.resolve(inv.cwd),
          "-",
        ],
        cwd: path.resolve(inv.cwd),
        // D19: the caller supplies the complete sanitized environment; never merge process.env
        // or inspect agent-local provider configuration. RuntimeBackend closes stdin after this.
        env: inv.env,
        logPath,
        stdin:
          this.outputSchemaMode === "strict"
            ? inv.prompt
            : `${inv.prompt}\n\nReturn only JSON matching this original JSON Schema:\n${JSON.stringify(inv.outputSchema)}\n`,
      });
      const events = new CodexEvents(logPath);
      const { outcome, exit } = await this.supervise(
        handle,
        events,
        inv.signal,
        started + inv.timeoutMs,
      );
      const finalMessage = await readFile(lastPath, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      return {
        outcome,
        exitCode: exit.code,
        // ARCHITECTURE §9.1–§9.3: invalid model JSON is returned verbatim for the structured
        // runner's single repair; neither parsing nor protocol decisions belong in this adapter.
        finalMessage,
        usage: events.usage,
        durationMs: Math.max(0, this.clock.monotonicMs() - started),
        pid: handle.pid,
      };
    } catch (error) {
      if (error instanceof CodexAdapterError) throw error;
      throw new CodexAdapterError("Codex invocation failed; check the runtime and capture paths", {
        cause: error,
      });
    }
  }

  private async supervise(
    handle: ProcessHandle,
    events: CodexEvents,
    signal: AbortSignal,
    deadline: number,
  ): Promise<{ outcome: InvocationOutcome; exit: ProcessExit }> {
    const cancelled = new AbortController();
    let exited = false;
    const exit = handle.wait().then((value): WatchResult => {
      exited = true;
      return { kind: "exit", exit: value };
    });
    let onAbort = () => {};
    const abort = new Promise<WatchResult>((resolve) => {
      onAbort = () => resolve({ kind: "abort" });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const ignoreCancellation = (error: unknown): WatchResult => {
      if (cancelled.signal.aborted && error instanceof Error && error.name === "AbortError") {
        return { kind: "cancelled" };
      }
      throw error;
    };
    const timeout = this.clock
      .sleep(Math.max(0, deadline - this.clock.monotonicMs()), cancelled.signal)
      .then((): WatchResult => ({ kind: "timeout" }))
      .catch(ignoreCancellation);
    const monitor = (async (): Promise<WatchResult> => {
      for (;;) {
        await events.read();
        if (events.permissionPrompt) return { kind: "permission_prompt" };
        await this.clock.sleep(POLL_MS, cancelled.signal);
      }
    })().catch(ignoreCancellation);
    let stopping: ReturnType<InterruptLadder> | null = null;
    const stop = () => (stopping ??= this.interrupt(handle, this.clock));
    let outcome: InvocationOutcome;
    let processExit: ProcessExit;
    try {
      const winner = await Promise.race([exit, abort, timeout, monitor]);
      // Cancel polling before the final drain, so two reads cannot share the same cursor.
      cancelled.abort();
      await Promise.all([monitor, timeout]);
      if (winner.kind === "exit") {
        outcome = "completed";
        processExit = winner.exit;
      } else {
        if (winner.kind === "cancelled") {
          throw new CodexAdapterError("Codex supervision was cancelled unexpectedly");
        }
        const stopped = await stop();
        outcome = winner.kind === "abort" ? stopped : winner.kind;
        const waited = await exit;
        if (waited.kind !== "exit") throw new CodexAdapterError("Codex exit was not recorded");
        processExit = waited.exit;
      }
      await events.read(true);
      if (events.permissionPrompt) outcome = "permission_prompt";
      return { outcome, exit: processExit };
    } catch (error) {
      // A capture/read error must not leave the model process running without supervision.
      if (!exited) await stop();
      throw error;
    } finally {
      cancelled.abort();
      signal.removeEventListener("abort", onAbort);
      await Promise.allSettled([monitor, timeout]);
    }
  }
}
