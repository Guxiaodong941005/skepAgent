import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sha } from "../core/ids.js";
import type { FileChange, LogEntry, SignatureCheck } from "../core/log.js";
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
  z.enum(["blob", "tree", "commit", "tag"]),
  z
    .string()
    .regex(/^(?:0|[1-9]\d*)$/)
    .transform(Number)
    .pipe(z.number().int().nonnegative().safe()),
]);
const MAX_ARGV_BYTES = 64 * 1024;
const MAX_CONTENT_BATCH_BYTES = 8 * 1024 * 1024;

function objectIds(output: string): Sha[] {
  if (output === "") return [];
  const shas = z.array(ObjectIdSchema).parse(output.replace(/\n$/, "").split("\n"));
  if (new Set(shas).size !== shas.length) {
    throw new LogReadError("git rev-list returned duplicate commits");
  }
  return shas;
}

function batches(prefix: string[], shas: Sha[], maxBytes = MAX_ARGV_BYTES): Sha[][] {
  const baseBytes = prefix.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 4);
  const result: Sha[][] = [];
  let batch: Sha[] = [];
  let bytes = baseBytes;
  for (const sha of shas) {
    const size = Buffer.byteLength(sha) + 1;
    if (bytes + size >= maxBytes) {
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
  // Keep this format hex-only: hostile commit messages and identities need not be valid UTF-8.
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

interface SizedRequest extends AddedRequest {
  oid: Sha;
  size: number;
}

function unreadableRecordEnd(output: string, cursor: number, object: string): number | null {
  for (const status of ["missing", "ambiguous"]) {
    const record = `${object} ${status}\n`;
    if (output.startsWith(record, cursor)) return cursor + record.length;
  }
  return null;
}

async function checkAdded(
  git: GitRunner,
  repoDir: string,
  requests: AddedRequest[],
): Promise<SizedRequest[]> {
  const input = requests.map(({ entry, path }) => `${entry.sha}:${path}\0`).join("");
  // PRD §8.2 / src/core/log.ts: reject oversized blobs before the buffered runner reads any body.
  const { stdout } = await git.run(
    [
      "--no-replace-objects",
      "cat-file",
      "--batch-check=%(objectname) %(objecttype) %(objectsize)",
      "-z",
    ],
    { cwd: repoDir, input },
  );
  const readable: SizedRequest[] = [];
  let cursor = 0;
  for (const request of requests) {
    request.entry.added[request.path] = null;
    const unreadableEnd = unreadableRecordEnd(
      stdout,
      cursor,
      `${request.entry.sha}:${request.path}`,
    );
    if (unreadableEnd !== null) {
      cursor = unreadableEnd;
      continue;
    }
    const end = stdout.indexOf("\n", cursor);
    if (end < 0) throw new LogReadError("git cat-file returned a truncated size record");
    const [oid, type, size] = BatchHeaderSchema.parse(stdout.slice(cursor, end).split(" "));
    if (type === "blob" && size <= MAX_EVENT_BYTES) readable.push({ ...request, oid, size });
    cursor = end + 1;
  }
  if (cursor !== stdout.length) throw new LogReadError("git cat-file returned extra size records");
  return readable;
}

function contentBatches(requests: SizedRequest[]): SizedRequest[][] {
  const result: SizedRequest[][] = [];
  let batch: SizedRequest[] = [];
  let bytes = 0;
  for (const request of requests) {
    // Invalid bytes can expand threefold when Node decodes them as U+FFFD. Include header space
    // so many bounded files also stay below NodeGitRunner's 16 MiB stdout buffer.
    const size = request.size * 3 + 256;
    if (bytes + size > MAX_CONTENT_BATCH_BYTES) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(request);
    bytes += size;
  }
  if (batch.length > 0) result.push(batch);
  return result;
}

async function readContentBatch(
  git: GitRunner,
  repoDir: string,
  requests: SizedRequest[],
): Promise<void> {
  const input = requests.map(({ oid }) => `${oid}\0`).join("");
  // GitRunner decodes stdout before returning it. A commit-derived marker keeps batch frames
  // identifiable even when malformed UTF-8 changes their decoded byte lengths. Embedding this
  // marker in a blob would require a hash fixed point because its commit SHA depends on the blob.
  const marker = `skep-${createHash("sha256")
    .update(requests.map(({ entry, path }) => `${entry.sha}:${path}\0`).join(""))
    .digest("hex")} `;
  const { stdout } = await git.run(
    [
      "--no-replace-objects",
      "cat-file",
      `--batch=${marker}%(objectname) %(objecttype) %(objectsize)`,
      "-z",
    ],
    { cwd: repoDir, input },
  );
  let cursor = stdout.length;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  // Read backwards so an untrusted body containing the following object's "missing" record
  // cannot masquerade as a batch boundary. Marked headers depend on the commits themselves.
  for (let i = requests.length - 1; i >= 0; i--) {
    const request = requests[i];
    if (!request) throw new LogReadError("missing added-file request");
    let unreadableStart: number | null = null;
    for (const status of ["missing", "ambiguous"]) {
      const record = `${request.oid} ${status}\n`;
      const start = cursor - record.length;
      if (
        start >= 0 &&
        stdout.startsWith(record, start) &&
        (start === 0 || stdout[start - 1] === "\n")
      ) {
        unreadableStart = start;
        break;
      }
    }
    if (unreadableStart !== null) {
      cursor = unreadableStart;
      continue;
    }
    const headerStart = stdout.lastIndexOf(marker, cursor - 1);
    const headerEnd = stdout.indexOf("\n", headerStart);
    if (
      headerStart < 0 ||
      (headerStart > 0 && stdout[headerStart - 1] !== "\n") ||
      headerEnd < 0 ||
      headerEnd >= cursor
    ) {
      throw new LogReadError(`git cat-file omitted or malformed blob ${request.oid}`);
    }
    const [oid, type, size] = BatchHeaderSchema.parse(
      stdout.slice(headerStart + marker.length, headerEnd).split(" "),
    );
    if (oid !== request.oid || type !== "blob" || size !== request.size) {
      throw new LogReadError(`git cat-file changed metadata for blob ${request.oid}`);
    }
    const start = headerEnd + 1;
    const end = cursor - 1;
    if (end < start || stdout[end] !== "\n") {
      throw new LogReadError(`git cat-file returned a truncated blob for ${request.path}`);
    }
    let content: string | null = null;
    if (end - start <= MAX_EVENT_BYTES) {
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
    cursor = headerStart;
  }
  if (cursor !== 0) throw new LogReadError("git cat-file returned extra blob records");
}

async function readAdded(git: GitRunner, repoDir: string, requests: AddedRequest[]): Promise<void> {
  if (requests.length === 0) return;
  const readable = await checkAdded(git, repoDir, requests);
  for (const batch of contentBatches(readable)) await readContentBatch(git, repoDir, batch);
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
    const signatures: Record<Sha, SignatureCheck> = {};
    // Reserve room for verifyCommits' options/trust path without depending on its argv layout.
    for (const batch of batches([], shas, MAX_ARGV_BYTES - 4096)) {
      Object.assign(signatures, await verifyCommits(git, repoDir, trustRootPath, batch));
    }
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
          // Raw non-UTF-8 Git filenames are decoded lossily by GitRunner. Protocol paths are
          // ASCII; leave other paths opaque for the reducer's bad_event_path audit (PRD §8.2).
          change.path.split("").every((character) => character.charCodeAt(0) <= 0x7f) &&
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
