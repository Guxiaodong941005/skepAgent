import { chmod, mkdir } from "node:fs/promises";
import type { Sha } from "../core/ids.js";
import { ShaSchema } from "../core/schemas/common.js";
import type { GitRunner } from "../git/runner.js";

const MAIN_REFSPEC = "+refs/heads/main:refs/remotes/origin/main";
const HEARTBEAT_REFSPEC = "+refs/heads/hb/*:refs/remotes/origin/hb/*";

export class BlackboardCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlackboardCloneError";
  }
}

export class BlackboardClone {
  readonly dir: string;
  readonly remoteUrl: string;
  private readonly git: GitRunner;

  constructor(deps: { git: GitRunner; dir: string; remoteUrl: string }) {
    this.git = deps.git;
    this.dir = deps.dir;
    this.remoteUrl = deps.remoteUrl;
    if (deps.remoteUrl.length === 0 || /[\0\r\n]/.test(deps.remoteUrl)) {
      throw new BlackboardCloneError("Blackboard remote URL must be nonempty without NUL or LF");
    }
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await chmod(this.dir, 0o700);
    const existing = await this.git.run(["rev-parse", "--is-bare-repository"], {
      cwd: this.dir,
      allowFailure: true,
    });
    if (existing.code === 0 && existing.stdout.trim() === "true") {
      throw new BlackboardCloneError(`Blackboard clone ${this.dir} must be non-bare`);
    }
    // An empty remote has no main yet; init also supports the human's genesis bootstrap (§7.1).
    await this.git.run(["init", "--initial-branch=main", "."], { cwd: this.dir });
    const bare = await this.git.run(["rev-parse", "--is-bare-repository"], { cwd: this.dir });
    if (bare.stdout.trim() !== "false") {
      throw new BlackboardCloneError(`Blackboard clone ${this.dir} must be non-bare`);
    }
    await this.git.run(["config", "remote.origin.url", this.remoteUrl], { cwd: this.dir });
    await this.git.run(["config", "--replace-all", "remote.origin.fetch", MAIN_REFSPEC], {
      cwd: this.dir,
    });
    await this.git.run(["config", "--add", "remote.origin.fetch", HEARTBEAT_REFSPEC], {
      cwd: this.dir,
    });
    await this.git.run(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: this.dir });
  }

  async fetch(): Promise<void> {
    await this.git.run(["fetch", "--prune", "origin", MAIN_REFSPEC, HEARTBEAT_REFSPEC], {
      cwd: this.dir,
    });
  }

  async resetToRemoteMain(): Promise<Sha> {
    // The clone is private (§7.1); discarded commits must never be rebased into the log (§7.2).
    await this.git.run(["reset", "--hard", "refs/remotes/origin/main"], { cwd: this.dir });
    const { stdout } = await this.git.run(["rev-parse", "--verify", "HEAD"], { cwd: this.dir });
    return ShaSchema.parse(stdout.trim());
  }
}
