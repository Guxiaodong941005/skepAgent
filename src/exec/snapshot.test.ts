import { describe, expect, it, vi } from "vitest";
import type { CodeHost } from "../codehost/types.js";
import { workBranch } from "../core/ids.js";
import type { GitRunner } from "../git/runner.js";
import { buildSnapshot, SnapshotError, type SnapshotOptions } from "./snapshot.js";

const head = "b".repeat(40);
const base = "a".repeat(40);
const options: SnapshotOptions = {
  task: "T-20261006-abcd",
  item: "W1",
  epoch: 1,
  attemptId: "att_aabbccddeeff",
  repo: "app",
  worktree: "example-worktree",
  baseSha: base,
  headSha: head,
  invocationState: "interrupted",
  checkRuns: [],
};

function dependencies(diff = "2\t1\tsrc/example.ts\0-\t-\timage.png\0") {
  const run = vi.fn<GitRunner["run"]>(async (args) => ({
    code: 0,
    stdout: args[0] === "rev-parse" ? `${head}\n` : diff,
    stderr: "",
  }));
  const remoteBranchSha = vi.fn<CodeHost["remoteBranchSha"]>(async () => head);
  return { git: { run }, codeHost: { remoteBranchSha } };
}

describe("mechanical snapshots", () => {
  it("builds only verifiable facts, counting binary files without inventing line counts", async () => {
    const deps = dependencies();
    expect(await buildSnapshot(options, deps)).toEqual({
      schema: "skep.snapshot/v1",
      item: "W1",
      epoch: 1,
      attempt_id: options.attemptId,
      branch: workBranch(options.task, "W1", 1),
      base_sha: base,
      head_sha: head,
      pushed: true,
      invocation_state: "interrupted",
      diffstat: { files: 2, insertions: 2, deletions: 1 },
      files_changed: ["src/example.ts", "image.png"],
      check_runs: [],
      agent_note: null,
    });
    expect(deps.git.run).toHaveBeenCalledWith(
      ["diff", "--numstat", "-z", "--no-renames", base, head, "--"],
      { cwd: options.worktree },
    );
  });

  it("records pushed=false when the remote has not confirmed this head", async () => {
    const deps = dependencies("");
    deps.codeHost.remoteBranchSha.mockResolvedValue(base);
    expect(await buildSnapshot(options, deps)).toMatchObject({
      pushed: false,
      diffstat: { files: 0, insertions: 0, deletions: 0 },
    });
  });

  it("does not inspect an unstable checkout when the head is unknown", async () => {
    const deps = dependencies();
    expect(
      await buildSnapshot({ ...options, headSha: null, invocationState: "unknown" }, deps),
    ).toMatchObject({
      head_sha: null,
      pushed: false,
      invocation_state: "unknown",
      files_changed: [],
    });
    expect(deps.git.run).not.toHaveBeenCalled();
    expect(deps.codeHost.remoteBranchSha).not.toHaveBeenCalled();
  });

  it("preserves tabs and newlines in NUL-delimited filenames", async () => {
    expect(
      await buildSnapshot(options, dependencies("1\t0\tsrc/example\tname\n.txt\0")),
    ).toMatchObject({ files_changed: ["src/example\tname\n.txt"] });
  });

  it("rejects a checkout whose HEAD moved after the daemon's commit", async () => {
    const deps = dependencies();
    deps.git.run.mockResolvedValue({ code: 0, stdout: `${base}\n`, stderr: "" });
    await expect(buildSnapshot(options, deps)).rejects.toThrow("HEAD changed");
  });

  it.each(["bad\0", "1\t0\tsrc/example.ts", "1\t0\t../escape\0"])(
    "rejects invalid Git output %j",
    async (diff) => {
      await expect(buildSnapshot(options, dependencies(diff))).rejects.toThrow(SnapshotError);
    },
  );

  it("validates check metadata and attempt facts with strict protocol schemas", async () => {
    const check = {
      run_id: "run_example",
      check: "unit",
      sha: head,
      exit: 1,
      duration_ms: 10,
      log_sha256: "c".repeat(64),
      passed: 2,
      failed: 1,
    };
    expect(await buildSnapshot({ ...options, checkRuns: [check] }, dependencies())).toMatchObject({
      check_runs: [check],
    });
    await expect(buildSnapshot({ ...options, epoch: 0 }, dependencies())).rejects.toThrow(
      SnapshotError,
    );
    await expect(
      buildSnapshot(
        { ...options, checkRuns: [{ ...check, extra: 1 } as typeof check] },
        dependencies(),
      ),
    ).rejects.toThrow();
  });
});
