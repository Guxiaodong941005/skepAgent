import { afterEach, describe, expect, it, vi } from "vitest";
import { T1 } from "../../../test/helpers/log-builder.js";
import { IntentSpecSchema } from "../../core/intent-spec.js";
import type { CliContext } from "../context.js";
import { runCli } from "../program.js";
import * as publisher from "../publish.js";

function capture() {
  const output = { stdout: "", stderr: "" };
  const ctx: CliContext = {
    env: { SKEP_HOME: ".skep-test" },
    stdout: {
      write: (text) => {
        output.stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        output.stderr += text;
      },
    },
    output: () => {
      throw new Error("CLI output is not initialized");
    },
  };
  const publish = vi
    .spyOn(publisher, "publishHuman")
    .mockResolvedValue({ status: "accepted", seq: 9 });
  return { ctx, output, publish };
}

afterEach(() => vi.restoreAllMocks());

describe("skep submit", () => {
  it.each(["pr", "mr", "push", "none"] as const)(
    "publishes %s through the human path",
    async (method) => {
      const f = capture();
      const args = ["submit", T1, "W1", "--method", method];
      if (method === "pr" || method === "mr")
        args.push("--pr-url", "https://example.invalid/pull/1", "--pr-number", "1");
      expect(await runCli(args, f.ctx)).toBe(0);
      const spec = f.publish.mock.calls[0]?.[1];
      expect(spec).toMatchObject({
        kind: "work.submit",
        task: T1,
        item: "W1",
        method,
        skip: false,
      });
      expect(IntentSpecSchema.safeParse(spec).success).toBe(true);
      expect(spec).not.toHaveProperty("epoch");
      expect(f.output.stdout).toBe("accepted #9\n");
    },
  );
  it("supports an explicit epoch and a separate skip decision", async () => {
    const f = capture();
    expect(await runCli(["submit", T1, "W1", "--skip", "--epoch", "2"], f.ctx)).toBe(0);
    expect(f.publish.mock.calls[0]?.[1]).toMatchObject({ method: "none", skip: true, epoch: 2 });
  });
  it.each(["pr", "mr"])("requires both PR fields for %s", async (method) => {
    for (const details of [
      [],
      ["--pr-url", "https://example.invalid/pull/1"],
      ["--pr-number", "1"],
    ]) {
      const f = capture();
      expect(
        await runCli(["--machine", "submit", T1, "W1", "--method", method, ...details], f.ctx),
      ).toBe(2);
      expect(f.output.stdout).toContain("pr_required");
      expect(f.publish).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });
  it.each(
    [
      [],
      ["--method", "ask"],
      ["--method", "skip"],
      ["--method", "push", "--epoch", "0"],
      ["--method", "push", "--pr-number", "1"],
      ["--skip", "--method", "pr"],
      ["--method", "pr", "--pr-url", "invalid", "--pr-number", "1"],
    ].map((options) => ({ options })),
  )("rejects invalid options $options before publication", async ({ options }) => {
    const f = capture();
    expect(await runCli(["submit", T1, "W1", ...options], f.ctx)).toBe(2);
    expect(f.publish).not.toHaveBeenCalled();
  });
});
