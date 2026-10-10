/**
 * `skep tui` opens the raw TUI of the agent installed on this device. It is the advanced escape
 * hatch: plain `skep` opens Skep's own shell (`src/cli/shell/run.ts`) and never this.
 *
 * Order: claude, then codex, then pi. The human's words go to that agent as its initial prompt.
 * Skep's own guide is appended to the agent's system prompt, not a replacement for it. The agent
 * keeps its own TUI. Skep does not draw one and does not approve tool use.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import { CliError, EXIT } from "../output.js";

export const AGENT_ORDER = ["claude", "codex", "pi"] as const;
export type AgentKind = (typeof AGENT_ORDER)[number];

export interface AgentLaunch {
  kind: AgentKind;
  argv0: string;
  args: string[];
}

/** Which installed agent to open. `which` is injected so tests never touch the real PATH. */
export async function selectAgent(
  which: (name: string) => Promise<string | null>,
  requested?: AgentKind,
): Promise<{ kind: AgentKind; bin: string }> {
  const order = requested === undefined ? AGENT_ORDER : [requested];
  for (const kind of order) {
    const bin = await which(kind);
    if (bin !== null && bin !== "") return { kind, bin };
  }
  const wanted = requested ?? AGENT_ORDER.join(", ");
  throw new CliError(
    "no_agent",
    `no agent installed (${wanted}); install claude, codex or pi`,
    EXIT.error,
  );
}

/**
 * Argv for one interactive session. `prompt` is the human's text, passed as an argument, never
 * through a shell. The guide is a file path except for pi, which only accepts the text.
 */
export function agentArgs(guide: string, prompt?: string): string[] {
  const words = prompt?.trim() ?? "";
  // The agent's own system prompt stays. Skep's guide is part of the first message, because
  // Codex has no append-only flag and one shape must work for all three.
  const message = words === "" ? guide : `${guide}\n\n${words}`;
  return [message];
}

export function guidePath(): string {
  return fileURLToPath(new URL("../agent-guide/SKILL.md", import.meta.url));
}

/** Look up `name` in PATH. Returns null when it is not installed. */
export async function whichOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command("tui")
    .description("Open the raw agent TUI (claude, then codex, then pi); advanced")
    .argument("[prompt...]", "what to ask the agent")
    .option("--agent <name>", "claude, codex or pi (default: the first one installed)")
    .action(async (words: string[], opts: { agent?: string }) => {
      await launchAgent(ctx, words.join(" "), opts.agent);
    });
}

/** Replace this process with the agent. The agent's own screen is the interface. */
export async function launchAgent(
  ctx: CliContext,
  prompt: string,
  requested: string | undefined,
): Promise<void> {
  if (requested !== undefined && !AGENT_ORDER.includes(requested as AgentKind)) {
    throw new CliError("bad_agent", `--agent must be ${AGENT_ORDER.join(", ")}`, EXIT.usage);
  }
  const env = { ...process.env, ...ctx.env };
  const selected = await selectAgent(
    (name) => whichOnPath(name, env),
    requested as AgentKind | undefined,
  );
  const guide = guidePath();
  const text = await readGuide(guide);
  const args = agentArgs(text, prompt);
  ctx.stderr.write(`skep: ${selected.kind}\n`);
  const child = spawn(selected.bin, args, { stdio: "inherit", env, shell: false });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) process.kill(process.pid, signal);
      process.exitCode = code ?? 1;
      resolve();
    });
  });
}

async function readGuide(file: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
}
