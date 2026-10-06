import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { T1 } from "../../test/helpers/log-builder.js";
import { sha256Hex } from "../core/canonical.js";
import type { Evidence } from "../core/schemas/evidence.js";
import type { Review } from "../core/schemas/review.js";
import { EvidenceVerifier } from "../exec/evidence.js";
import type { JournalRecord } from "../exec/journal.js";
import { bindAgentRuntime, runDaemon, verifyReviewEvidence } from "./skepd.js";

describe("daemon entrypoint", () => {
  it("hands CLI schema and output scratch access to the configured OS user", async () => {
    const root = await mkdtemp(join(process.cwd(), ".skep-runtime-test-"));
    try {
      const capture = join(root, "invocation", "capture");
      await mkdir(capture, { recursive: true, mode: 0o700 });
      const schema = join(capture, "schema.json");
      await writeFile(schema, "{}", { mode: 0o600 });
      const spawn = vi.fn(async () => ({
        pid: 101,
        pgid: 101,
        startToken: "test",
        wait: async () => ({ code: 0, signal: null }),
        signalGroup: () => {},
      }));
      const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
      const runtime = bindAgentRuntime(
        { name: "native", spawn, isAlive: async () => true },
        identity,
        root,
      );
      await runtime.spawn({
        argv: [
          "codex",
          "--output-schema",
          schema,
          "--output-last-message",
          join(capture, "last.json"),
        ],
        cwd: root,
        env: { PATH: "agent-bin" },
        logPath: join(root, "output.log"),
      });
      expect((await stat(schema)).mode & 0o777).toBe(0o640);
      expect((await stat(capture)).mode & 0o777).toBe(0o770);
      expect(spawn).toHaveBeenCalledWith(expect.objectContaining(identity));
      await expect(
        runtime.spawn({
          argv: ["codex", "--output-last-message", join(root, "..", "outside.json")],
          cwd: root,
          env: {},
          logPath: join(root, "output.log"),
        }),
      ).rejects.toThrow("invocation directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("prints daemon flags without loading device config or integrations", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runDaemon(["--help"], { SKEP_HOME: ".skep-sim/home" });
      expect(write.mock.calls.map(([text]) => text).join("")).toContain("--agent-path");
    } finally {
      write.mockRestore();
    }
  });
  it("requires an explicit local user, home and PATH before starting a slot", async () => {
    await expect(runDaemon(["--role-dir", ".skep-sim/role"], {})).rejects.toThrow(
      "--agent-user, --agent-home and --agent-path",
    );
  });
  it("reports missing SK-602/SK-603 integrations without writing device state", async () => {
    await expect(runDaemon(["--home", ".skep-sim/home"], {})).rejects.toThrow(
      "requires the SK-602 ipc-server and SK-603 intent-spec",
    );
  });
});

describe("daemon review evidence", () => {
  function review(evidence: Evidence[]): Review {
    return {
      schema: "skep.review/v1",
      plan_version: 2,
      plan_hash: `sha256:${"a".repeat(64)}`,
      verdict: "block",
      blockers: [{ id: "B1", claim: "A trusted check failed", evidence }],
      suggestions: [],
    };
  }
  const run = {
    run_id: "local-check",
    sha: "b".repeat(40),
    check: "unit",
    exit: 1,
    duration_ms: 12,
    log_sha256: "c".repeat(64),
    argv_sha256: "d".repeat(64),
  };
  const check: Evidence = {
    id: "ev_check",
    type: "check_run",
    run_id: run.run_id,
    sha: run.sha,
    check: run.check,
    exit: run.exit,
    log_sha256: run.log_sha256,
  };
  const command: Evidence = {
    id: "ev_command",
    type: "command_run",
    run_id: run.run_id,
    sha: run.sha,
    exit: run.exit,
    log_sha256: run.log_sha256,
    argv_sha256: run.argv_sha256,
  };
  it.each([
    { item: "W2", epoch: 3 },
    { item: "W1", epoch: 2 },
    { item: "W2", epoch: 1 },
  ])("preserves local check and command evidence from $item epoch $epoch", async (attempt) => {
    const record: JournalRecord = {
      ...run,
      step: "check_run",
      ts_mono: 0,
      ts_wall: "2026-10-05T00:00:00Z",
    };
    const read = vi.fn(async (key: { task: string; item: string; epoch: number }) =>
      key.task === T1 && key.item === attempt.item && key.epoch === attempt.epoch ? [record] : [],
    );
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal: { read },
    });
    const result = await verifyReviewEvidence(
      review([check, command, { ...check, id: "ev_unknown", run_id: "remote-check" }]),
      { task_id: T1, epochs: { W1: 2, W2: 3 } },
      verifier,
    );
    expect(result.verdict).toBe("block");
    expect(result.blockers[0]?.evidence).toEqual([check, command]);
    expect(read).toHaveBeenCalledWith({ task: T1, ...attempt });
  });
  it("downgrades a block when no local attempt verifies its evidence", async () => {
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn() },
      mirror: { mirrorPath: vi.fn() },
      journal: { read: async () => [] },
    });
    const result = await verifyReviewEvidence(
      review([check]),
      { task_id: T1, epochs: { W2: 3 } },
      verifier,
    );
    expect(result.verdict).toBe("comment");
    expect(result.blockers).toEqual([]);
  });
  it("verifies file evidence before the task has any claimed attempts", async () => {
    const read = vi.fn();
    const verifier = new EvidenceVerifier({
      git: { run: vi.fn(async () => ({ code: 0, stdout: "pinned text\n", stderr: "" })) },
      mirror: { mirrorPath: async () => process.cwd() },
      journal: { read },
    });
    const input = review([
      {
        id: "ev_file",
        type: "file_span",
        repo: "https://example.invalid/code.git",
        commit: run.sha,
        path: "src/example.ts",
        lines: [1, 1],
        sha256: sha256Hex("pinned text"),
      },
    ]);
    expect(await verifyReviewEvidence(input, { task_id: T1, epochs: {} }, verifier)).toEqual(input);
    expect(read).not.toHaveBeenCalled();
  });
});
