import { execFile } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  input?: string | Uint8Array;
  env?: Record<string, string>;
  timeoutMs?: number;
  allowFailure?: boolean;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunner {
  run(args: string[], opts: GitRunOptions): Promise<GitResult>;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number,
    readonly stderr: string,
    options?: ErrorOptions,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`, options);
    this.name = "GitError";
  }
}

export class NodeGitRunner implements GitRunner {
  run(args: string[], opts: GitRunOptions): Promise<GitResult> {
    const env: Record<string, string> = {};
    // PRD §11.4: ambient GIT_* and credential variables must not influence daemon writes.
    for (const name of ["PATH", "HOME", "SSH_AUTH_SOCK", "TMPDIR"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    Object.assign(env, opts.env, { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });

    return new Promise((resolve, reject) => {
      const child = execFile(
        "git",
        args,
        {
          cwd: opts.cwd,
          env,
          shell: false,
          encoding: "utf8",
          timeout: opts.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          if (error && (typeof error.code !== "number" || !opts.allowFailure)) {
            reject(new GitError([...args], code, stderr || error.message, { cause: error }));
          } else {
            resolve({ code, stdout, stderr });
          }
        },
      );
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        // A command that exits before reading stdin reports its actual failure in the callback.
        if (error.code !== "EPIPE") {
          reject(new GitError([...args], -1, error.message, { cause: error }));
        }
      });
      child.stdin?.end(opts.input);
    });
  }
}
