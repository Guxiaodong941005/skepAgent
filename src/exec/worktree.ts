import { chmod, chown, lchown, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { RelPathSchema, RepoRefSchema, ShaSchema } from "../core/schemas/common.js";
import { type DeviceConfig, DeviceConfigSchema } from "../core/schemas/config.js";
import type { GitResult, GitRunner } from "../git/runner.js";
import { safeJoin } from "../util/fs.js";
import type { AgentUserIds } from "./sandbox-env.js";

// Local attempt branches must survive fetch/prune while their worktrees are active (§7.5).
const FETCH_REFSPECS = ["+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"] as const;
const AgentUserIdsSchema = z.strictObject({
  uid: z.number().int().min(0).max(4_294_967_294),
  gid: z.number().int().min(0).max(4_294_967_294),
});
const CreateWorktreeOptionsSchema = z.strictObject({
  repo: RepoRefSchema,
  baseSha: ShaSchema,
  branch: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => !/[\0\r\n]/.test(value)),
  path: RelPathSchema,
});
const RemoveWorktreeOptionsSchema = z.strictObject({
  repo: RepoRefSchema,
  path: RelPathSchema,
  force: z.boolean().optional(),
});

export interface CodeMirrorOptions {
  git: GitRunner;
  home: string;
  repos: DeviceConfig["repos"];
  /** Trusted root, normally <roleDir>/.skep/worktrees. Attempt paths are relative to it. */
  worktreeRoot: string;
  /** Daemon-only Git environment; never use agentEnv here (PRD §11.4). */
  env?: Record<string, string>;
  /** Optional resolved local identity; only checkout content is handed to this user. */
  agentUser?: AgentUserIds;
}

export type CreateWorktreeOptions = z.infer<typeof CreateWorktreeOptionsSchema>;
export type RemoveWorktreeOptions = z.infer<typeof RemoveWorktreeOptionsSchema>;

export interface AttemptWorktree {
  repo: string;
  mirrorDir: string;
  path: string;
  branch: string;
  baseSha: string;
}

export class CodeMirrorError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodeMirrorError";
  }
}

