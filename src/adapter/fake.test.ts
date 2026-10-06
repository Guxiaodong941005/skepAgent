import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlanSchema } from "../core/schemas/plan.js";
import { ReviewSchema } from "../core/schemas/review.js";
import { WorkReportSchema } from "../core/schemas/work-report.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import type { Clock } from "../util/clock.js";
import { FakeAdapter, FakeAdapterError, type FakeScript } from "./fake.js";
import { extractJson, runStructured } from "./structured.js";
import type { AdapterInvocation, InvocationKind } from "./types.js";

const directories: string[] = [];
async function tempWorktree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-adapter-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function invocation(overrides: Partial<AdapterInvocation> = {}): AdapterInvocation {
  return {
    kind: "work",
    cwd: "/worktree",
    prompt: "Implement the example.",
    outputSchema: z.toJSONSchema(WorkReportSchema),
    timeoutMs: 1000,
    env: {},
    logPath: "/worktree/run.log",
    scratchDir: "/worktree/scratch",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function setup(
  script: FakeScript,
  options: { seed?: number; clock?: Clock; kind?: InvocationKind } = {},
) {
  const time = new VirtualTime();
  const clock = options.clock ?? new FakeClock(time);
  const adapter = new FakeAdapter({
    clock,
    seed: options.seed ?? 42,
    scripts: { [options.kind ?? "work"]: script },
  });
  return { time, clock, adapter };
}

describe("FakeAdapter", () => {
  it("implements the adapter contract and probes a configurable pinned fake CLI", async () => {
    const adapter = new FakeAdapter({
      clock: new FakeClock(new VirtualTime()),
      seed: 1,
      scripts: {},
      cli: "pi",
      version: "fake-pi/v1",
    });
    expect(adapter.cli).toBe("pi");
    expect(await adapter.probe()).toMatchObject({ ok: true, version: "fake-pi/v1" });
    expect(adapter.invocations).toEqual([]);
  });

  it.each<InvocationKind>(["plan", "review", "work", "fixup", "repair"])(
    "returns schema-valid default output for %s",
    async (kind) => {
      const { adapter } = setup({ kind: "success" }, { kind });
      const schema =
        kind === "plan" ? PlanSchema : kind === "review" ? ReviewSchema : WorkReportSchema;
      const result = await adapter.invoke(
        invocation({ kind, outputSchema: z.toJSONSchema(schema) }),
      );
      expect(result).toMatchObject({
        outcome: "completed",
        exitCode: 0,
        durationMs: 0,
        usage: null,
        pid: null,
      });
      expect(schema.safeParse(extractJson(result.finalMessage ?? "")).success).toBe(true);
    },
  );

  it.each(["plan", "review"] as const)(
    "repairs a %s using its original output schema",
    async (kind) => {
      const adapter = new FakeAdapter({
        clock: new FakeClock(new VirtualTime()),
        seed: 42,
        scripts: { [kind]: { kind: "invalidJson" }, repair: { kind: "success" } },
      });
      if (kind === "plan")
        expect((await runStructured(adapter, invocation({ kind }), PlanSchema)).ok).toBe(true);
      else expect((await runStructured(adapter, invocation({ kind }), ReviewSchema)).ok).toBe(true);
      expect(adapter.invocations.map((inv) => inv.kind)).toEqual([kind, "repair"]);
    },
  );

  it("writes seeded files reproducibly in temp worktrees and reports the intended paths", async () => {
    const script: FakeScript = {
      kind: "success",
      files: ["src/example.ts", "test/example.test.ts"],
    };
    const firstDir = await tempWorktree();
    const secondDir = await tempWorktree();
    const thirdDir = await tempWorktree();
    const first = setup(script);
    const second = setup(script);
    const third = setup(script, { seed: 43 });
    const result = await first.adapter.invoke(invocation({ cwd: firstDir }));
    await second.adapter.invoke(invocation({ cwd: secondDir }));
    await third.adapter.invoke(invocation({ cwd: thirdDir }));
    const contents = await Promise.all(
      [firstDir, secondDir, thirdDir].map((dir) =>
        readFile(path.join(dir, "src/example.ts"), "utf8"),
      ),
    );
    expect(contents[0]).toEqual(contents[1]);
    expect(contents[0]).not.toEqual(contents[2]);
    expect(await readFile(path.join(firstDir, "test/example.test.ts"), "utf8")).not.toEqual(
      contents[0],
    );
    expect(WorkReportSchema.parse(extractJson(result.finalMessage ?? "")).files_intended).toEqual(
      script.files,
    );
    await first.adapter.invoke(invocation({ cwd: firstDir }));
    expect(await readFile(path.join(firstDir, "src/example.ts"), "utf8")).not.toEqual(contents[0]);
  });

  it("allows explicit file contents and an injected filesystem for deliberate check outcomes", async () => {
    const write = vi.fn(async (_cwd: string, _relativePath: string, _content: string) => {});
    const adapter = new FakeAdapter({
      clock: new FakeClock(new VirtualTime()),
      seed: 42,
      fileWriter: { write },
      scripts: {
        fixup: {
          kind: "success",
          files: [{ path: "src/example.ts", content: "export const passes = true;\n" }],
        },
      },
    });
    await adapter.invoke(invocation({ kind: "fixup" }));
    expect(write).toHaveBeenCalledExactlyOnceWith(
      "/worktree",
      "src/example.ts",
      "export const passes = true;\n",
    );
  });

  it("returns a supplied scenario output without asserting its validity", async () => {
    const { adapter } = setup({ kind: "success", output: { example: true } });
    expect(extractJson((await adapter.invoke(invocation())).finalMessage ?? "")).toEqual({
      example: true,
    });
    const nullOutput = setup({ kind: "success", output: null });
    expect((await nullOutput.adapter.invoke(invocation())).finalMessage).toBe("null");
  });

  it("consumes scripts independently per invocation kind and supports repeating scripts", async () => {
    const adapter = new FakeAdapter({
      clock: new FakeClock(new VirtualTime()),
      seed: 1,
      scripts: {
        work: [{ kind: "invalidJson" }, { kind: "success" }],
        review: { kind: "permissionPrompt" },
      },
    });
    expect(extractJson((await adapter.invoke(invocation())).finalMessage ?? "")).toBeNull();
    expect((await adapter.invoke(invocation({ kind: "review" }))).outcome).toBe(
      "permission_prompt",
    );
    expect((await adapter.invoke(invocation())).outcome).toBe("completed");
    expect((await adapter.invoke(invocation({ kind: "review" }))).outcome).toBe(
      "permission_prompt",
    );
    await expect(adapter.invoke(invocation())).rejects.toThrow(FakeAdapterError);
    await expect(adapter.invoke(invocation({ kind: "plan" }))).rejects.toThrow(
      "No fake script for plan",
    );
    expect(adapter.invocations.map((inv) => inv.kind)).toEqual([
      "work",
      "review",
      "work",
      "review",
      "work",
      "plan",
    ]);
  });

  it("runs the complete invalidJson to repair success and repeated invalidJson failure paths", async () => {
    const clock = new FakeClock(new VirtualTime());
    const success = new FakeAdapter({
      clock,
      seed: 1,
      scripts: { work: { kind: "invalidJson" }, repair: { kind: "success" } },
    });
    expect((await runStructured(success, invocation(), WorkReportSchema)).ok).toBe(true);
    expect(success.invocations.map((inv) => inv.kind)).toEqual(["work", "repair"]);
    const failure = new FakeAdapter({
      clock,
      seed: 1,
      scripts: { work: { kind: "invalidJson" }, repair: { kind: "invalidJson" } },
    });
    expect(await runStructured(failure, invocation(), WorkReportSchema)).toMatchObject({
      ok: false,
      error: "invalid_output",
    });
    expect(failure.invocations).toHaveLength(2);
  });

  it.each(["wrongEvidence", "validButWrongEvidence"] as const)(
    "keeps %s schema-valid while supplying a false digest",
    async (kind) => {
      const { adapter } = setup({ kind });
      const result = await runStructured(adapter, invocation(), WorkReportSchema);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected schema-valid wrong evidence.");
      const evidence = result.value.replan_request?.evidence[0];
      if (evidence?.type !== "file_span") throw new Error("Expected file evidence.");
      expect(evidence.sha256).not.toBe(
        createHash("sha256").update("Actual example line.").digest("hex"),
      );
      expect(evidence.excerpt).not.toBe("Actual example line.");
      expect(adapter.invocations).toHaveLength(1);
    },
  );

  it("also supplies schema-valid wrong evidence for a blocking review", async () => {
    const { adapter } = setup({ kind: "wrongEvidence" }, { kind: "review" });
    const result = await adapter.invoke(
      invocation({ kind: "review", outputSchema: z.toJSONSchema(ReviewSchema) }),
    );
    expect(ReviewSchema.parse(extractJson(result.finalMessage ?? ""))).toMatchObject({
      verdict: "block",
      blockers: [{ evidence: [{ type: "file_span" }] }],
    });
  });

  it("returns an explicit replan request with the supplied evidence", async () => {
    const evidence = {
      id: "ev_1",
      type: "command_run" as const,
      run_id: "run_1",
      argv_sha256: "0".repeat(64),
      sha: "a".repeat(40),
      exit: 1,
      log_sha256: "1".repeat(64),
    };
    const { adapter } = setup({
      kind: "replanRequest",
      summary: "Revise the example assumption.",
      evidence: [evidence],
    });
    const result = await runStructured(adapter, invocation(), WorkReportSchema);
    expect(result).toMatchObject({
      ok: true,
      value: {
        replan_request: { summary: "Revise the example assumption.", evidence: [evidence] },
      },
    });
  });

  it("waits on injected time for slow scripts before editing files", async () => {
    const time = new VirtualTime();
    const write = vi.fn(async (_cwd: string, _path: string, _content: string) => {});
    const adapter = new FakeAdapter({
      clock: new FakeClock(time),
      seed: 42,
      fileWriter: { write },
      scripts: { work: { kind: "slow", ms: 100, files: ["src/example.ts"] } },
    });
    const pending = adapter.invoke(invocation());
    await time.advance(99);
    expect(write).not.toHaveBeenCalled();
    await time.advance(1);
    expect(await pending).toMatchObject({ outcome: "completed", durationMs: 100 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each<FakeScript>([{ kind: "hang" }, { kind: "slow", ms: 2000 }, { kind: "slow", ms: 1000 }])(
    "times out bounded pending scripts: %j",
    async (script) => {
      const { time, adapter } = setup(script);
      let done = false;
      const pending = adapter.invoke(invocation()).then((result) => {
        done = true;
        return result;
      });
      await time.advance(999);
      expect(done).toBe(false);
      await time.advance(1);
      expect(await pending).toMatchObject({
        outcome: "timeout",
        durationMs: 1000,
        finalMessage: null,
        exitCode: null,
      });
      expect(await time.runNext()).toBe(false);
    },
  );

  it.each<FakeScript>([{ kind: "hang" }, { kind: "slow", ms: 100 }])(
    "interrupts pending scripts when aborted and cancels the sleep: %j",
    async (script) => {
      const { time, adapter } = setup(script);
      const controller = new AbortController();
      const pending = adapter.invoke(invocation({ signal: controller.signal }));
      await time.advance(10);
      controller.abort();
      expect(await pending).toMatchObject({
        outcome: "interrupted",
        durationMs: 10,
        finalMessage: null,
      });
      expect(await time.runNext()).toBe(false);
    },
  );

  it("interrupts a pre-aborted invocation without consuming its script or editing files", async () => {
    const { adapter } = setup({ kind: "success" });
    const controller = new AbortController();
    controller.abort();
    expect((await adapter.invoke(invocation({ signal: controller.signal }))).outcome).toBe(
      "interrupted",
    );
    expect((await adapter.invoke(invocation())).outcome).toBe("completed");
  });

  it.each([{ kind: "permissionPrompt" } as const, { kind: "crash", exitCode: 2 } as const])(
    "records %j as a process failure without triggering repair",
    async (script) => {
      const { adapter } = setup(script);
      expect(await runStructured(adapter, invocation(), WorkReportSchema)).toMatchObject({
        ok: false,
        error: script.kind === "crash" ? "crash" : "permission_prompt",
      });
      expect(adapter.invocations).toHaveLength(1);
    },
  );

  it("rejects invalid timings, crash codes, and empty replan evidence", async () => {
    await expect(setup({ kind: "slow", ms: -1 }).adapter.invoke(invocation())).rejects.toThrow(
      "duration",
    );
    await expect(
      setup({ kind: "success" }).adapter.invoke(
        invocation({ timeoutMs: Number.POSITIVE_INFINITY }),
      ),
    ).rejects.toThrow("timeoutMs");
    await expect(
      setup({ kind: "crash", exitCode: 0 }).adapter.invoke(invocation()),
    ).rejects.toThrow("non-zero integer");
    await expect(
      setup({ kind: "replanRequest", evidence: [] }).adapter.invoke(invocation()),
    ).rejects.toThrow(z.ZodError);
  });

  it.each([
    "../outside.ts",
    "/outside.ts",
    "src/../../outside.ts",
    "src\\example.ts",
    "src/./example.ts",
    "src/\0example.ts",
  ])("rejects invalid file paths before any writes: %s", async (invalid) => {
    const write = vi.fn(async (_cwd: string, _path: string, _content: string) => {});
    const adapter = new FakeAdapter({
      clock: new FakeClock(new VirtualTime()),
      seed: 1,
      fileWriter: { write },
      scripts: { work: { kind: "success", files: ["src/valid.ts", invalid] } },
    });
    await expect(adapter.invoke(invocation())).rejects.toThrow(z.ZodError);
    expect(write).not.toHaveBeenCalled();
  });

  it("rejects symlinks leaving the temp worktree", async () => {
    const cwd = await tempWorktree();
    const outside = await tempWorktree();
    await symlink(outside, path.join(cwd, "linked"), "dir");
    const { adapter } = setup({ kind: "success", files: ["linked/example.ts"] });
    await expect(adapter.invoke(invocation({ cwd }))).rejects.toThrow(FakeAdapterError);
    expect(await readdir(outside)).toEqual([]);
  });

  it.each<InvocationKind>(["plan", "review", "repair"])(
    "refuses file edits from read-only %s invocations",
    async (kind) => {
      const { adapter } = setup({ kind: "success", files: ["src/example.ts"] }, { kind });
      await expect(adapter.invoke(invocation({ kind }))).rejects.toThrow("only for work/fixup");
    },
  );

  it("surfaces clock and file write failures with actionable typed errors", async () => {
    const failure = new Error("Example I/O failure.");
    const clock: Clock = {
      monotonicMs: () => 0,
      nowMs: () => 0,
      sleep: async () => {
        throw failure;
      },
    };
    await expect(
      setup({ kind: "slow", ms: 10 }, { clock }).adapter.invoke(invocation()),
    ).rejects.toMatchObject({
      name: "FakeAdapterError",
      message: "Fake adapter clock.sleep failed.",
      cause: failure,
    });
    const adapter = new FakeAdapter({
      clock,
      seed: 1,
      fileWriter: {
        write: async () => {
          throw failure;
        },
      },
      scripts: { work: { kind: "success", files: ["src/example.ts"] } },
    });
    await expect(adapter.invoke(invocation())).rejects.toMatchObject({
      name: "FakeAdapterError",
      message: "Could not write fake worktree file src/example.ts.",
      cause: failure,
    });
  });
});
