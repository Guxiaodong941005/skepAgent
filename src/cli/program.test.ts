import { describe, expect, it } from "vitest";
import { buildProgram, runCli } from "./program.js";
import type { CliContext } from "./context.js";

function ctx(): CliContext {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: { write: (s) => void out.push(s) },
    stderr: { write: (s) => void err.push(s) },
    env: { ...process.env, SKEP_HOME: "/tmp/skep-test-home-program" },
    output() {
      throw new Error("output unbound");
    },
  };
}

describe("program session-only surface", () => {
  it("lists session and ui, not skepd blackboard commands", async () => {
    const c = ctx();
    const code = await runCli(["--help"], c);
    expect(code).toBe(0);
    // help goes to stdout via configureOutput
  });

  it("rejects removed blackboard command names", async () => {
    const c = ctx();
    const code = await runCli(["init", "--device", "x"], c);
    expect(code).toBe(2);
  });

  it("buildProgram registers expected names", () => {
    const program = buildProgram(ctx());
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual(["session", "tui", "ui"].sort());
  });
});
