import { mkdir, open } from "node:fs/promises";
import { constants } from "node:os";
import path from "node:path";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../core/canonical.js";
import { type CheckRun, CheckRunSchema, RepoRefSchema, ShaSchema } from "../core/schemas/common.js";
import { CHECKS_FILE_PATH, type CheckDef, type ChecksFile } from "../core/schemas/config.js";
import type { GitRunner } from "../git/runner.js";
import { NativeRuntime } from "../runtime/native.js";
import type { ProcessHandle, RuntimeBackend } from "../runtime/types.js";
import type { Clock } from "../util/clock.js";
import { safeJoin } from "../util/fs.js";
import { cryptoRandom, type RandomSource } from "../util/random.js";
import { parseChecksFile } from "./checks-file.js";
import type { AttemptKey, Journal } from "./journal.js";
import { type AgentEnvOptions, type AgentUserIds, agentEnv } from "./sandbox-env.js";
import type { CodeMirror } from "./worktree.js";

const RunOptionsSchema = z.strictObject({
  repo: RepoRefSchema,
  baseCommit: ShaSchema,
  worktree: z
    .string()
    .min(1)
    .refine((value) => !value.includes("\0")),
  checks: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).max(32),
  attempt: z.strictObject({ task: z.string(), item: z.string(), epoch: z.number().int() }),
});

export interface ChecksRunnerOptions {
  git: GitRunner;
  mirror: Pick<CodeMirror, "mirrorPath">;
  journal: Pick<Journal, "append" | "path">;
  clock: Clock;
  env: AgentEnvOptions;
  agentUser?: AgentUserIds;
  runtime?: RuntimeBackend;
  random?: RandomSource;
}

export type RunChecksOptions = Omit<z.infer<typeof RunOptionsSchema>, "attempt"> & {
  attempt: AttemptKey;
};

export class ChecksError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChecksError";
  }
}

// Trusted config may add build variables, but cannot restore daemon credentials (§9.6, D19).
// Filtering is deliberately conservative: harmless names such as CACHE_KEY are stripped too.
const PRIVATE_ENV =
  /^(?:GIT_|SSH_|GH_|GITHUB_|OPENAI_|ANTHROPIC_|AZURE_|AWS_|GOOGLE_|GEMINI_|CODEX_|CLAUDE_|PI_CODING_)|(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|PROVIDER)(?:_|$)/;
const IDENTITY_ENV = new Set(["HOME", "USER", "LOGNAME"]);

function checkEnv(opts: AgentEnvOptions, extra: CheckDef["env"]): Record<string, string> {
  const env = agentEnv(opts);
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value.includes("\0")) throw new ChecksError("Check environment contains a NUL byte");
    if (!PRIVATE_ENV.test(name) && !IDENTITY_ENV.has(name)) env[name] = value;
  }
  for (const name of Object.keys(env)) if (PRIVATE_ENV.test(name)) delete env[name];
  return env;
}

/** ARCHITECTURE §9.6: callers fetch the mirror before resolving named checks at baseCommit. */
export class ChecksRunner {
  private readonly runtime: RuntimeBackend;
  private readonly random: RandomSource;

  constructor(private readonly opts: ChecksRunnerOptions) {
    this.runtime = opts.runtime ?? new NativeRuntime({ clock: opts.clock });
    this.random = opts.random ?? cryptoRandom;
  }