function repoKey(ref: string): string {
  // Match config/device.ts's allowlist lookup, including .git and trailing slash aliases.
  return ref.replace(/\/+$/, "").replace(/\.git$/i, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** One daemon-owned bare mirror per locally allowlisted repository (PRD §11.5). */
export class CodeMirror {
  readonly home: string;
  readonly worktreeRoot: string;
  private readonly git: GitRunner;
  private readonly repos: DeviceConfig["repos"];
  private readonly env?: Record<string, string>;
  private readonly agentUser?: AgentUserIds;

  constructor(opts: CodeMirrorOptions) {
    const repos = DeviceConfigSchema.shape.repos.safeParse(opts.repos);
    if (!repos.success) throw new CodeMirrorError("Invalid local repository allowlist");
    const names = new Set<string>();
    const urls = new Set<string>();
    for (const repo of repos.data) {
      if (/[\0\r\n]/.test(repo.url) || repo.url.startsWith("-")) {
        throw new CodeMirrorError(`Invalid remote URL for allowlisted repository ${repo.name}`);
      }
      if (names.has(repo.name) || urls.has(repoKey(repo.url))) {
        throw new CodeMirrorError("Repository allowlist must have unique names and remote URLs");
      }
      names.add(repo.name);
      urls.add(repoKey(repo.url));
    }
    if (!opts.home || !opts.worktreeRoot || /\0/.test(opts.home + opts.worktreeRoot)) {
      throw new CodeMirrorError("Mirror home and worktree root must be nonempty local paths");
    }
    const agentUser = AgentUserIdsSchema.optional().safeParse(opts.agentUser);
    if (!agentUser.success)
      throw new CodeMirrorError("Agent identity must contain a valid uid and gid");
    this.git = opts.git;
    this.home = resolve(opts.home);
    this.worktreeRoot = resolve(opts.worktreeRoot);
    this.repos = repos.data;
    this.env = opts.env === undefined ? undefined : { ...opts.env };
    this.agentUser = agentUser.data;
  }

  private allowedRepo(ref: string): DeviceConfig["repos"][number] {
    if (!RepoRefSchema.safeParse(ref).success) {
      throw new CodeMirrorError("Invalid repository reference");
    }
    const repo =
      this.repos.find((entry) => entry.name === ref) ??
      this.repos.find((entry) => repoKey(entry.url) === repoKey(ref));
    if (!repo) throw new CodeMirrorError("Repository is not in the device's local allowlist");
    return repo;
  }

  private async run(dir: string, args: string[], allowFailure = false): Promise<GitResult> {
    return this.git.run(["--git-dir", dir, "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: dir,
      env: this.env,
      allowFailure,
    });
  }

  async mirrorPath(repo: string): Promise<string> {
    const entry = this.allowedRepo(repo);
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    return safeJoin(this.home, `mirrors/${entry.name}.git`);
  }

  async init(repo: string): Promise<string> {
    const entry = this.allowedRepo(repo);
    const dir = await this.mirrorPath(entry.name);
    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    await chmod(dirname(dir), 0o700);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    if (await exists(await safeJoin(dir, ".git"))) {
      throw new CodeMirrorError(`Mirror ${entry.name} must be a bare repository`);
    }
    if (await exists(await safeJoin(dir, "HEAD"))) {
      const bare = await this.run(dir, ["rev-parse", "--is-bare-repository"], true);
      if (bare.code !== 0 || bare.stdout.trim() !== "true") {
        throw new CodeMirrorError(`Mirror ${entry.name} must be a valid bare repository`);
      }
    }
    await this.git.run(["-c", "core.hooksPath=/dev/null", "init", "--bare", dir], {
      cwd: this.home,
      env: this.env,
    });
    await this.run(dir, ["config", "core.hooksPath", "/dev/null"]);
    await this.run(dir, ["config", "remote.origin.url", entry.url]);
    await this.run(dir, ["config", "--replace-all", "remote.origin.fetch", FETCH_REFSPECS[0]]);
    await this.run(dir, ["config", "--add", "remote.origin.fetch", FETCH_REFSPECS[1]]);
    return dir;
  }

  async fetch(repo: string): Promise<string> {
    const dir = await this.init(repo);
    // The destination comes only from the local allowlist, never from a task or model output.
    await this.run(dir, ["fetch", "--prune", "origin", ...FETCH_REFSPECS]);
    return dir;
  }

  private async attemptPath(path: string): Promise<string> {
    await mkdir(this.worktreeRoot, { recursive: true, mode: 0o755 });
    const result = await safeJoin(this.worktreeRoot, path);
    if (relative(await realpath(this.worktreeRoot), result) === "") {
      throw new CodeMirrorError("An attempt path must be below the worktree root");
    }
    return result;
  }

  private async handOffCheckout(target: string, user: AgentUserIds): Promise<void> {
    const handOff = async (path: string): Promise<void> => {
      const info = await lstat(path);
      // Tracked symlinks may leave the checkout. Change the link owner, never its target (§11.5).
      if (info.isSymbolicLink()) {
        await lchown(path, user.uid, user.gid);
      } else {
        if (info.isDirectory()) {
          for (const name of await readdir(path)) await handOff(join(path, name));
        }
        await chown(path, user.uid, user.gid);
      }
    };
    try {
      for (const name of await readdir(target)) {
        if (name !== ".git") await handOff(join(target, name));
      }
      // A daemon-owned sticky root lets the agent create files but not replace the .git pointer.
      // Parents stay daemon-owned, so the agent cannot rename the checkout root either (§11.4).
      await chown(target, -1, user.gid);
      await chmod(target, 0o1770);
    } catch (error) {
      throw new CodeMirrorError(
        "Cannot hand off checkout files to the agent user; check the daemon's ownership permissions",
        { cause: error },
      );
    }
  }

  async createWorktree(opts: CreateWorktreeOptions): Promise<AttemptWorktree> {
    const parsed = CreateWorktreeOptionsSchema.safeParse(opts);
    if (!parsed.success) throw new CodeMirrorError("Invalid worktree creation options");
    const { repo, baseSha, branch, path } = parsed.data;
    const entry = this.allowedRepo(repo);
    const target = await this.attemptPath(path);
    if (await exists(target)) {
      throw new CodeMirrorError(
        "Attempt worktree path already exists; choose a fresh attempt path",
      );
    }
    const dir = await this.fetch(entry.name);
    const validBranch = await this.run(dir, ["check-ref-format", `refs/heads/${branch}`], true);
    if (branch.startsWith("-") || branch === "HEAD" || validBranch.code !== 0) {
      throw new CodeMirrorError("Attempt branch must be a valid, non-option Git branch name");
    }
    const existing = await this.run(dir, ["show-ref", "--verify", `refs/heads/${branch}`], true);
    if (existing.code === 0) {
      throw new CodeMirrorError("Attempt branch already exists; choose a fresh attempt branch");
    }
    const object = await this.run(dir, ["cat-file", "-t", baseSha], true);
    if (object.code !== 0 || object.stdout.trim() !== "commit") {
      throw new CodeMirrorError(
        "Worktree base SHA must identify a fetched commit in this repository",
      );
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await this.run(dir, ["worktree", "add", "-b", branch, "--", target, baseSha]);
    // PRD §11.4: do not chown the .git pointer or mirror metadata to the agent user.
    await chmod(await safeJoin(target, ".git"), 0o600);
    const adminRoot = await safeJoin(dir, "worktrees");
    await chmod(adminRoot, 0o700);
    if (this.agentUser !== undefined) await this.handOffCheckout(target, this.agentUser);
    return { repo: entry.name, mirrorDir: dir, path: target, branch, baseSha };
  }

  async removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
    const parsed = RemoveWorktreeOptionsSchema.safeParse(opts);
    if (!parsed.success) throw new CodeMirrorError("Invalid worktree removal options");
    const { repo, path, force } = parsed.data;
    this.allowedRepo(repo);
    const target = await this.attemptPath(path);
    const dir = await this.mirrorPath(repo);
    // Preserve dirty attempts by default. Only an explicit daemon decision discards their files.
    await this.run(dir, ["worktree", "remove", ...(force ? ["--force"] : []), "--", target]);
  }
}
