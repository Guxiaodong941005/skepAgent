/**
 * What a session item changed in the peer's project folder (docs/plans/session-ux-rethink.md
 * §2.2, §3.3). The agent edits the real working tree, so there is no branch to diff against:
 * a snapshot is taken before the run and compared with the tree after it.
 *
 * The tree may already be dirty. Nothing here ever stashes, resets or cleans; only files whose
 * content changed during the run are reported, and those that were already modified before are
 * annotated. The before content of every changed file is recorded under the project's session
 * state so `skep session undo` can put it back (Phase 3).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../../util/fs.js";

/**
 * `null` hash: the path does not exist. `content` is null when it was not kept (size cap) and for
 * a symlink, whose target is `link` instead: undo recreates the link, never writes through it.
 */
export interface FileState {
  hash: string | null;
  content: Buffer | null;
  link?: string;
}

export interface TreeSnapshot {
  root: string;
  git: boolean;
  /** HEAD before the run; null outside Git or on an unborn branch. */
  head: string | null;
  /** Git: the files that were dirty before the run. Otherwise: every file walked. */
  files: Map<string, FileState>;
  /** A non-Git walk stopped at {@link MAX_WALK_FILES}; later files are not compared. */
  partial: boolean;
}

export interface DeltaFile {
  path: string;
  before: FileState;
  after: FileState;
  /** It already differed from HEAD before the run (Git) — the user had edited it. */
  wasDirty: boolean;
  /** Line counts; null for binary or unrecorded content. */
  added: number | null;
  removed: number | null;
}

export interface ItemDelta {
  files: DeltaFile[];
  partial: boolean;
}

/** Runs git in `cwd` and returns stdout; throws on failure. */
export type GitRun = (args: string[], cwd: string) => Promise<string>;

export interface SnapshotIo {
  git: GitRun;
  /** Variables for the binary-safe `git cat-file` (PATH, HOME). */
  env: Record<string, string>;
  /** Absolute paths never reported (Skep's own home when it lies inside the project). */
  exclude: readonly string[];
}

/** Bounds for a project that is not a Git checkout, which is walked in full. */
export const MAX_WALK_FILES = 20_000;
const MAX_KEPT_BYTES = 64 * 1024 * 1024;
const WALK_SKIP = new Set([".git", "node_modules"]);
/** Files listed by name in the result line; the rest are counted. */
const MAX_LISTED = 12;

export class DeltaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeltaError";
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A symlink is identified by its target text, never by what it points to. */
function linkHash(link: string): string {
  return sha256(Buffer.from(`symlink:${link}`, "utf8"));
}

const ABSENT: FileState = { hash: null, content: null };

/** A regular file's bytes, a symlink's target, or absent. Directories count as absent. */
async function readState(file: string): Promise<FileState> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
    if ((error as NodeJS.ErrnoException).code === "ENOTDIR") return ABSENT;
    throw error;
  }
  if (info.isSymbolicLink()) {
    const link = await readlink(file);
    return { hash: linkHash(link), content: null, link };
  }
  if (!info.isFile()) return ABSENT;
  const content = await readFile(file);
  return { hash: sha256(content), content };
}

function excluded(root: string, rel: string, exclude: readonly string[]): boolean {
  const abs = path.join(root, rel);
  return exclude.some((dir) => abs === dir || abs.startsWith(`${dir}${path.sep}`));
}

/** Paths in `git status --porcelain=v1 -z` output, both sides of a rename or copy. */
export function parsePorcelain(output: string): string[] {
  const paths: string[] = [];
  const tokens = output.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token.length < 4) continue;
    const status = token.slice(0, 2);
    paths.push(token.slice(3));
    // A rename or copy is followed by its source path as the next token.
    if (status[0] === "R" || status[0] === "C") {
      const source = tokens[i + 1];
      if (source !== undefined && source !== "") paths.push(source);
      i += 1;
    }
  }
  return paths;
}

async function gitTop(io: SnapshotIo, dir: string): Promise<boolean> {
  return io.git(["rev-parse", "--is-inside-work-tree"], dir).then(
    (out) => out.trim() === "true",
    () => false,
  );
}

async function headOf(io: SnapshotIo, root: string): Promise<string | null> {
  return io.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root).then(
    (out) => out.trim() || null,
    () => null,
  );
}

