import { describe, expect, it } from "vitest";
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
      "mac.local:7419 8632-1727-0308 --role web --agent pty",
      { code: "8632-1727-0308", host: "mac.local:7419", role: "web", agent: "pty" },
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
});
