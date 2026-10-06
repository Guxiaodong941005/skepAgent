import { type FileHandle, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const LockSchema = z.strictObject({
  pid: z.number().int().positive(),
  startToken: z.string().min(1),
  bootId: z.string().regex(/^b_[0-9a-f]{4,32}$/),
});
export interface LockIdentity {
  pid: number;
  startToken: string;
  bootId: string;
}
export class DaemonLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DaemonLockError";
  }
}

/** Exclusive create plus PID/start token guards against PID reuse (ARCHITECTURE §3). */
export class DaemonLock {
  private identity: LockIdentity | null = null;
  constructor(
    private readonly options: {
      path: string;
      identity: LockIdentity;
      isAlive(pid: number, token: string): Promise<boolean>;
    },
  ) {}
  async acquire(): Promise<void> {
    if (this.identity) throw new DaemonLockError("This daemon already holds its lock");
    const identity = LockSchema.parse(this.options.identity);
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const file = await open(this.options.path, "wx", 0o600);
        try {
          await file.writeFile(`${JSON.stringify(identity)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        this.identity = identity;
        return;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST")
          throw new DaemonLockError("Cannot create daemon lock", { cause });
      }
      const reclaimPath = `${this.options.path}.reclaim`;
      let reclaim: FileHandle;
      try {
        reclaim = await open(reclaimPath, "wx", 0o600);
      } catch (cause) {
        throw new DaemonLockError(
          "Another daemon is checking the stale lock; retry after it finishes",
          { cause },
        );
      }
      try {
        const stat = await lstat(this.options.path);
        if (!stat.isFile())
          throw new DaemonLockError(
            "Daemon lock must be a regular file; inspect it before restarting",
          );
        let previous: LockIdentity;
        try {
          previous = LockSchema.parse(JSON.parse(await readFile(this.options.path, "utf8")));
        } catch (cause) {
          throw new DaemonLockError(
            "Daemon lock is incomplete or invalid; inspect it before restarting",
            { cause },
          );
        }
        if (await this.options.isAlive(previous.pid, previous.startToken))
          throw new DaemonLockError(`Daemon ${previous.pid} already holds the device lock`);
        // Recheck inode before removing a stale lock; never remove a successor's lock.
        const current = await lstat(this.options.path);
        if (current.ino !== stat.ino || current.dev !== stat.dev) continue;
        await unlink(this.options.path);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      } finally {
        await reclaim.close();
        await unlink(reclaimPath);
      }
    }
    throw new DaemonLockError("Daemon lock changed repeatedly; stop competing daemons and retry");
  }
  async release(): Promise<void> {
    if (!this.identity) return;
    const previous = LockSchema.parse(JSON.parse(await readFile(this.options.path, "utf8")));
    if (JSON.stringify(previous) !== JSON.stringify(this.identity))
      throw new DaemonLockError(
        "Daemon lock ownership changed; refusing to remove another daemon's lock",
      );
    await unlink(this.options.path);
    this.identity = null;
  }
}
