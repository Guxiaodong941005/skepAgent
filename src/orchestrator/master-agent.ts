/**
 * The master agent: the master device's own agent CLI, run one process per turn with its
 * conversation resumed by id (docs/plans/tui-scroll-and-herdr-controller.md §3.4; argv pinned by
 * docs/spikes/master-agent-cli.md). Turns are read-only by CLI flags; the orchestrator also
 * checks the working tree after each turn.
 *
 * One conversation per shell session, capped at {@link MASTER_CONTEXT_MAX_CHARS} characters of
 * Skep-supplied context (locked decision §9.3: "same session keeps context, max 500K"); past that
 * the orchestrator resets it and re-seeds from the ledger.
 */

import { z } from "zod";
import type { AgentCli } from "../cli/commands/session.js";
import type { ExecOptions, ExecResult } from "../util/exec.js";
import { type RandomSource, uuidV4 } from "../util/random.js";

export const MASTER_CONTEXT_MAX_CHARS = 500_000;
/** A refine or synthesis turn; generous because a CLI may read files before answering. */
export const MASTER_TURN_TIMEOUT_MS = 10 * 60_000;

export interface MasterTurn {
  text: string;
  conversationId: string;
}

export interface MasterAgent {
  readonly cli: AgentCli;
  /** Null before the first successful turn and after {@link reset}. */
  readonly conversationId: string | null;
  /** Characters sent and received in the current conversation. */
  readonly contextChars: number;
  /** One turn in this shell's conversation; resumes it when one exists. */
  turn(input: { prompt: string; signal?: AbortSignal; timeoutMs?: number }): Promise<MasterTurn>;
  /** Starts a fresh conversation at the next turn. */
  reset(): void;
}

export type RunCli = (file: string, args: string[], opts: ExecOptions) => Promise<ExecResult>;

/**
 * `failed`: the CLI ran and exited non-zero (how a stale resume id shows up); `timeout`: it was
 * stopped; `output`: it answered in a shape Skep cannot read; `spawn`: it could not start.
 */
export type MasterAgentFailure = "failed" | "timeout" | "output" | "spawn";

export class MasterAgentError extends Error {
  constructor(
    message: string,
    readonly kind: MasterAgentFailure = "failed",
  ) {
    super(message);
    this.name = "MasterAgentError";
  }
}

/** Read-only tool sets (spike §2): no write, edit or shell tool exists in the session. */
const CLAUDE_TOOLS = "Read,Grep,Glob";
const PI_TOOLS = "read,grep,find,ls";

/**
 * The argv of one turn. `id` is the conversation id: chosen by Skep for claude and pi (null only
 * for codex's first turn, whose id codex announces); `resume` is false for the first turn.
 */
export function masterArgv(cli: AgentCli, id: string | null, resume: boolean): string[] {
  switch (cli) {
    case "claude": {
      if (id === null) throw new MasterAgentError("claude needs a conversation id");
      return [
        "-p",
        "--output-format",
        "json",
        // Reusing --session-id fails "already in use"; later turns resume (spike §2).
        ...(resume ? ["--resume", id] : ["--session-id", id]),
        "--permission-mode",
        "plan",
        "--tools",
        CLAUDE_TOOLS,
      ];
    }
    case "codex":
      if (!resume || id === null) {
        return ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-"];
      }
      // `exec resume` has no --sandbox flag in 0.160.0; the config override is the same mode.
      return [
        "exec",
        "resume",
        "--json",
        "-c",
        'sandbox_mode="read-only"',
        "--skip-git-repo-check",
        id,
        "-",
      ];
    case "pi":
      if (id === null) throw new MasterAgentError("pi needs a conversation id");
      // --session-id creates the session when missing, so every turn uses the same argv.
      return ["-p", "--mode", "json", "--session-id", id, "--tools", PI_TOOLS];
  }
}

/** Vendor output, not a protocol object: unknown keys are ignored, the needed ones required. */
const ClaudeOutputSchema = z.object({
  type: z.literal("result"),
  is_error: z.boolean(),
  result: z.string().optional(),
  session_id: z.string().min(1),
  subtype: z.string().optional(),
});

const JsonLineSchema = z.object({ type: z.string() }).passthrough();

