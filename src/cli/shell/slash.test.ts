import { describe, expect, it, vi } from "vitest";
import {
  createSlashCommands,
  dispatchSlash,
  findSlashCommand,
  fuzzyCommands,
  parseSlashCommand,
  type ShellCtx,
  type SlashCommand,
  slashMenu,
  unknownCommand,
} from "./slash.js";

const context: ShellCtx = {
  device: "laptop",
  cwd: "~/project",
  role: "coding",
  session: null,
  agent: "codex",
};

function registry() {
  const run = vi.fn(() => ({ type: "ok" as const }));
  const commands = createSlashCommands({
    start: run,
    join: run,
    status: run,
    intent: run,
    help: run,
    quit: run,
    agent: run,
  });
  return { commands, run };
}

describe("slash registry", () => {
  it("defines exactly the MVP commands and the exit alias with injected handlers", () => {
    const { commands, run } = registry();
    expect(commands.map(({ name }) => name)).toEqual([
      "start",
      "join",
      "status",
      "intent",
      "help",
      "quit",
      "agent",
    ]);
    expect(findSlashCommand(commands, "exit")?.name).toBe("quit");
    expect(commands.every((command) => command.run === run)).toBe(true);
    expect(findSlashCommand(commands, "join")?.argsRequired).not.toBe(true);
    expect(findSlashCommand(commands, "agent")?.description).toContain("session work items");
  });

  it("parses the join token separately from its code and host arguments", () => {
    expect(parseSlashCommand("/join 4821-0937-5520 --host example.invalid:7419")).toEqual({
      name: "join",
      args: "4821-0937-5520 --host example.invalid:7419",
    });
    expect(parseSlashCommand("  /join   ")).toEqual({ name: "join", args: "" });
    expect(parseSlashCommand("/intent redesign the auth middleware")).toEqual({
      name: "intent",
      args: "redesign the auth middleware",
    });
    expect(parseSlashCommand("a goal /join")).toBeNull();
  });

  it("dispatches slash arguments unchanged to the injected handler and context", async () => {
    const { commands, run } = registry();
    const args = '4821-0937-5520 --host example.invalid:7419 --role "front end"';
    expect(await dispatchSlash(commands, context, `/join ${args}`)).toEqual({ type: "ok" });
    expect(run).toHaveBeenCalledWith(context, args);
    await dispatchSlash(commands, context, "/join");
    expect(run).toHaveBeenLastCalledWith(context, "");
  });

  it("runs aliases and returns injected quit and asynchronous results", async () => {
    const { commands } = registry();
    const quit = findSlashCommand(commands, "quit");
    if (quit === undefined) throw new Error("missing quit fixture");
    quit.run = () => ({ type: "quit" });
    expect(await dispatchSlash(commands, context, "/exit")).toEqual({ type: "quit" });
    quit.run = async () => ({ type: "ok", message: "left the session" });
    expect(await dispatchSlash(commands, context, "/QUIT")).toEqual({
      type: "ok",
      message: "left the session",
    });
  });

  it("gives the prescribed unknown command helper without running a handler", async () => {
    const { commands, run } = registry();
    expect(unknownCommand("foo")).toEqual({
      type: "error",
      message: "unknown command: /foo — try /help",
    });
    expect(await dispatchSlash(commands, context, "/foo")).toEqual(unknownCommand("foo"));
    expect(await dispatchSlash(commands, context, "/")).toEqual(unknownCommand(""));
    expect(await dispatchSlash(commands, context, "a free-form goal")).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("requires intent text and provides usage instead of invoking the handler", async () => {
    const { commands, run } = registry();
    expect(await dispatchSlash(commands, context, "/intent")).toEqual({
      type: "error",
      message: "usage: /intent <text>",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not swallow errors from session handlers", async () => {
    const command: SlashCommand = {
      name: "start",
      description: "start",
      run: () => {
        throw new Error("session is unavailable");
      },
    };
    await expect(dispatchSlash([command], context, "/start")).rejects.toThrow(
      "session is unavailable",
    );
  });

  it("supports a wire-specific context without coupling the registry to session I/O", async () => {
    const wireContext = { ...context, messages: [] as string[] };
    const run = (ctx: typeof wireContext, args: string) => {
      ctx.messages.push(args);
      return { type: "ok" as const };
    };
    const commands = createSlashCommands({
      start: run,
      join: run,
      status: run,
      intent: run,
      help: run,
      quit: run,
      agent: run,
    });
    await dispatchSlash(commands, wireContext, "/intent test the wire");
    expect(wireContext.messages).toEqual(["test the wire"]);
  });
});

describe("slash menu", () => {
  it("ranks prefixes before subsequences and preserves registry order on ties", () => {
    const run = () => ({ type: "ok" as const });
    const commands = ["restart", "status", "start", "stop"].map((name) => ({
      name,
      description: name,
      run,
    }));
    expect(fuzzyCommands(commands, "st", context).map(({ name }) => name)).toEqual([
      "status",
      "start",
      "stop",
      "restart",
    ]);
    expect(fuzzyCommands(commands, "srt", context).map(({ name }) => name)).toEqual([
      "start",
      "restart",
    ]);
    expect(fuzzyCommands(commands, "missing", context)).toEqual([]);
  });

  it("matches aliases and case-insensitive tokens", () => {
    const { commands } = registry();
    expect(fuzzyCommands(commands, "EX", context).map(({ name }) => name)).toEqual(["quit"]);
    expect(fuzzyCommands(commands, "Jo", context).map(({ name }) => name)).toEqual(["join"]);
  });

  it("hides invisible commands from menus but still dispatches their full names", async () => {
    const { commands, run } = registry();
    const hidden: SlashCommand = {
      name: "secret",
      description: "hidden command",
      usage: "[text]",
      visible: (ctx) => ctx.session !== null,
      run,
    };
    expect(fuzzyCommands([...commands, hidden], "", context)).not.toContain(hidden);
    expect(slashMenu("/secret argument", [hidden], context)).toBeNull();
    await dispatchSlash([hidden], context, "/secret argument");
    expect(run).toHaveBeenCalledWith(context, "argument");
    expect(fuzzyCommands([hidden], "", { ...context, session: { role: "master" } })).toEqual([
      hidden,
    ]);
  });

  it("opens only for a leading slash token or a known command's argument hints", () => {
    const { commands } = registry();
    expect(slashMenu("/jo", commands, context)?.commands.map(({ name }) => name)).toEqual(["join"]);
    expect(slashMenu("/", commands, context)?.mode).toBe("commands");
    expect(slashMenu("/join 4821-0937-5520", commands, context)?.mode).toBe("arguments");
    expect(slashMenu("/exit ", commands, context)).toBeNull();
    expect(slashMenu("/missing argument", commands, context)).toBeNull();
    expect(slashMenu("a goal /jo", commands, context)).toBeNull();
  });
});