  async load(repo: string, baseCommit: string): Promise<ChecksFile> {
    if (!RepoRefSchema.safeParse(repo).success || !ShaSchema.safeParse(baseCommit).success) {
      throw new ChecksError("Trusted checks require an allowlisted repo and a pinned commit SHA");
    }
    const dir = await this.opts.mirror.mirrorPath(repo);
    const source = `${baseCommit}:${CHECKS_FILE_PATH}`;
    try {
      const commit = await this.opts.git.run(["cat-file", "-e", `${baseCommit}^{commit}`], {
        cwd: dir,
        allowFailure: true,
      });
      if (commit.code !== 0) {
        throw new ChecksError(
          `Base commit ${baseCommit} is unavailable in the mirror; fetch it first`,
        );
      }
      const result = await this.opts.git.run(["show", source], { cwd: dir, allowFailure: true });
      if (result.code !== 0) {
        throw new ChecksError(
          `Missing trusted checks at ${source}; merge a checks file at the plan base`,
        );
      }
      return parseChecksFile(result.stdout, source);
    } catch (error) {
      if (error instanceof ChecksError) throw error;
      throw new ChecksError(`Cannot load trusted checks at ${source}; merge a valid checks file`, {
        cause: error,
      });
    }
  }

  async run(options: RunChecksOptions): Promise<CheckRun[]> {
    const parsed = RunOptionsSchema.safeParse(options);
    if (!parsed.success) throw new ChecksError("Invalid trusted checks invocation");
    const opts = parsed.data;
    const journalPath = this.opts.journal.path(opts.attempt);
    const trusted = await this.load(opts.repo, opts.baseCommit);
    // Reject the entire selection before starting any command; a plan supplies names only.
    for (const name of opts.checks) {
      if (!Object.hasOwn(trusted.checks, name)) {
        throw new ChecksError(`Check ${name} is absent from the trusted base-commit checks file`);
      }
    }
    const logDir = path.join(path.dirname(journalPath), "checks");
    await mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    await safeJoin(path.dirname(journalPath), "checks");
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    const runs: CheckRun[] = [];
    for (const name of opts.checks) {
      const definition = trusted.checks[name];
      if (!definition) throw new ChecksError(`Missing trusted definition for ${name}`);
      const run = await this.runOne(opts, name, definition, logDir);
      runs.push(run);
    }
    await this.opts.journal.append(opts.attempt, {
      step: "checks",
      run_ids: runs.map((run) => run.run_id),
    });
    return runs;
  }

  private async runOne(
    opts: RunChecksOptions,
    name: string,
    definition: CheckDef,
    logDir: string,
  ): Promise<CheckRun> {
    if (definition.argv.some((arg) => arg.includes("\0"))) {
      throw new ChecksError(`Check ${name} argv contains a NUL byte`);
    }
    const env = checkEnv(this.opts.env, definition.env);
    const cwd = await safeJoin(opts.worktree, definition.cwd ?? "");
    const head = await this.opts.git.run(["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: opts.worktree,
    });
    const sha = ShaSchema.safeParse(head.stdout.trim());
    if (head.code !== 0 || !sha.success) {
      throw new ChecksError("Cannot identify the committed worktree HEAD before running checks");
    }
    const runId = `run_${Buffer.from(this.random.bytes(16)).toString("hex")}`;
    const logPath = await safeJoin(logDir, `${runId}.log`);
    // Exclusive creation prevents a repeated run id from appending to somebody else's evidence.
    const file = await open(logPath, "wx", 0o600);
    await file.close();
    const start = this.opts.clock.monotonicMs();
    const handle = await this.runtime.spawn({
      argv: definition.argv as [string, ...string[]],
      cwd,
      env,
      logPath,
      ...this.opts.agentUser,
    });
    await this.opts.journal
      .append(opts.attempt, {
        step: "check_started",
        run_id: runId,
        check: name,
        sha: sha.data,
        pid: handle.pid,
        pgid: handle.pgid,
        start_token: handle.startToken,
      })
      .catch(async (error: unknown) => {
        handle.signalGroup("SIGKILL");
        await handle.wait();
        throw new ChecksError("Cannot journal the running check; its process group was stopped", {
          cause: error,
        });
      });
    const { exit, timedOut } = await this.wait(handle, definition.timeout_sec * 1000);
    // Keep raw logs private and unchanged for evidence digests. SK-504 must use SK-506 to redact
    // every excerpt before publishing it or placing it in a fix-up prompt (D19, §16).
    const logFile = await open(logPath, "r");
    let log: Buffer;
    try {
      await logFile.sync();
      log = await logFile.readFile();
    } finally {
      await logFile.close();
    }
    // Match shell signal exits. A check can also exit 124 itself; journal.timed_out distinguishes it.
    const signalNumber =
      exit.signal === null
        ? undefined
        : constants.signals[exit.signal as keyof typeof constants.signals];
    const run = CheckRunSchema.parse({
      run_id: runId,
      check: name,
      sha: sha.data,
      exit: timedOut ? 124 : (exit.code ?? (signalNumber === undefined ? 1 : 128 + signalNumber)),
      duration_ms: Math.max(0, Math.round(this.opts.clock.monotonicMs() - start)),
      log_sha256: sha256Hex(log),
      ...parseCheckCounts(log.toString("utf8"), definition.parser),
    });
    await this.opts.journal.append(opts.attempt, {
      step: "check_run",
      ...run,
      argv_sha256: sha256Hex(canonicalJson(definition.argv)),
      timed_out: timedOut,
      signal: exit.signal,
    });
    return run;
  }

