import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readlink, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

/**
 * Filesystem helpers for daemon state (ARCHITECTURE §2 `util/fs.ts`).
 *
 * `atomicWrite` publishes a complete file or leaves the previous one: readers never observe a
 * partial target. `appendFsync` makes a journal line durable before the call resolves, which is
 * what restart reconciliation relies on (PRD §10.6). `safeJoin` is the path boundary for anything
 * derived from model output or an event payload (PRD §11.5).
 */

export class PathEscapeError extends Error {
  constructor(
    readonly root: string,
    readonly rel: string,
    reason: string,
  ) {
    super(`path escapes ${root}: ${reason}`);
    this.name = "PathEscapeError";
  }
}

/** Opens `dir`, fsyncs it and closes it. A rename is only durable once its directory entry is. */
async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Best-effort removal of a temp file we created; the original error is the one to surface. */
async function removeQuietly(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => undefined);
}

/**
 * Writes `data` to `target` atomically: temp file in the same directory, fsync, rename over the
 * target, then fsync the directory. A crash at any point leaves either the old content or the new
 * content, never a partial file, and the temp file does not survive a successful write.
 */
export async function atomicWrite(
  target: string,
  data: string | Uint8Array,
  opts?: { mode?: number },
): Promise<void> {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(tmp, "w", opts?.mode ?? 0o666);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeQuietly(tmp);
    throw error;
  }
  await handle.close();
  try {
    await rename(tmp, target);
  } catch (error) {
    await removeQuietly(tmp);
    throw error;
  }
  await fsyncDirectory(dir);
}

/**
 * Appends `data` to `file`, creating parent directories, then fsyncs before resolving. Used by the
 * run journal so a record is on disk before the next step runs (ARCHITECTURE §11.3).
 */
export async function appendFsync(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "a");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const NUL = "\0";

/**
 * Resolves `rel` inside `root` and rejects anything that could leave it: absolute paths, `..`
 * segments, NUL bytes, and a symlink whose deepest existing ancestor realpaths outside `root`.
 * Segments that do not exist yet are accepted, so a caller can create them afterwards.
 */
export async function safeJoin(root: string, rel: string): Promise<string> {
  if (rel.includes(NUL)) {
    throw new PathEscapeError(root, rel, "path contains a NUL byte");
  }
  if (path.isAbsolute(rel)) {
    throw new PathEscapeError(root, rel, "absolute paths are not allowed");
  }
  // Reject `..` before normalizing: `a/../../x` would otherwise collapse into a path that looks
  // merely absolute-or-not, hiding the traversal.
  if (rel.split(/[\\/]/).some((segment) => segment === "..")) {
    throw new PathEscapeError(root, rel, "`..` segments are not allowed");
  }

  const rootReal = await realpath(root);
  const candidate = path.resolve(rootReal, rel);

  // Walk up to the deepest component that already exists. A symlink there is the escape hatch
  // segment checks cannot see; anything below it does not exist yet, so it cannot point outside.
  // `realpath` reports ENOENT for a dangling symlink too, so a link is treated as existing and
  // then resolved — otherwise `link/file` would walk straight past the link that leaves root.
  const pending: string[] = [];
  let existing = candidate;
  for (;;) {
    const info = await lstat(existing).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info) break;
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new PathEscapeError(root, rel, "no existing ancestor inside root");
    }
    pending.push(path.basename(existing));
    existing = parent;
  }

  let existingReal: string;
  try {
    existingReal = await realpath(existing);
  } catch (error) {
    // A dangling symlink has no canonical target. Its lexical target is enough to see an escape;
    // one that stays inside root is fine, since the caller may create the missing target later.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const target = await readlink(existing);
    // Relative link text is relative to the link's own directory, so resolve it from the real
    // parent: a symlink directory above it must not hide where the target actually lands.
    const base = path.isAbsolute(target) ? "/" : await realpath(path.dirname(existing));
    existingReal = path.resolve(base, target);
  }
  if (escapes(rootReal, existingReal)) {
    throw new PathEscapeError(root, rel, "symlink resolves outside root");
  }
  return path.join(existingReal, ...pending.reverse());
}

/** True when `candidate` is not `root` and not a path beneath it. */
function escapes(root: string, candidate: string): boolean {
  const fromRoot = path.relative(root, candidate);
  return fromRoot !== "" && (fromRoot.startsWith("..") || path.isAbsolute(fromRoot));
}