async function dirtyPaths(io: SnapshotIo, root: string): Promise<string[]> {
  const out = await io.git(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"],
    root,
  );
  return parsePorcelain(out).filter((rel) => !excluded(root, rel, io.exclude));
}

/**
 * One path of `rev`, byte-exact (execFileChecked decodes to text). Absent when not in `rev`. A
 * committed symlink (mode 120000) is a link state, so undo recreates the link (R1).
 */
async function blobAt(io: SnapshotIo, root: string, rev: string, rel: string): Promise<FileState> {
  const entry = await io.git(["ls-tree", "-z", rev, "--", rel], root);
  const state = await rawBlobAt(io, root, rev, rel);
  if (entry.startsWith("120000 ") && state.content !== null) {
    const link = state.content.toString("utf8");
    return { hash: linkHash(link), content: null, link };
  }
  return state;
}

function rawBlobAt(io: SnapshotIo, root: string, rev: string, rel: string): Promise<FileState> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["cat-file", "blob", `${rev}:${rel}`],
      {
        cwd: root,
        env: io.env,
        shell: false,
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error === null) {
          resolve({ hash: sha256(stdout), content: stdout });
          return;
        }
        // 128: the path is not in that commit (a new file). Anything else is a real failure.
        if (typeof error.code === "number" && error.code === 128) resolve(ABSENT);
        else reject(new DeltaError(`git cat-file ${rev}:${rel}: ${error.message}`));
      },
    );
  });
}

async function walk(root: string, exclude: readonly string[]): Promise<TreeSnapshot> {
  const files = new Map<string, FileState>();
  let kept = 0;
  let partial = false;
  const visit = async (rel: string): Promise<void> => {
    if (partial) return;
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (WALK_SKIP.has(entry.name) || excluded(root, child, exclude)) continue;
      if (entry.isDirectory()) {
        await visit(child);
      } else {
        if (files.size >= MAX_WALK_FILES) {
          partial = true;
          return;
        }
        const state = await readState(path.join(root, child));
        if (state.hash === null) continue;
        // Content is kept for undo and line counts only up to a budget; hashes always.
        if (state.content !== null && kept + state.content.length > MAX_KEPT_BYTES) {
          files.set(child, { hash: state.hash, content: null });
        } else {
          kept += state.content?.length ?? 0;
          files.set(child, state);
        }
      }
    }
  };
  await visit("");
  return { root, git: false, head: null, files, partial };
}

/** The state of `root` before an agent runs in it. */
export async function snapshotTree(root: string, io: SnapshotIo): Promise<TreeSnapshot> {
  if (!(await gitTop(io, root))) return walk(root, io.exclude);
  const head = await headOf(io, root);
  const files = new Map<string, FileState>();
  for (const rel of await dirtyPaths(io, root)) {
    files.set(rel, await readState(path.join(root, rel)));
  }
  return { root, git: true, head, files, partial: false };
}

/** Files whose content changed since `before`, sorted by path. */
export async function computeDelta(before: TreeSnapshot, io: SnapshotIo): Promise<ItemDelta> {
  const { root } = before;
  const out: DeltaFile[] = [];
  if (!before.git) {
    const after = await walk(root, io.exclude);
    const keys = new Set([...before.files.keys(), ...after.files.keys()]);
    for (const rel of keys) {
      const was = before.files.get(rel) ?? ABSENT;
      const now = after.files.get(rel) ?? ABSENT;
      if (was.hash !== now.hash) out.push(deltaFile(rel, was, now, false));
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return { files: out, partial: before.partial || after.partial };
  }
  const head = await headOf(io, root);
  const candidates = new Set([...before.files.keys(), ...(await dirtyPaths(io, root))]);
  // An agent that committed moved HEAD: its committed files are clean now but did change.
  if (head !== null && head !== before.head) {
    const listed =
      before.head === null
        ? await io.git(["ls-tree", "-r", "-z", "--name-only", head], root)
        : await io.git(["diff", "--name-only", "-z", "--no-renames", before.head, head], root);
    for (const rel of listed.split("\0")) {
      if (rel !== "" && !excluded(root, rel, io.exclude)) candidates.add(rel);
    }
  }
  for (const rel of candidates) {
    const known = before.files.get(rel);
    const was = known ?? (before.head === null ? ABSENT : await blobAt(io, root, before.head, rel));
    const now = await readState(path.join(root, rel));
    if (was.hash !== now.hash) out.push(deltaFile(rel, was, now, known !== undefined));
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return { files: out, partial: false };
}

function deltaFile(rel: string, before: FileState, after: FileState, wasDirty: boolean): DeltaFile {
  const stat = lineStat(before, after);
  return {
    path: rel,
    before,
    after,
    wasDirty,
    added: stat?.added ?? null,
    removed: stat?.removed ?? null,
  };
}

function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8_000).includes(0);
}

