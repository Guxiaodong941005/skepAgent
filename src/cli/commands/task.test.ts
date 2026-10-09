import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliContext } from "../context.js";
import { runCli } from "../program.js";
import * as publisher from "../publish.js";

function context(): CliContext {
  return {
    env: { SKEP_HOME: ".skep-test" },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    output: () => {
      throw new Error("CLI output is not initialized");
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("task new submit policy", () => {
  it.each(["device", "pr", "mr", "push", "none", "ask"] as const)(
    "threads override %s to task creation",
    async (submit) => {
      const publish = vi.spyOn(publisher, "publishHuman").mockResolvedValue({ status: "accepted" });
      expect(
        await runCli(
          ["task", "new", "Implement an example", "--repo", "app", "--submit", submit],
          context(),
        ),
      ).toBe(0);
      expect(publish.mock.calls[0]?.[1]).toMatchObject({ kind: "task.create", submit });
    },
  );
  it("defaults to the executing device's policy", async () => {
    const publish = vi.spyOn(publisher, "publishHuman").mockResolvedValue({ status: "accepted" });
    expect(await runCli(["task", "new", "Implement an example", "--repo", "app"], context())).toBe(
      0,
    );
    expect(publish.mock.calls[0]?.[1]).toMatchObject({ submit: "device" });
  });
  it("rejects skip as a task creation default", async () => {
    const publish = vi.spyOn(publisher, "publishHuman").mockResolvedValue({ status: "accepted" });
    expect(
      await runCli(
        ["task", "new", "Implement an example", "--repo", "app", "--submit", "skip"],
        context(),
      ),
    ).toBe(2);
    expect(publish).not.toHaveBeenCalled();
  });
});
