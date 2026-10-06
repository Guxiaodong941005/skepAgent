import { z } from "zod";
import { type AgentId, DEVICE_RE, deviceOfAgent, heartbeatRef } from "../core/ids.js";
import { parsePrincipal } from "../core/principal.js";
import { AgentIdSchema, MAX_EVENT_BYTES, ShaSchema } from "../core/schemas/common.js";
import { type Heartbeat, HeartbeatSchema } from "../core/schemas/heartbeat.js";
import { writeSignedCommit } from "../git/commit.js";
import { GitError, type GitResult, type GitRunner } from "../git/runner.js";
import type { Signer } from "../git/signer.js";
import { verifyCommits } from "../git/verify.js";
import { type Clock, isoUtc } from "../util/clock.js";

export class HeartbeatError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HeartbeatError";
  }
}

export class DuplicateDaemonError extends HeartbeatError {
  readonly kind = "duplicate-daemon";

  constructor(
    readonly agent: AgentId,
    readonly bootId: string,
    readonly expectedOid: string,
    readonly actualOid: string,
    options?: ErrorOptions,
  ) {
    super(`Another daemon changed ${heartbeatRef(agent)}; stop the duplicate daemon`, options);
    this.name = "DuplicateDaemonError";
  }
}

export type HeartbeatDraft = Omit<Heartbeat, "schema" | "agent" | "boot_id" | "n" | "sent_at">;

interface WriterOptions {
  git: GitRunner;
  repoDir: string;
  agent: AgentId;
  signer: Signer;
  clock: Clock;
  bootId: string;
  onAlarm: (alarm: DuplicateDaemonError) => void;
}

export interface HeartbeatObservation {
  oid: string;
  hb: Heartbeat | null;
  problem: string | null;
}

const ObjectIdSchema = ShaSchema.refine((oid) => !oid.includes("\n"));
const SafeAgentIdSchema = AgentIdSchema.refine((agent) => !/[\r\n\0]/.test(agent));
const SafeBootIdSchema = HeartbeatSchema.shape.boot_id.refine((boot) => !/[\r\n\0]/.test(boot));
const DeviceSchema = z
  .string()
  .regex(DEVICE_RE)
  .refine((device) => !/[\r\n\0]/.test(device));
const DraftSchema = HeartbeatSchema.omit({
  schema: true,
  agent: true,
  boot_id: true,
  n: true,
  sent_at: true,
});
const FetchedPrefix = "refs/remotes/origin/hb/";
const LocalPrefix = "refs/heads/hb/";

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HeartbeatError(message, { cause: result.error });
  return result.data;
}

async function remoteOid(git: GitRunner, repoDir: string, ref: string): Promise<string> {
  const { stdout } = await git.run(["ls-remote", "--refs", "origin", ref], { cwd: repoDir });
  if (stdout === "") return "";
  const [oid] = parse(
    z.tuple([ObjectIdSchema, z.literal(ref)]),
    stdout.replace(/\n$/, "").split("\t"),
    `Cannot read the remote heartbeat ref ${ref}`,
  );
  return oid;
}