function lines(data: Buffer | null): string[] {
  if (data === null || data.length === 0) return [];
  const text = data.toString("utf8");
  const split = text.split("\n");
  if (split.at(-1) === "") split.pop();
  return split;
}

/**
 * Added and removed lines, counted as a multiset difference. It equals `git diff --numstat`
 * for ordinary edits and only differs for moved lines, which is enough for a diffstat.
 */
export function lineStat(
  before: FileState,
  after: FileState,
): { added: number; removed: number } | null {
  if (before.hash !== null && before.content === null) return null;
  if (after.hash !== null && after.content === null) return null;
  if (before.content !== null && isBinary(before.content)) return null;
  if (after.content !== null && isBinary(after.content)) return null;
  const counts = new Map<string, number>();
  for (const line of lines(before.content)) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(after.content)) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

/** `(+41 −7)` over the files with line counts. */
export function diffstat(files: readonly Pick<DeltaFile, "added" | "removed">[]): string {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.added ?? 0;
    removed += file.removed ?? 0;
  }
  return `(+${added} −${removed})`;
}

/**
 * The result line the master shows: `changed 3 files (+41 −7): a, b (was already modified), c`
 * or `no changes`. Long lists end with `+N more`.
 */
export function changedLine(delta: ItemDelta): string {
  const partial = delta.partial ? ` (only the first ${MAX_WALK_FILES} files were compared)` : "";
  if (delta.files.length === 0) return `no changes${partial}`;
  const count = delta.files.length;
  const names = delta.files.slice(0, MAX_LISTED).map((file) => {
    const gone = file.after.hash === null ? " (deleted)" : "";
    const dirty = file.wasDirty ? " (was already modified)" : "";
    return `${file.path}${gone}${dirty}`;
  });
  const more = count > MAX_LISTED ? `, +${count - MAX_LISTED} more` : "";
  const noun = count === 1 ? "file" : "files";
  return `changed ${count} ${noun} ${diffstat(delta.files)}: ${names.join(", ")}${more}${partial}`;
}

// ---------------------------------------------------------------------------------------------
// The recorded delta: `<home>/session/deltas/<itemId>/` holds `delta.json` and the before content
// of each changed file. Item ids restart in every session, so the latest run of an id wins: every
// run writes its record when it starts, so a later run that changes nothing, is declined or fails
// early leaves an empty record and can never select an earlier session's files (R2).

const HashSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .nullable();

export const DeltaRecordSchema = z.strictObject({
  schema: z.literal("skep.session-delta/v1"),
  itemId: z.string().regex(/^I-\d+$/),
  epoch: z.number().int().min(1),
  title: z.string().max(200),
  /** The session the run belonged to; null when unknown (a record from before R2). */
  sessionId: z.string().min(1).nullable().optional(),
  root: z.string().min(1),
  recordedAtMs: z.number().int().nonnegative(),
  /** HEAD after the item ran; null outside Git or on an unborn branch. */
  head: z.string().nullable(),
  undoneAtMs: z.number().int().nonnegative().optional(),
  files: z.array(
    z.strictObject({
      path: z.string().min(1),
      before: HashSchema,
      after: HashSchema,
      /** Symlink targets: a link is restored as a link, never written through (R1). */
      beforeLink: z.string().min(1).optional(),
      afterLink: z.string().min(1).optional(),
      /** False when the before content was too large to keep: undo cannot restore it. */
      restorable: z.boolean(),
      wasDirty: z.boolean(),
      added: z.number().int().nonnegative().nullable(),
      removed: z.number().int().nonnegative().nullable(),
    }),
  ),
});
export type DeltaRecord = z.infer<typeof DeltaRecordSchema>;

export function deltaDir(home: string, itemId: string): string {
  return path.join(home, "session", "deltas", itemId);
}

