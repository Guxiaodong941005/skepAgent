import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonLock } from "./lock.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(process.cwd(), ".skep-lock-test-"));
  dirs.push(root);
  const path = join(root, "skepd.lock");
  return { path, identity: { pid: 101, startToken: "test-start", bootId: "b_0601" } };
}
describe("single-device daemon lock", () => {
  it("allows exactly one stale-lock successor when two daemons race", async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify({ ...f.identity, startToken: "old-start" }));
    const first = new DaemonLock({ ...f, isAlive: async (_pid, token) => token !== "old-start" });
    const second = new DaemonLock({
      ...f,
      identity: { ...f.identity, pid: 102 },
      isAlive: async (_pid, token) => token !== "old-start",
    });
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]?.status === "fulfilled" ? first : second;
    await winner.release();
  });
  it("uses exclusive creation with private permissions and rejects an alive holder", async () => {
    const f = await fixture();
    const lock = new DaemonLock({ ...f, isAlive: async () => true });
    await lock.acquire();
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    const rival = new DaemonLock({
      ...f,
      identity: { ...f.identity, pid: 102 },
      isAlive: async () => true,
    });
    await expect(rival.acquire()).rejects.toThrow("already holds");
    await lock.release();
    await rival.acquire();
    await rival.release();
  });
  it("recovers a stale PID/start-token lock and protects a successor on release", async () => {
    const f = await fixture();
    await writeFile(f.path, JSON.stringify({ ...f.identity, startToken: "old-start" }));
    const lock = new DaemonLock({ ...f, isAlive: async (_pid, token) => token === "test-start" });
    await lock.acquire();
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(f.identity);
    await writeFile(f.path, JSON.stringify({ ...f.identity, pid: 102 }));
    await expect(lock.release()).rejects.toThrow("ownership changed");
    expect(JSON.parse(await readFile(f.path, "utf8"))).toHaveProperty("pid", 102);
  });
  it("fails closed on an incomplete lock instead of deleting a live startup", async () => {
    const f = await fixture();
    await writeFile(f.path, "");
    await expect(new DaemonLock({ ...f, isAlive: async () => false }).acquire()).rejects.toThrow(
      "incomplete or invalid",
    );
  });
});
