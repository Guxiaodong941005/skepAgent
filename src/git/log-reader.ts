import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sha } from "../core/ids.js";
import type { FileChange, LogEntry } from "../core/log.js";
import { MAX_EVENT_BYTES, ShaSchema } from "../core/schemas/common.js";
import { GENESIS_PATH } from "../core/schemas/genesis.js";
import type { GitRunner } from "./runner.js";
import { verifyCommits } from "./verify.js";

export interface ReadLogOptions {
  ref?: string;
  from?: { sha: Sha; seq: number };
}

export class LogReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LogReadError";
  }
}

const ObjectIdSchema = ShaSchema.refine((sha) => !sha.includes("\n"));
const OptionsSchema = z.strictObject({
  ref: z
    .string()
    .min(1)
    .refine((ref) => !ref.startsWith("-") && !/[\0\r\n]/.test(ref))
    .default("refs/heads/main"),
  from: z
    .strictObject({
      sha: ObjectIdSchema,
      seq: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER - 1),
    })
    .optional(),
});
const ParentRecordSchema = z.tuple([ObjectIdSchema, z.string()]);
const StatusSchema = z.string().regex(/^[A-Z](?:\d+)?$/);
// Git paths can contain LF, tabs and backslashes; protocol path validation belongs to the reducer.
const GitPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.includes("\0"));
const BatchHeaderSchema = z.tuple([
  ObjectIdSchema,
  z.literal("blob"),
  z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
]);
const MAX_ARGV_BYTES = 64 * 1024;

function objectIds(output: string): Sha[] {
  if (output === "") return [];
  const shas = z.array(ObjectIdSchema).parse(output.replace(/\n$/, "").split("\n"));
  if (new Set(shas).size !== shas.length) {
    throw new LogReadError("git rev-list returned duplicate commits");
  }
  return shas;
}

function batches(prefix: string[], shas: Sha[]): Sha[][] {
  const baseBytes = prefix.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 4);
  const result: Sha[][] = [];
  let batch: Sha[] = [];
  let bytes = baseBytes;
  for (const sha of shas) {
    const size = Buffer.byteLength(sha) + 1;
    if (bytes + size >= MAX_ARGV_BYTES) {
      if (batch.length === 0) throw new LogReadError("git arguments exceed the 64 KiB limit");
      result.push(batch);
      batch = [];
      bytes = baseBytes;
    }
    batch.push(sha);
    bytes += size;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

async function readParents(
  git: GitRunner,
  repoDir: string,
  shas: Sha[],
): Promise<Record<Sha, Sha[]>> {
  const prefix = [
    "--no-replace-objects",
    "log",
    "--no-walk=unsorted",
    "--no-show-signature",
    "--no-color",
    "--no-decorate",
    "--no-notes",
    "--no-patch",
    "--format=%H%x00%P",
  ];
  const parents: Record<Sha, Sha[]> = {};
  const requested = new Set(shas);
  for (const batch of batches(prefix, shas)) {
    const { stdout } = await git.run([...prefix, ...batch, "--"], { cwd: repoDir });
    for (const line of stdout.replace(/\n$/, "").split("\n")) {
      const [sha, parentList] = ParentRecordSchema.parse(line.split("\0"));
      if (!requested.has(sha) || Object.hasOwn(parents, sha)) {
        throw new LogReadError(`git log returned an unexpected or duplicate commit ${sha}`);
      }
      parents[sha] = z.array(ObjectIdSchema).parse(parentList === "" ? [] : parentList.split(" "));
    }
  }
  for (const sha of shas) {
    if (!Object.hasOwn(parents, sha)) throw new LogReadError(`git log omitted commit ${sha}`);
  }
  return parents;
}

function changes(output: string): FileChange[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new LogReadError("git diff-tree returned a truncated diff");
  const fields = output.slice(0, -1).split("\0");
  const result: FileChange[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    const status = StatusSchema.parse(fields[i]);
    let path = GitPathSchema.parse(fields[i + 1]);
    if (status.startsWith("R") || status.startsWith("C")) {
      // --no-renames disables these records; still consume both paths if a runner supplies one.
      path = GitPathSchema.parse(fields[i + 2]);
      i += 1;
    }
    result.push({
      status:
        status === "A" || status === "M" || status === "D" || status === "T" ? status : "other",
      path,
    });
  }
  return result;
}

interface AddedRequest {
  entry: LogEntry;
  path: string;
}

async function readAdded(git: GitRunner, repoDir: string, requests: AddedRequest[]): Promise<void> {
  if (requests.length === 0) return;
  const input = requests.map(({ entry, path }) => `${entry.sha}:${path}\0`).join("");
  // GitRunner decodes stdout before returning it. A commit-derived marker keeps batch frames
  // identifiable even when malformed UTF-8 changes their decoded byte lengths.
  const marker = `skep-${createHash("sha256").update(input).digest("hex")} `;
  const { stdout } = await git.run(
    [
      "--no-replace-objects",
      "cat-file",
      `--batch=${marker}%(objectname) %(objecttype) %(objectsize)`,
      "-z",
    ],
    { cwd: repoDir, input },
  );
  let cursor = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    if (!request) throw new LogReadError("missing added-file request");
    const headerEnd = stdout.indexOf("\n", cursor);
    if (!stdout.startsWith(marker, cursor) || headerEnd < 0) {
      throw new LogReadError(
        `git cat-file omitted or malformed ${request.entry.sha}:${request.path}`,
      );
    }
    const [oid, , size] = BatchHeaderSchema.parse(
      stdout.slice(cursor + marker.length, headerEnd).split(" "),
    );
    const start = headerEnd + 1;
    const next = stdout.indexOf(`\n${marker}`, start);
    if (i + 1 === requests.length && next >= 0) {
      throw new LogReadError("git cat-file returned extra blob records");
    }
    const end = i + 1 === requests.length ? stdout.length - 1 : next;
    if (end < start || stdout[end] !== "\n") {
      throw new LogReadError(`git cat-file returned a truncated blob for ${request.path}`);
    }
    let content: string | null = null;
    // src/core/log.ts: only bounded event/genesis content is materialized. GitRunner itself
    // buffers stdout; enforcing a streaming read cap requires a binary/streaming runner contract.
    if (size <= MAX_EVENT_BYTES && end - start <= MAX_EVENT_BYTES) {
      const text = stdout.slice(start, end);
      // A blob hash detects lossy decoding, including invalid sequences replaced by U+FFFD
      // without a byte-length change; valid literal U+FFFD remains readable (ARCHITECTURE §5.3).
      if (Buffer.byteLength(text, "utf8") === size) {
        const bytes = Buffer.from(text, "utf8");
        const digest = createHash(oid.length === 40 ? "sha1" : "sha256")
          .update(`blob ${size}\0`)
          .update(bytes)
          .digest("hex");
        if (digest === oid) content = decoder.decode(bytes);
      }
    }
    request.entry.added[request.path] = content;
    cursor = end + 1;
  }
  if (cursor !== stdout.length) throw new LogReadError("git cat-file returned extra blob records");
}