/** Replaces any earlier record of `itemId` with this run's delta. */
export async function writeDeltaRecord(
  home: string,
  meta: {
    itemId: string;
    epoch: number;
    title: string;
    sessionId: string | null;
    root: string;
    head: string | null;
  },
  delta: ItemDelta,
  nowMs: number,
): Promise<DeltaRecord> {
  const dir = deltaDir(home, meta.itemId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, "blobs"), { recursive: true, mode: 0o700 });
  const files: DeltaRecord["files"] = [];
  for (const file of delta.files) {
    const restorable =
      file.before.hash === null || file.before.content !== null || file.before.link !== undefined;
    if (file.before.hash !== null && file.before.content !== null) {
      await writeFile(path.join(dir, "blobs", file.before.hash), file.before.content, {
        mode: 0o600,
      });
    }
    files.push({
      path: file.path,
      before: file.before.hash,
      after: file.after.hash,
      ...(file.before.link === undefined ? {} : { beforeLink: file.before.link }),
      ...(file.after.link === undefined ? {} : { afterLink: file.after.link }),
      restorable,
      wasDirty: file.wasDirty,
      added: file.added,
      removed: file.removed,
    });
  }
  const record: DeltaRecord = {
    schema: "skep.session-delta/v1",
    ...meta,
    recordedAtMs: nowMs,
    files,
  };
  await atomicWrite(path.join(dir, "delta.json"), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return record;
}

/** The recorded delta of `itemId`, or null when this project has none. */
export async function readDeltaRecord(home: string, itemId: string): Promise<DeltaRecord | null> {
  const file = path.join(deltaDir(home, itemId), "delta.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new DeltaError(`${file} is not valid JSON`, { cause: error });
  }
  const parsed = DeltaRecordSchema.safeParse(json);
  if (!parsed.success) throw new DeltaError(`${file} is malformed: ${parsed.error.message}`);
  return parsed.data;
}

export class UndoRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndoRefusedError";
  }
}

/** Who ran a record: `I-1 (session s-1)`, or just the id for a record without a session. */
export function runLabel(record: DeltaRecord): string {
  const session = record.sessionId ?? null;
  return session === null ? record.itemId : `${record.itemId} (session ${session})`;
}

/**
 * The directory entry `rel` names under `root`, without following it. Every existing parent must
 * be a plain directory (never a symlink), so a restore or removal acts on exactly the recorded
 * entry and on nothing a link points to (R1). Missing parents are created on restore.
 */
export async function entryPath(root: string, rel: string): Promise<string> {
  const parts = rel.split("/");
  if (
    rel.includes("\0") ||
    path.isAbsolute(rel) ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new UndoRefusedError(
      `refusing the recorded path ${JSON.stringify(rel)}: not a plain path`,
    );
  }
  let at = await realpath(root);
  for (const [index, part] of parts.slice(0, -1).entries()) {
    at = path.join(at, part);
    const info = await lstat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info === null) break;
    if (!info.isDirectory()) {
      const parent = parts.slice(0, index + 1).join("/");
      throw new UndoRefusedError(
        `${parent} (a parent of ${rel}) is no longer a plain directory; ` +
          "move it out of the way and try again. Nothing was changed",
      );
    }
  }
  return path.join(at, parts.at(-1) ?? "");
}

/** The entry's state without following a leaf symlink; a directory or special file throws. */
async function entryState(target: string, rel: string): Promise<FileState> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info !== null && !info.isFile() && !info.isSymbolicLink()) {
    throw new UndoRefusedError(
      `${rel} is now a directory or special file; skep only restores files and links. ` +
        "Nothing was changed",
    );
  }
  return readState(target);
}

/**
 * The recorded files whose working-tree entry no longer has the content the item left (a later
 * item or a human changed it). A deferred submit refuses these: it would commit or publish
 * content the item never produced (R3).
 */
export async function driftedFiles(record: DeltaRecord): Promise<string[]> {
  const drifted: string[] = [];
  for (const file of record.files) {
    const now = await entryState(await entryPath(record.root, file.path), file.path).catch(
      () => null,
    );
    if (now === null || now.hash !== file.after) drifted.push(file.path);
  }
  return drifted;
}

