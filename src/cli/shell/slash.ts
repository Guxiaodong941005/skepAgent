import type { z } from "zod";
import type { AgentCliSchema } from "../../core/schemas/common.js";

type AgentCli = z.infer<typeof AgentCliSchema>;

export interface ShellSession {
  role: "master" | "sub";
  code?: string;
}

export interface ShellCtx {
  device: string;
  cwd: string;
  role: string;
  session: ShellSession | null;
  agent: AgentCli;
}

export interface SlashCommand<Ctx extends ShellCtx = ShellCtx> {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  argsRequired?: boolean;
  visible?: (ctx: Ctx) => boolean;
  run: (ctx: Ctx, args: string) => Promise<SlashResult> | SlashResult;
}

export type SlashResult =
  | { type: "ok"; message?: string }
  | { type: "error"; message: string }
  | { type: "quit" };

export type SlashName = "start" | "join" | "status" | "intent" | "help" | "quit" | "agent";
export type SlashHandlers<Ctx extends ShellCtx = ShellCtx> = Record<
  SlashName,
  SlashCommand<Ctx>["run"]
>;

export const MAX_SLASH_ROWS = 6;

export function createSlashCommands<Ctx extends ShellCtx>(
  handlers: SlashHandlers<Ctx>,
): SlashCommand<Ctx>[] {
  return [
    { name: "start", description: "start a local session master", run: handlers.start },
    {
      name: "join",
      description: "join a session by code or local master",
      usage: "[code] [--host host:port]",
      run: handlers.join,
    },
    { name: "status", description: "show session status", run: handlers.status },
    {
      name: "intent",
      description: "submit an intent to the session",
      usage: "<text>",
      argsRequired: true,
      run: handlers.intent,
    },
    { name: "help", description: "list commands", run: handlers.help },
    {
      name: "quit",
      aliases: ["exit"],
      description: "leave the shell",
      run: handlers.quit,
    },
    {
      name: "agent",
      description: "set the preferred agent for session work items",
      usage: "[claude|codex|pi]",
      run: handlers.agent,
    },
  ];
}

export function parseSlashCommand(draft: string): { name: string; args: string } | null {
  const match = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  return match === null ? null : { name: match[1] ?? "", args: (match[2] ?? "").trim() };
}

export function findSlashCommand<Ctx extends ShellCtx>(
  commands: readonly SlashCommand<Ctx>[],
  name: string,
): SlashCommand<Ctx> | undefined {
  const token = name.toLowerCase();
  return commands.find(
    (command) =>
      command.name.toLowerCase() === token ||
      command.aliases?.some((alias) => alias.toLowerCase() === token),
  );
}

export function unknownCommand(name: string): SlashResult {
  return { type: "error", message: `unknown command: /${name} — try /help` };
}

export async function dispatchSlash<Ctx extends ShellCtx>(
  commands: readonly SlashCommand<Ctx>[],
  ctx: Ctx,
  draft: string,
): Promise<SlashResult | null> {
  const parsed = parseSlashCommand(draft);
  if (parsed === null) return null;
  const command = findSlashCommand(commands, parsed.name);
  if (command === undefined) return unknownCommand(parsed.name);
  if (command.argsRequired === true && parsed.args === "") {
    return {
      type: "error",
      message: `usage: /${command.name}${command.usage === undefined ? "" : ` ${command.usage}`}`,
    };
  }
  return command.run(ctx, parsed.args);
}

function matchScore(name: string, token: string): [number, number] | null {
  if (name.startsWith(token)) return [0, 0];
  let position = 0;
  let gaps = 0;
  for (const char of token) {
    const found = name.indexOf(char, position);
    if (found < 0) return null;
    gaps += found - position;
    position = found + 1;
  }
  return [1, gaps];
}

export function fuzzyCommands<Ctx extends ShellCtx>(
  commands: readonly SlashCommand<Ctx>[],
  token: string,
  ctx: Ctx,
): SlashCommand<Ctx>[] {
  const query = token.toLowerCase();
  const matches: { command: SlashCommand<Ctx>; score: [number, number]; index: number }[] = [];
  commands.forEach((command, index) => {
    if (command.visible?.(ctx) === false) return;
    let score: [number, number] | null = null;
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      const candidate = matchScore(name.toLowerCase(), query);
      if (
        candidate !== null &&
        (score === null ||
          candidate[0] < score[0] ||
          (candidate[0] === score[0] && candidate[1] < score[1]))
      ) {
        score = candidate;
      }
    }
    if (score !== null) matches.push({ command, score, index });
  });
  matches.sort(
    (left, right) =>
      left.score[0] - right.score[0] || left.score[1] - right.score[1] || left.index - right.index,
  );
  return matches.map(({ command }) => command);
}

export interface SlashMenu<Ctx extends ShellCtx = ShellCtx> {
  mode: "commands" | "arguments";
  commands: SlashCommand<Ctx>[];
}

export function slashMenu<Ctx extends ShellCtx>(
  draft: string,
  commands: readonly SlashCommand<Ctx>[],
  ctx: Ctx,
): SlashMenu<Ctx> | null {
  const token = /^\/(\S*)$/.exec(draft);
  if (token !== null) {
    return { mode: "commands", commands: fuzzyCommands(commands, token[1] ?? "", ctx) };
  }
  const args = /^\/(\S+)\s/.exec(draft);
  if (args === null) return null;
  const command = findSlashCommand(commands, args[1] ?? "");
  if (command?.usage === undefined || command.visible?.(ctx) === false) return null;
  return { mode: "arguments", commands: [command] };
}