/** The reply text and the conversation id in one turn's stdout. */
export function parseMasterOutput(
  cli: AgentCli,
  stdout: string,
): { text: string; conversationId: string | null } {
  if (cli === "claude") {
    let value: unknown;
    try {
      value = JSON.parse(stdout.trim());
    } catch {
      throw new MasterAgentError(
        `claude did not print a JSON result: ${preview(stdout)}`,
        "output",
      );
    }
    const parsed = ClaudeOutputSchema.safeParse(value);
    if (!parsed.success) {
      throw new MasterAgentError(
        `claude printed an unexpected result: ${preview(stdout)}`,
        "output",
      );
    }
    if (parsed.data.is_error) {
      throw new MasterAgentError(
        `claude reported an error (${parsed.data.subtype ?? "error"}): ${preview(parsed.data.result ?? "")}`,
      );
    }
    return { text: parsed.data.result ?? "", conversationId: parsed.data.session_id };
  }
  const events = jsonLines(stdout);
  if (cli === "codex") {
    let id: string | null = null;
    let text: string | null = null;
    for (const event of events) {
      if (event.type === "thread.started" && typeof event.thread_id === "string") {
        id = event.thread_id;
      } else if (event.type === "item.completed") {
        const item = event.item as { type?: unknown; text?: unknown } | undefined;
        if (item?.type === "agent_message" && typeof item.text === "string") text = item.text;
      } else if (event.type === "error" || event.type === "turn.failed") {
        throw new MasterAgentError(`codex failed: ${preview(JSON.stringify(event))}`);
      }
    }
    if (text === null) throw new MasterAgentError("codex printed no agent message", "output");
    return { text, conversationId: id };
  }
  let id: string | null = null;
  let text: string | null = null;
  for (const event of events) {
    if (event.type === "session" && typeof event.id === "string") id = event.id;
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      text = lastAssistantText(event.messages);
    }
  }
  if (text === null) throw new MasterAgentError("pi printed no assistant reply", "output");
  return { text, conversationId: id };
}

function lastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown; errorMessage?: unknown };
    if (message?.role !== "assistant") continue;
    if (typeof message.errorMessage === "string" && message.errorMessage !== "") {
      throw new MasterAgentError(`pi failed: ${preview(message.errorMessage)}`);
    }
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return null;
    return message.content
      .filter((part): part is { type: "text"; text: string } => {
        const p = part as { type?: unknown; text?: unknown };
        return p?.type === "text" && typeof p.text === "string";
      })
      .map((part) => part.text)
      .join("");
  }
  return null;
}

function jsonLines(stdout: string): z.infer<typeof JsonLineSchema>[] {
  const out: z.infer<typeof JsonLineSchema>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      // A non-JSON line (a warning on stdout) is not an event; the reply check below decides.
      continue;
    }
    const parsed = JsonLineSchema.safeParse(value);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat || "(empty)";
}

export interface CliMasterAgentOptions {
  cli: AgentCli;
  /** The master's project root; the agent reads it, never writes it. */
  cwd: string;
  /** Sanitized env (D19): the CLI's own login, no forwarded secrets. */
  env: Record<string, string>;
  run: RunCli;
  random: RandomSource;
}

export class CliMasterAgent implements MasterAgent {
  readonly cli: AgentCli;
  private id: string | null = null;
  private started = false;
  private chars = 0;

  constructor(private readonly options: CliMasterAgentOptions) {
    this.cli = options.cli;
  }

  get conversationId(): string | null {
    return this.started ? this.id : null;
  }

  get contextChars(): number {
    return this.chars;
  }

  reset(): void {
    this.id = null;
    this.started = false;
    this.chars = 0;
  }

  async turn(input: {
    prompt: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<MasterTurn> {
    const { cli, cwd, env, run, random } = this.options;
    if (!this.started && cli !== "codex") this.id = uuidV4(random);
    const argv = masterArgv(cli, this.id, this.started);
    const timeoutMs = input.timeoutMs ?? MASTER_TURN_TIMEOUT_MS;
    let result: ExecResult;
    try {
      result = await run(cli, argv, {
        cwd,
        env,
        input: input.prompt,
        timeoutMs,
        allowFailure: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      if (!this.started) this.id = null;
      const message = error instanceof Error ? error.message : String(error);
      throw new MasterAgentError(`master agent ${cli} could not run: ${message}`, "spawn");
    }
    if (result.timedOut || result.code !== 0) {
      // A first turn that failed may still have recorded its id: never reuse it (spike §2).
      if (!this.started) this.id = null;
      const why = result.timedOut
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : `exited ${result.code ?? result.signal ?? "?"}`;
      throw new MasterAgentError(
        `master agent ${cli} ${why}: ${preview(result.stderr || result.stdout)}`,
        result.timedOut ? "timeout" : "failed",
      );
    }
    const parsed = parseMasterOutput(cli, result.stdout);
    const id = parsed.conversationId ?? this.id;
    if (id === null) {
      throw new MasterAgentError(`master agent ${cli} named no conversation id`, "output");
    }
    this.id = id;
    this.started = true;
    this.chars += input.prompt.length + parsed.text.length;
    return { text: parsed.text, conversationId: id };
  }
}