export interface UndoOutcome {
  record: DeltaRecord;
  restored: string[];
  removed: string[];
  /** Files changed again after the item and overwritten anyway (`force`). */
  overwritten: string[];
}

/**
 * Puts every file of the item back to its content from before the run. Refuses, changing
 * nothing, when a file was modified again after the item (unless `force`), when a before
 * content was not kept, when the latest run of the id changed nothing, or when it was already
 * undone. Only recorded entries are touched; a symlink is removed or recreated as a link.
 */
export async function undoDelta(
  home: string,
  itemId: string,
  opts: { force?: boolean; nowMs: number },
): Promise<UndoOutcome> {
  const record = await readDeltaRecord(home, itemId);
  if (record === null) {
    throw new UndoRefusedError(
      `no recorded changes for ${itemId} in this project (${deltaDir(home, itemId)}); ` +
        "run undo from the folder the item ran in",
    );
  }
  if (record.undoneAtMs !== undefined) {
    throw new UndoRefusedError(`${runLabel(record)} was already undone; nothing changed`);
  }
  if (record.files.length === 0) {
    throw new UndoRefusedError(
      `the latest run of ${runLabel(record)} changed no files; there is nothing to undo. ` +
        `Earlier runs of ${itemId} cannot be undone by skep; use git or your editor`,
    );
  }
  const dir = deltaDir(home, itemId);
  const plan: {
    rel: string;
    target: string;
    before: string | null;
    beforeLink: string | undefined;
    exists: boolean;
    drifted: boolean;
  }[] = [];
  const lost: string[] = [];
  for (const file of record.files) {
    const target = await entryPath(record.root, file.path);
    const now = await entryState(target, file.path);
    if (!file.restorable || (file.before !== null && !(await restorable(dir, file)))) {
      lost.push(file.path);
    }
    plan.push({
      rel: file.path,
      target,
      before: file.before,
      beforeLink: file.beforeLink,
      exists: now.hash !== null,
      drifted: now.hash !== file.after,
    });
  }
  if (lost.length > 0) {
    throw new UndoRefusedError(
      `cannot undo ${runLabel(record)}: the earlier content of ${lost.join(", ")} was too large to keep ` +
        "or is damaged; restore it with git or your editor. Nothing was changed",
    );
  }
  const drifted = plan.filter((entry) => entry.drifted).map((entry) => entry.rel);
  if (drifted.length > 0 && opts.force !== true) {
    throw new UndoRefusedError(
      `cannot undo ${runLabel(record)}: ${drifted.join(", ")} changed again after the item. ` +
        `Nothing was changed; pass --force to overwrite them with their content from before ${itemId}`,
    );
  }
  const outcome: UndoOutcome = { record, restored: [], removed: [], overwritten: drifted };
  for (const entry of plan) {
    // unlink removes the entry itself: a symlink goes, the file it points to stays.
    const clear = async (): Promise<void> => {
      if (!entry.exists) return;
      await unlink(entry.target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    };
    if (entry.before === null) {
      await clear();
      outcome.removed.push(entry.rel);
      continue;
    }
    await mkdir(path.dirname(entry.target), { recursive: true });
    if (entry.beforeLink !== undefined) {
      await clear();
      await symlink(entry.beforeLink, entry.target);
      outcome.restored.push(entry.rel);
      continue;
    }
    const content = await readFile(path.join(dir, "blobs", entry.before));
    if (sha256(content) !== entry.before) {
      throw new DeltaError(`the recorded content of ${entry.rel} is damaged (${dir})`);
    }
    // Writing to an existing link would change its target's content instead of the entry.
    const info = await lstat(entry.target).catch(() => null);
    if (info?.isSymbolicLink() === true) await clear();
    await writeFile(entry.target, content);
    outcome.restored.push(entry.rel);
  }
  await atomicWrite(
    path.join(dir, "delta.json"),
    `${JSON.stringify({ ...record, undoneAtMs: opts.nowMs }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return outcome;
}

/** A recorded before state undo can put back: a link target, or an intact kept blob. */
async function restorable(dir: string, file: DeltaRecord["files"][number]): Promise<boolean> {
  if (file.beforeLink !== undefined) return linkHash(file.beforeLink) === file.before;
  const content = await readFile(path.join(dir, "blobs", file.before ?? "")).catch(() => null);
  return content !== null && sha256(content) === file.before;
}
