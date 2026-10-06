import { describe, expect, it, vi } from "vitest";
import { runScenario, type ScenarioResult } from "../../sim/runner.js";
import type { CliContext } from "../context.js";
import { runCli } from "../program.js";

vi.mock("../../sim/runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sim/runner.js")>();
  return { ...actual, runScenario: vi.fn(actual.runScenario) };
});

const runScenarioMock = vi.mocked(runScenario);

interface Captured {
  stdout: string;
  stderr: string;
  ctx: CliContext;
}

/** In-memory streams. The real `empty` run writes only under the sim scratch dir, never `~/.skep`. */
function capture(): Captured {
  const out = { stdout: "", stderr: "" };
  const ctx: CliContext = {
    stdout: {
      write: (s) => {
        out.stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        out.stderr += s;
      },
    },
    env: { SKEP_HOME: "/tmp/skep-cli-test" },
    output: () => {
      throw new Error("output() used before runCli");
    },
  };
  return {
    get stdout() {
      return out.stdout;
    },
    get stderr() {
      return out.stderr;
    },
    ctx,
  };
}

function oneLine(stdout: string): unknown {
  const lines = stdout.split("\n").filter((line) => line !== "");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "");
}

const VIOLATION: ScenarioResult["violations"][number] = {
  invariant: 7,
  seq: null,
  task_id: null,
  code: "heartbeat_on_main",
  detail: "main commit abc changes heartbeat data",
  node: null,
  seed: 42,
  step: 3,
  logDump: '{"entries":[]}',
};

describe("skep sim run", () => {
  it("prints one JSON line with ok, finalTip and no violations for empty seed 42", async () => {
    const cap = capture();
    const code = await runCli(
      ["sim", "run", "--seed", "42", "--scenario", "empty", "--machine"],
      cap.ctx,
    );
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");
    const body = oneLine(cap.stdout) as {
      ok: boolean;
      result: { ok: boolean; finalTip: string; steps: number; violations: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.finalTip).toMatch(/^[a-f0-9]{40}$/);
    expect(body.result.steps).toBe(12);
    expect(body.result.violations).toEqual([]);
    expect(runScenarioMock).toHaveBeenCalledWith("empty", 42, { steps: undefined });
  }, 30_000);

  it("prints a human summary naming the scenario, seed, steps and tip", async () => {
    const cap = capture();
    const code = await runCli(
      ["sim", "run", "--scenario", "empty", "--seed", "42", "--steps", "2"],
      cap.ctx,
    );
    expect(code).toBe(0);
    expect(cap.stderr).toBe("");
    expect(cap.stdout).toMatch(
      /^scenario empty seed 42: 2 steps, tip [a-f0-9]{40}\nno violations\n$/,
    );
  }, 30_000);

  it("rejects an unknown scenario as a usage error (exit 2)", async () => {
    const cap = capture();
    const code = await runCli(
      ["--machine", "sim", "run", "--scenario", "no-such-scenario"],
      cap.ctx,
    );
    expect(code).toBe(2);
    expect(cap.stderr).toBe("");
    const body = oneLine(cap.stdout) as { ok: boolean; error: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("usage");
    expect(body.error.message).toContain("no-such-scenario");
    expect(body.error.message).toContain("empty");
  });

  it("rejects an unknown scenario on stderr in human mode", async () => {
    const cap = capture();
    const code = await runCli(
      ["sim", "run", "--scenario", "no-such-scenario", "--seed", "1"],
      cap.ctx,
    );
    expect(code).toBe(2);
    expect(cap.stdout).toBe("");
    expect(cap.stderr).toMatch(/skep: .*no-such-scenario/);
  });

  it("exits 1 when the scenario reports violations, keeping them in the JSON result", async () => {
    runScenarioMock.mockResolvedValueOnce({
      finalTip: "a".repeat(40),
      steps: 3,
      violations: [VIOLATION],
    });
    const cap = capture();
    const code = await runCli(
      ["sim", "run", "--scenario", "empty", "--seed", "42", "--machine"],
      cap.ctx,
    );
    expect(code).toBe(1);
    expect(cap.stderr).toBe("");
    const body = oneLine(cap.stdout) as {
      ok: boolean;
      result: { ok: boolean; finalTip: string; violations: { code: string; detail: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(false);
    expect(body.result.finalTip).toBe("a".repeat(40));
    expect(body.result.violations).toEqual([
      {
        invariant: 7,
        seq: null,
        task_id: null,
        code: "heartbeat_on_main",
        detail: VIOLATION.detail,
        node: null,
        seed: 42,
        step: 3,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("logDump");
  });

  it("prints the violation summary on stdout and the error on stderr in human mode", async () => {
    runScenarioMock.mockResolvedValueOnce({
      finalTip: "b".repeat(40),
      steps: 3,
      violations: [
        VIOLATION,
        { ...VIOLATION, invariant: 1, code: "same_tip_state_mismatch", step: 4 },
      ],
    });
    const cap = capture();
    const code = await runCli(["sim", "run", "--scenario", "empty"], cap.ctx);
    expect(code).toBe(1);
    expect(cap.stdout).toContain(`tip ${"b".repeat(40)}`);
    expect(cap.stdout).toContain("2 violation(s)");
    expect(cap.stdout).toContain("invariant 7 (heartbeat_on_main) at step 3");
    expect(cap.stdout).not.toContain("logDump");
    expect(cap.stderr).toMatch(/^skep: simulation invariant 7 failed at step 3: .+\(\+1 more\)\n$/);
  });
});