export class HeartbeatWriter {
  private readonly opts: WriterOptions;
  private lastOid: string | null = null;
  private n = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: WriterOptions) {
    const agent = parse(SafeAgentIdSchema, opts.agent, "Invalid heartbeat agent ID");
    parse(SafeBootIdSchema, opts.bootId, "Invalid heartbeat boot ID");
    const principal = parsePrincipal(opts.signer.principal);
    if (principal?.kind !== "daemon" || principal.device !== deviceOfAgent(agent)) {
      throw new HeartbeatError(`Heartbeat signer must be daemon:${deviceOfAgent(agent)}`);
    }
    this.opts = { ...opts, agent };
  }

  async beat(hb: HeartbeatDraft): Promise<void> {
    // Snapshot caller input before queueing; each failure still reaches its individual caller.
    const draft = parse(DraftSchema, hb, "Invalid heartbeat fields");
    const operation = this.queue.then(() => this.write(draft));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async write(draft: HeartbeatDraft): Promise<void> {
    const { git, repoDir, agent, signer, clock, bootId } = this.opts;
    try {
      const ref = heartbeatRef(agent);
      // A new boot adopts the existing remote tip once. Later beats must never adopt a rival tip
      // (ARCHITECTURE §8.1); this also allows a stopped daemon to restart without deleting its ref.
      if (this.lastOid === null) this.lastOid = await remoteOid(git, repoDir, ref);
      const now = clock.nowMs();
      const hb = parse(
        HeartbeatSchema,
        {
          ...draft,
          schema: "skep.hb/v1",
          agent,
          boot_id: bootId,
          n: ++this.n,
          sent_at: isoUtc(now),
        },
        "Cannot construct a valid heartbeat",
      );
      const blob = parse(
        ObjectIdSchema,
        (
          await git.run(["hash-object", "-t", "blob", "-w", "--stdin"], {
            cwd: repoDir,
            input: `${JSON.stringify(hb)}\n`,
          })
        ).stdout.trim(),
        "git returned an invalid heartbeat blob ID",
      );
      // Plumbing keeps the main ref, worktree and shared index entirely out of this write path.
      const tree = parse(
        ObjectIdSchema,
        (
          await git.run(["mktree"], {
            cwd: repoDir,
            input: `100644 blob ${blob}\thb.json\n`,
          })
        ).stdout.trim(),
        "git returned an invalid heartbeat tree ID",
      );
      const ident = {
        name: "Skep Daemon",
        email: "skepd@example.invalid",
        timestampSec: Math.floor(now / 1000),
        tz: "+0000",
      };
      const oid = await writeSignedCommit(git, repoDir, {
        tree,
        parents: [],
        author: ident,
        committer: ident,
        message: `Heartbeat ${agent} ${bootId} ${hb.n}\n`,
        signer,
      });
      await this.push(oid, ref, this.lastOid);
      this.lastOid = oid;
    } catch (error) {
      if (error instanceof HeartbeatError) throw error;
      throw new HeartbeatError(`Cannot publish heartbeat for ${agent}`, { cause: error });
    }
  }

  private async push(oid: string, ref: string, expected: string): Promise<void> {
    const { git, repoDir, agent, bootId, onAlarm } = this.opts;
    const args = [
      "push",
      "--porcelain",
      `--force-with-lease=${ref}:${expected}`,
      "origin",
      `${oid}:${ref}`,
    ];
    let result: GitResult | undefined;
    let failure: unknown;
    try {
      result = await git.run(args, { cwd: repoDir, allowFailure: true });
      if (result.code === 0) return;
      failure = new GitError(args, result.code, result.stderr);
    } catch (error) {
      failure = error;
    }
    // A lost acknowledgement must not look like a competing daemon on the next beat.
    let actual: string;
    try {
      actual = await remoteOid(git, repoDir, ref);
    } catch (error) {
      // A definite lease rejection is still a duplicate alarm if the remote goes offline before
      // reconciliation (ARCHITECTURE §8.1). Other failures supply no evidence of a rival writer.
      if (!result?.stdout.includes("(stale info)")) throw error;
      const alarm = new DuplicateDaemonError(agent, bootId, expected, "", { cause: error });
      onAlarm(alarm);
      throw alarm;
    }
    if (actual === oid) return;
    if (actual !== expected || result?.stdout.includes("(stale info)")) {
      const alarm = new DuplicateDaemonError(agent, bootId, expected, actual, { cause: failure });
      onAlarm(alarm);
      throw alarm;
    }
    throw new HeartbeatError(
      `Heartbeat push failed for ${agent}; retry after connectivity recovers`,
      {
        cause: failure,
      },
    );
  }
}

