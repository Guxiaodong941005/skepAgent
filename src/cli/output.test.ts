import { describe, expect, it } from "vitest";
import { CliError, createOutput, EXIT } from "./output.js";

function streams(): { stdout: string; stderr: string; out: ReturnType<typeof createOutput> } {
  const buf = { stdout: "", stderr: "" };
  const out = createOutput({
    machine: true,
    stdout: {
      write: (s) => {
        buf.stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        buf.stderr += s;
      },
    },
  });
  return {
    get stdout() {
      return buf.stdout;
    },
    get stderr() {
      return buf.stderr;
    },
    out,
  };
}

describe("Output.fail", () => {
  it("prints one machine line with top-level ok:false plus the result (G5)", () => {
    const cap = streams();
    cap.out.fail(
      new CliError("invariant_violation", "invariant 7 failed", EXIT.error),
      { seed: 1 },
      () => "",
    );
    expect(cap.stderr).toBe("");
    const lines = cap.stdout.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      ok: false,
      error: { code: "invariant_violation", message: "invariant 7 failed" },
      result: { seed: 1 },
    });
  });

  it("prints the result on stdout and the skep line on stderr in human mode", () => {
    const buf = { stdout: "", stderr: "" };
    const out = createOutput({
      machine: false,
      stdout: {
        write: (s) => {
          buf.stdout += s;
        },
      },
      stderr: {
        write: (s) => {
          buf.stderr += s;
        },
      },
    });
    out.fail(
      new CliError("invariant_violation", "invariant 7 failed", EXIT.error),
      {},
      () => "summary\n",
    );
    expect(buf.stdout).toBe("summary\n");
    expect(buf.stderr).toBe("skep: invariant 7 failed\n");
  });
});
