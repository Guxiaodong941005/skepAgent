import { describe, expect, it } from "vitest";
import { agentArgs, selectAgent } from "./agent-tui.js";

describe("selectAgent", () => {
  const which = async (name: string) => (name === "codex" ? "/usr/bin/codex" : null);

  it("picks the first installed of claude, codex, pi", async () => {
    await expect(selectAgent(which)).resolves.toEqual({ kind: "codex", bin: "/usr/bin/codex" });
  });

  it("uses the requested agent when it is installed", async () => {
    const onlyPi = async (name: string) => (name === "pi" ? "/bin/pi" : null);
    await expect(selectAgent(onlyPi, "pi")).resolves.toEqual({ kind: "pi", bin: "/bin/pi" });
  });

  it("fails when nothing is installed", async () => {
    await expect(selectAgent(async () => null)).rejects.toThrow(/no agent installed/);
  });

  it("fails when the requested agent is missing", async () => {
    await expect(selectAgent(which, "claude")).rejects.toThrow(/claude/);
  });
});

describe("agentArgs", () => {
  it("sends the guide alone when the human typed nothing", () => {
    expect(agentArgs("use skep")).toEqual(["use skep"]);
  });

  it("puts the human's words after the guide", () => {
    expect(agentArgs("use skep", "add a test")).toEqual(["use skep\n\nadd a test"]);
  });
});