async function readHeartbeat(
  git: GitRunner,
  repoDir: string,
  trustPath: string,
  devices: Record<AgentId, string>,
  agent: AgentId,
  oid: string,
): Promise<Heartbeat> {
  parse(SafeAgentIdSchema, agent, "Heartbeat ref has an invalid agent ID");
  if (!Object.hasOwn(devices, agent)) {
    throw new HeartbeatError(`Heartbeat agent ${agent} is not registered`);
  }
  const check = (await verifyCommits(git, repoDir, trustPath, [oid]))[oid];
  if (check?.status !== "good") {
    throw new HeartbeatError(`Heartbeat signature is ${check?.status ?? "unavailable"}`);
  }
  const principal = parsePrincipal(check.principal);
  if (
    principal?.kind !== "daemon" ||
    principal.device !== devices[agent] ||
    principal.device !== deviceOfAgent(agent)
  ) {
    throw new HeartbeatError(`Heartbeat signer ${check.principal} does not own agent ${agent}`);
  }
  const object = await git.run(["--no-replace-objects", "cat-file", "commit", oid], {
    cwd: repoDir,
  });
  const headers = object.stdout.split("\n\n", 1)[0] ?? "";
  if (/^parent /m.test(headers)) throw new HeartbeatError("Heartbeat commit must be an orphan");
  const tree = await git.run(["--no-replace-objects", "ls-tree", "-z", oid], { cwd: repoDir });
  const match = /^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\thb\.json\0$/.exec(tree.stdout);
  if (!match?.[1]) throw new HeartbeatError("Heartbeat tree must contain only the hb.json blob");
  const blob = match[1];
  const size = await git.run(["--no-replace-objects", "cat-file", "-s", blob], { cwd: repoDir });
  const bytes = parse(
    z
      .string()
      .regex(/^(?:0|[1-9]\d*)$/)
      .transform(Number)
      .pipe(z.number().int().nonnegative().safe()),
    size.stdout.trim(),
    "git returned an invalid heartbeat blob size",
  );
  if (bytes > MAX_EVENT_BYTES) throw new HeartbeatError("Heartbeat exceeds the 64 KiB size limit");
  const content = await git.run(["--no-replace-objects", "cat-file", "blob", blob], {
    cwd: repoDir,
  });
  // GitRunner returns UTF-8 text; a lossy decode cannot validate the original signed bytes.
  if (Buffer.byteLength(content.stdout) !== bytes || content.stdout.includes("\uFFFD")) {
    throw new HeartbeatError("Heartbeat content is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(content.stdout);
  } catch (error) {
    throw new HeartbeatError("Heartbeat hb.json must contain valid JSON", { cause: error });
  }
  const hb = parse(HeartbeatSchema, value, "Heartbeat hb.json does not match skep.hb/v1");
  parse(SafeBootIdSchema, hb.boot_id, "Heartbeat has an invalid boot ID");
  if (hb.agent !== agent) throw new HeartbeatError("Heartbeat agent does not match its ref");
  return hb;
}

export async function readHeartbeats(
  git: GitRunner,
  repoDir: string,
  trustPath: string,
  devices: Record<AgentId, string>,
): Promise<Record<AgentId, HeartbeatObservation>> {
  parse(z.record(SafeAgentIdSchema, DeviceSchema), devices, "Invalid heartbeat device registry");
  try {
    const { stdout } = await git.run(
      ["for-each-ref", "--format=%(refname)%00%(objectname)", FetchedPrefix, LocalPrefix],
      { cwd: repoDir },
    );
    const refs = new Map<AgentId, string>();
    for (const line of stdout === "" ? [] : stdout.replace(/\n$/, "").split("\n")) {
      const [ref, oid] = parse(
        z.tuple([z.string(), ObjectIdSchema]),
        line.split("\0"),
        "git returned a malformed heartbeat ref record",
      );
      const fetched = ref.startsWith(FetchedPrefix);
      if (!fetched && !ref.startsWith(LocalPrefix)) {
        throw new HeartbeatError(`git returned an unexpected heartbeat ref ${ref}`);
      }
      const agent = ref.slice((fetched ? FetchedPrefix : LocalPrefix).length);
      // Fetched refs are authoritative in a clone; heads are useful in bare repositories.
      if (fetched || !refs.has(agent)) refs.set(agent, oid);
    }
    const observations: Record<AgentId, HeartbeatObservation> = {};
    for (const [agent, oid] of refs) {
      let observation: HeartbeatObservation;
      try {
        observation = {
          oid,
          hb: await readHeartbeat(git, repoDir, trustPath, devices, agent, oid),
          problem: null,
        };
      } catch (error) {
        observation = {
          oid,
          hb: null,
          problem: error instanceof Error ? error.message : "Cannot read heartbeat commit",
        };
      }
      Object.defineProperty(observations, agent, {
        value: observation,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return observations;
  } catch (error) {
    if (error instanceof HeartbeatError) throw error;
    throw new HeartbeatError("Cannot enumerate heartbeat refs; fetch the blackboard and retry", {
      cause: error,
    });
  }
}
