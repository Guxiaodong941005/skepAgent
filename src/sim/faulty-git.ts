import { GitError, type GitResult, type GitRunner, type GitRunOptions } from "../git/runner.js";
import type { Clock } from "../util/clock.js";
import type { Rng } from "./rng.js";

export type GitCommand = "fetch" | "push" | "ls-remote" | "local";
export type CompetingPush = (git: GitRunner, args: string[], opts: GitRunOptions) => Promise<void>;

export type GitFault =
  | { kind: "failed-fetch" }
  | { kind: "competing-push"; push: CompetingPush }
  | { kind: "lost-ack" }
  | { kind: "delay"; ms: number }
  | { kind: "partition"; ms?: number };

export interface FaultRule {
  command?: GitCommand;
  /** One-based occurrence of this command; omitted rules apply to its next occurrence. */
  occurrence?: number;
  fault: GitFault;
}

export interface SeededFaults {
  rng: Rng;
  fetchFailureRate?: number;
  competingPushRate?: number;
  competingPush?: CompetingPush;
  lostAckRate?: number;
  delayRate?: number;
  delayMs?: number;
  partitionRate?: number;
  partitionMs?: number;
}

export class FaultConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaultConfigurationError";
  }
}

function duration(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new FaultConfigurationError("Fault duration must be a non-negative finite number");
  }
}

function commandOf(args: readonly string[]): GitCommand {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "-C") {
      i++;
    } else if (arg && !arg.startsWith("-")) {
      return arg === "fetch" || arg === "push" || arg === "ls-remote" ? arg : "local";
    }
  }
  return "local";
}

/** Network faults affect availability, never local verification or trust (D18, §13.1). */
export class FaultyGitRunner implements GitRunner {
  readonly history: { command: GitCommand; occurrence: number; kind: GitFault["kind"] }[] = [];
  private readonly script: FaultRule[] = [];
  private readonly counts: Record<GitCommand, number> = {
    fetch: 0,
    push: 0,
    "ls-remote": 0,
    local: 0,
  };
  private partitionUntil: number | null = null;

  constructor(
    private readonly deps: {
      git: GitRunner;
      clock: Clock;
      script?: FaultRule[];
      seeded?: SeededFaults;
    },
  ) {
    for (const rule of deps.script ?? []) this.inject(rule);
    for (const [name, value] of Object.entries(deps.seeded ?? {})) {
      if (
        name.endsWith("Rate") &&
        (typeof value !== "number" || value < 0 || value > 1 || !Number.isFinite(value))
      ) {
        throw new FaultConfigurationError(`${name} must be a probability between zero and one`);
      }
    }
    if (deps.seeded?.delayMs !== undefined) duration(deps.seeded.delayMs);
    if (deps.seeded?.partitionMs !== undefined) duration(deps.seeded.partitionMs);
    if (deps.seeded?.competingPushRate && !deps.seeded.competingPush) {
      throw new FaultConfigurationError("Seeded competing pushes require a competingPush callback");
    }
  }

  inject(rule: FaultRule): void {
    if (
      rule.occurrence !== undefined &&
      (!Number.isSafeInteger(rule.occurrence) || rule.occurrence < 1)
    ) {
      throw new FaultConfigurationError("Fault occurrence must be a positive safe integer");
    }
    if (rule.fault.kind === "delay") duration(rule.fault.ms);
    if (rule.fault.kind === "partition" && rule.fault.ms !== undefined) duration(rule.fault.ms);
    const command =
      rule.command ??
      (rule.fault.kind === "failed-fetch"
        ? "fetch"
        : rule.fault.kind === "competing-push" || rule.fault.kind === "lost-ack"
          ? "push"
          : undefined);
    this.script.push({ ...rule, command, fault: { ...rule.fault } });
  }

  setPartitioned(partitioned: boolean): void {
    this.partitionUntil = partitioned ? Number.POSITIVE_INFINITY : null;
  }

  async run(args: string[], opts: GitRunOptions): Promise<GitResult> {
    const command = commandOf(args);
    const occurrence = ++this.counts[command];
    if (command !== "local" && this.partitionUntil !== null) {
      if (this.deps.clock.monotonicMs() < this.partitionUntil) {
        return this.failure(args, opts, "Simulated partition: remote is unreachable");
      }
      this.partitionUntil = null;
    }
    const index = this.script.findIndex(
      (rule) =>
        (rule.command === undefined || rule.command === command) &&
        (rule.fault.kind !== "partition" || command !== "local") &&
        (rule.occurrence === undefined || rule.occurrence === occurrence),
    );
    const fault = index >= 0 ? this.script.splice(index, 1)[0]?.fault : this.seededFault(command);
    if (fault) {
      this.history.push({ command, occurrence, kind: fault.kind });
      switch (fault.kind) {
        case "failed-fetch":
          if (command !== "fetch")
            throw new FaultConfigurationError("failed-fetch must target fetch");
          return this.failure(args, opts, "Simulated fetch failure: retry the remote observation");
        case "competing-push":
          if (command !== "push")
            throw new FaultConfigurationError("competing-push must target push");
          // The rival really pushes; real git decides whether our pending commit is non-ff (§7.2).
          await fault.push(this.deps.git, [...args], opts);
          break;
        case "lost-ack": {
          if (command !== "push") throw new FaultConfigurationError("lost-ack must target push");
          const result = await this.deps.git.run(args, opts);
          if (result.code !== 0) return result;
          return this.failure(
            args,
            opts,
            "Simulated lost push acknowledgement: connection reset",
            -1,
          );
        }
        case "delay":
          await this.deps.clock.sleep(fault.ms);
          break;
        case "partition":
          if (command === "local")
            throw new FaultConfigurationError("partition must target a remote command");
          this.partitionUntil =
            fault.ms === undefined
              ? Number.POSITIVE_INFINITY
              : this.deps.clock.monotonicMs() + fault.ms;
          return this.failure(args, opts, "Simulated partition: remote is unreachable");
      }
    }
    // A partition may start while a delayed command is asleep.
    if (
      command !== "local" &&
      this.partitionUntil !== null &&
      this.deps.clock.monotonicMs() < this.partitionUntil
    ) {
      return this.failure(args, opts, "Simulated partition: remote is unreachable");
    }
    return this.deps.git.run(args, opts);
  }

  private failure(args: string[], opts: GitRunOptions, stderr: string, code = 1): GitResult {
    if (!opts.allowFailure) throw new GitError([...args], code, stderr);
    return { code, stdout: "", stderr };
  }

  private seededFault(command: GitCommand): GitFault | undefined {
    const seeded = this.deps.seeded;
    if (!seeded || command === "local") return undefined;
    if (seeded.rng.chance(seeded.partitionRate ?? 0)) {
      return { kind: "partition", ms: seeded.partitionMs ?? 1_000 };
    }
    if (command === "fetch" && seeded.rng.chance(seeded.fetchFailureRate ?? 0))
      return { kind: "failed-fetch" };
    if (
      command === "push" &&
      seeded.competingPush &&
      seeded.rng.chance(seeded.competingPushRate ?? 0)
    ) {
      return { kind: "competing-push", push: seeded.competingPush };
    }
    if (command === "push" && seeded.rng.chance(seeded.lostAckRate ?? 0))
      return { kind: "lost-ack" };
    if (seeded.rng.chance(seeded.delayRate ?? 0))
      return { kind: "delay", ms: seeded.delayMs ?? 1_000 };
    return undefined;
  }
}