  private async wait(handle: ProcessHandle, timeoutMs: number) {
    const timeout = new AbortController();
    const completion = handle.wait();
    try {
      const exit = await Promise.race([
        completion,
        this.opts.clock.sleep(timeoutMs, timeout.signal).then(() => null),
      ]);
      if (exit !== null) return { exit, timedOut: false };
      // NativeRuntime.wait waits for the entire group, including children of an exited leader.
      handle.signalGroup("SIGKILL");
      return { exit: await completion, timedOut: true };
    } catch (error) {
      handle.signalGroup("SIGKILL");
      throw new ChecksError("Cannot supervise the trusted check; its process group was stopped", {
        cause: error,
      });
    } finally {
      timeout.abort();
    }
  }
}

const CountsSchema = z.strictObject({
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

/** Counts are optional metadata; unsupported/malformed output never invents test results. */
export function parseCheckCounts(
  log: string,
  parser: CheckDef["parser"],
): Pick<CheckRun, "passed" | "failed"> {
  if (parser === "none") return {};
  let counts: unknown;
  if (parser === "vitest-json") {
    try {
      const parsed: unknown = JSON.parse(log);
      const result = z
        .object({ numPassedTests: z.number(), numFailedTests: z.number() })
        .safeParse(parsed);
      if (result.success) {
        counts = { passed: result.data.numPassedTests, failed: result.data.numFailedTests };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return {};
    }
  } else if (parser === "tap") {
    // Nested TAP subtests are indented; only top-level test points count toward the plan.
    const points = log.split("\n").filter((line) => /^(?:not )?ok\b/.test(line));
    if (points.length > 0) {
      const failed = points.filter(
        (line) => /^not ok\b/.test(line) && !/#\s*(?:TODO|SKIP)\b/i.test(line),
      ).length;
      counts = { passed: points.length - failed, failed };
    }
  } else {
    // No XML parser dependency: read suite counters only, without expanding entities/DTDs.
    const suites = [...log.matchAll(/<testsuite\b([^>]*)>/g)];
    let passed = 0;
    let failed = 0;
    for (const suite of suites) {
      const attrs = Object.fromEntries(
        [
          ...(suite[1] ?? "").matchAll(/\b(tests|failures|errors|skipped)\s*=\s*["'](\d+)["']/g),
        ].map((match) => [match[1], Number(match[2])]),
      );
      if (attrs.tests === undefined) return {};
      const failures = (attrs.failures ?? 0) + (attrs.errors ?? 0);
      failed += failures;
      passed += attrs.tests - failures - (attrs.skipped ?? 0);
    }
    if (suites.length > 0) counts = { passed, failed };
  }
  const parsed = CountsSchema.safeParse(counts);
  return parsed.success ? parsed.data : {};
}
