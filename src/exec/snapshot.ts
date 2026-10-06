import type { CodeHost } from "../codehost/types.js";
import { workBranch } from "../core/ids.js";
import { CheckRunSchema, RelPathSchema, ShaSchema } from "../core/schemas/common.js";
import { type Snapshot, SnapshotSchema } from "../core/schemas/snapshot.js";
import type { GitRunner } from "../git/runner.js";

export class SnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SnapshotError";
  }
}

export interface SnapshotOptions {
  task: string;
  item: string;
  epoch: number;
  attemptId: string;
  repo: string;
  worktree: string;
  baseSha: string;
  /** null when the process did not stop, so its checkout cannot establish a stable fact. */
  headSha: string | null;
  invocationState: Snapshot["invocation_state"];
  /** Daemon-captured runs, never the work report's assertions. */
  checkRuns: Snapshot["check_runs"];
}

export interface SnapshotDependencies {
  git: GitRunner;
  codeHost: Pick<CodeHost, "remoteBranchSha">;
}

/** PRD §10.7: committed Git objects and the remote ref are the snapshot's authority. */
export async function buildSnapshot(
  options: SnapshotOptions,
  deps: SnapshotDependencies,
): Promise<Snapshot> {
  const branch = workBranch(options.task, options.item, options.epoch);
  const empty = SnapshotSchema.safeParse({
    schema: "skep.snapshot/v1",
    item: options.item,
    epoch: options.epoch,
    attempt_id: options.attemptId,
    branch,
    base_sha: options.baseSha,
    head_sha: options.headSha,
    pushed: false,
    invocation_state: options.invocationState,
    diffstat: { files: 0, insertions: 0, deletions: 0 },
    files_changed: [],
    check_runs: options.checkRuns.map((run) => CheckRunSchema.parse(run)),
    agent_note: null,
  });
  if (!empty.success) throw new SnapshotError("Cannot snapshot invalid attempt facts");
  if (options.headSha === null) return empty.data;
  try {
    const head = await deps.git.run(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: options.worktree,
    });
    if (ShaSchema.parse(head.stdout.trim()) !== options.headSha) {
      throw new SnapshotError("Snapshot HEAD changed; stop the process before checkpointing");
    }
    const diff = await deps.git.run(
      ["diff", "--numstat", "-z", "--no-renames", options.baseSha, options.headSha, "--"],
      { cwd: options.worktree },
    );
    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    if (diff.stdout !== "" && !diff.stdout.endsWith("\0")) {
      throw new SnapshotError("Git returned a truncated snapshot diff");
    }
    for (const entry of diff.stdout.split("\0").filter(Boolean)) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
      if (!match) throw new SnapshotError("Git returned an invalid snapshot diff");
      files.push(RelPathSchema.parse(match[3]));
      // Binary changes have no line count; their changed file is still a verifiable fact.
      if (match[1] !== "-") insertions += Number(match[1]);
      if (match[2] !== "-") deletions += Number(match[2]);
    }
    return SnapshotSchema.parse({
      ...empty.data,
      pushed: (await deps.codeHost.remoteBranchSha(options.repo, branch)) === options.headSha,
      diffstat: { files: files.length, insertions, deletions },
      files_changed: files,
    });
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError("Cannot verify checkpoint facts from Git and the code remote", {
      cause: error,
    });
  }
}