export async function readLog(
  git: GitRunner,
  repoDir: string,
  trustRootPath: string,
  opts: ReadLogOptions = {},
): Promise<LogEntry[]> {
  try {
    const { ref, from } = OptionsSchema.parse(opts);
    // PRD §8.3: walk the complete first-parent chain so an ancestor on a merged side branch
    // cannot masquerade as a cached main tip. All subsequent reads use this immutable snapshot.
    const { stdout } = await git.run(
      [
        "--no-replace-objects",
        "rev-list",
        "--first-parent",
        "--reverse",
        "--end-of-options",
        ref,
        "--",
      ],
      { cwd: repoDir },
    );
    const chain = objectIds(stdout);
    const tip = chain.at(-1);
    if (!tip) throw new LogReadError(`no commits found at ${ref}`);
    let start = 0;
    if (from) {
      const ancestry = await git.run(
        ["--no-replace-objects", "merge-base", "--is-ancestor", from.sha, tip],
        { cwd: repoDir, allowFailure: true },
      );
      const index = chain.indexOf(from.sha);
      if (ancestry.code !== 0 || index < 0) {
        throw new LogReadError(
          `cached commit ${from.sha} is not on the first-parent chain of ${ref}; read the full log after a history rewrite`,
        );
      }
      if (from.seq !== index) {
        throw new LogReadError(
          `cached seq ${from.seq} does not match first-parent index ${index} for ${from.sha}`,
        );
      }
      start = index + 1;
    }
    const shas = chain.slice(start);
    if (shas.length === 0) return [];
    const parentLists = await readParents(git, repoDir, shas);
    // Keep verifyCommits' trust-root enforcement while bounding its argv for long histories.
    const signatureGit: GitRunner = {
      async run(args, options) {
        const prefix = args.slice(0, args.length - shas.length - 1);
        const outputs = [];
        for (const batch of batches(prefix, shas)) {
          outputs.push(await git.run([...prefix, ...batch, "--"], options));
        }
        return {
          code: 0,
          stdout: outputs.map((output) => output.stdout).join(""),
          stderr: outputs.map((output) => output.stderr).join(""),
        };
      },
    };
    const signatures = await verifyCommits(signatureGit, repoDir, trustRootPath, shas);
    const entries: LogEntry[] = [];
    const requests: AddedRequest[] = [];
    for (const [i, sha] of shas.entries()) {
      const seq = start + i;
      const parents = parentLists[sha];
      const signature = signatures[sha];
      if (!parents || !signature) throw new LogReadError(`missing commit metadata for ${sha}`);
      const { stdout: diff } = await git.run(
        [
          "--no-replace-objects",
          "diff-tree",
          "-r",
          "-z",
          "--no-renames",
          "--no-ext-diff",
          "--no-textconv",
          "--no-commit-id",
          "--name-status",
          ...(parents[0] ? [parents[0], sha] : ["--root", sha]),
          "--",
        ],
        { cwd: repoDir },
      );
      const entry: LogEntry = { seq, sha, parents, signature, changes: changes(diff), added: {} };
      entries.push(entry);
      for (const change of entry.changes) {
        if (
          change.status === "A" &&
          (change.path.startsWith("events/") || (seq === 0 && change.path === GENESIS_PATH))
        ) {
          requests.push({ entry, path: change.path });
        }
      }
    }
    await readAdded(git, repoDir, requests);
    return entries;
  } catch (error) {
    if (error instanceof LogReadError) throw error;
    throw new LogReadError(
      `Cannot read blackboard log in ${repoDir}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
