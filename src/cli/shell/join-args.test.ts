import { describe, expect, it } from "vitest";
import { formatJoinPaste, joinHint } from "../commands/session.js";
import { JOIN_USAGE, parseJoinArgs } from "./join-args.js";

describe("parseJoinArgs", () => {
  it.each([
    ["8632-1727-0308", { code: "8632-1727-0308" }],
    [
      "8632-1727-0308 --host 192.168.30.182:7419",
      { code: "8632-1727-0308", host: "192.168.30.182:7419" },
    ],
    [
      "--host 192.168.30.182:7419 --code 8632-1727-0308",
      { code: "8632-1727-0308", host: "192.168.30.182:7419" },
    ],
    [
      "--host=192.168.30.182:7419 --code=863217270308",
      { code: "863217270308", host: "192.168.30.182:7419" },
    ],
    ["192.168.30.182:7419 8632-1727-0308", { code: "8632-1727-0308", host: "192.168.30.182:7419" }],
    ["8632-1727-0308 192.168.30.182:7419", { code: "8632-1727-0308", host: "192.168.30.182:7419" }],
    ["[fe80::1]:7419 863217270308", { code: "863217270308", host: "[fe80::1]:7419" }],
    [
      "mac.local:7419 8632-1727-0308 --role web --agent codex",
      { code: "8632-1727-0308", host: "mac.local:7419", role: "web", agent: "codex" },
    ],
    [
      "8632-1727-0308 --agent pi --view herdr",
      { code: "8632-1727-0308", agent: "pi", view: "herdr" },
    ],
    [
      "8632-1727-0308 --role-dir ./role",
      {
        code: "8632-1727-0308",
        notes: ["--role-dir is ignored; AGENT.md is no longer required"],
      },
    ],
    ["8632-1727-0308 --submit commit", { code: "8632-1727-0308", submit: "commit" }],
    [
      "--host 203.0.113.7:7419 --code 8632-1727-0308 --repo app",
      { code: "8632-1727-0308", host: "203.0.113.7:7419", repo: "app" },
    ],
    [
      "--host h:1 --code 863217270308 --repo app --manual --submit none",
      { code: "863217270308", host: "h:1", repo: "app", manual: true, submit: "none" },
    ],
    // ORCH-6: live output is opted in per join.
    [
      "8632-1727-0308 h:1 --share-output",
      { code: "8632-1727-0308", host: "h:1", shareOutput: true },
    ],
    ["", {}],
  ])("reads %j", (args, expected) => {
    expect(parseJoinArgs(args)).toEqual(expected);
  });

  it.each([
    ["192.168.30.182:7419 nope", /nope is neither a 12-digit join code nor host:port/],
    ["8632-1727-0308 1111-2222-3333", /two join codes/],
    ["a:1 b:2", /two hosts/],
    ["8632-1727-0308 --code 1111-2222-3333", /two join codes/],
    ["a:1 --host b:2 8632-1727-0308", /two hosts/],
    ["--code 1234", /--code must be 12 digits, got 1234/],
    ["--host 192.168.30.182", /--host must be host:port/],
    ["--nope", /unknown option --nope/],
    ["a:1 1111-2222-3333 extra", /too many arguments/],
    ["--host a:7419 --host b:7419 --code 123456789012", /--host given twice/],
    ["--code 123456789012 --code 111122223333", /--code given twice/],
    ["--code 1234 5678 9012", /--code must be 12 digits/],
    [
      "--code 123456789012 --submit yolo",
      /--submit must be commit, pr, mr, push, none, ask, got yolo/,
    ],
    ["--code 123456789012 --agent gpt", /--agent must be claude, codex, pi/],
    ["--code 123456789012 --agent pty", /--agent pty is now --view pty/],
    ["--code 123456789012 --view tmux", /--view must be dry, pty, herdr, native, got tmux/],
  ])("rejects %j with the accepted forms", (args, problem) => {
    let message = "";
    try {
      parseJoinArgs(args);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(problem);
    expect(message).toContain(JOIN_USAGE);
  });

  it("leads its usage with the line a master prints to paste", () => {
    const lines = JOIN_USAGE.split("\n");
    expect(lines[0]).toBe("usage: /join <NNNN-NNNN-NNNN> <host:port>");
    expect(lines[1]).toBe("       /join --code <NNNN-NNNN-NNNN> --host <host:port>");
    // --repo and --device are optional overrides, never part of a usage form.
    expect(lines.filter((line) => line.includes("/join")).join("\n")).not.toMatch(
      /--repo|--device/,
    );
    expect(JOIN_USAGE).toMatch(/optional: --repo <name>, --device <name>/);
  });
});

describe("the pasteable /join line round-trips", () => {
  it.each(["h:1", "203.0.113.7:7419", "[fe80::1]:7419", "[::1]:7419", "master.lan:7419"])(
    "host %j",
    (host) => {
      const line = formatJoinPaste({ host, code: "863217270308" });
      expect(line.startsWith("/join ")).toBe(true);
      expect(parseJoinArgs(line.slice("/join ".length))).toEqual({
        host,
        code: "8632-1727-0308",
      });
    },
  );

  it("is just the code and the host: repo and device come from the joiner", () => {
    expect(formatJoinPaste({ host: "203.0.113.7:7419", code: "863217270308" })).toBe(
      "/join 8632-1727-0308 203.0.113.7:7419",
    );
  });

  it("lets peers join from any repo, without a --repo flag", () => {
    const hint = joinHint({ host: "h:1", code: "863217270308" });
    expect(hint).toBe(
      "on another device, from a checkout of any repo, paste into skep: " +
        "/join 8632-1727-0308 h:1\n" +
        "or from a shell: skep session join --code 8632-1727-0308 --host h:1",
    );
    expect(hint).not.toContain("--repo");
  });

  it("refuses an unterminated quote", () => {
    expect(() => parseJoinArgs('--repo "my app')).toThrow(/unterminated quote/);
  });
});

it("preserves --via-ssh with the printed join grammar", () => {
  expect(parseJoinArgs("1234-5678-9012 127.0.0.1:41234 --via-ssh user@gateway")).toMatchObject({
    viaSsh: "user@gateway",
    host: "127.0.0.1:41234",
  });
});
