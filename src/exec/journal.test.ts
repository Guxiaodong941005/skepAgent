import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { Journal, JournalError, TERMINAL_STEPS } from "./journal.js";

const TASK_A = "T-20261005-aa01";
const TASK_B = "T-20261005-bb02";

function clockAt(monoMs: number, wallMs: number): FakeClock {
  const vt = new VirtualTime(monoMs);
  return new FakeClock(vt, { wallStartMs: wallMs });
}

describe("Journal", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function roleDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "skep-journal-"));
    dirs.push(dir);
    return dir;
  }

  it("appends fsynced JSONL stamped by the injected clock and reads it back in order (AC 4)", async () => {
    const dir = await roleDir();
    const vt = new VirtualTime(1_000);
    const clock = new FakeClock(vt, { wallStartMs: Date.UTC(2026, 9, 5, 9, 14, 3) });
    const journal = new Journal({ roleDir: dir, clock });
    const key = { task: TASK_A, item: "W1", epoch: 1 };

    const first = await journal.append(key, { step: "claimed" });
    await vt.advance(5_000);
    const second = await journal.append(key, { step: "invoked", pid: 7 });

    expect(first).toEqual({ step: "claimed", ts_mono: 0, ts_wall: "2026-10-05T09:14:03Z" });
    expect(second.ts_mono).toBe(5_000);
    expect(second.ts_wall).toBe("2026-10-05T09:14:08Z");

    const raw = await readFile(journal.path(key), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n").filter((line) => line !== "")).toHaveLength(2);
    expect(await journal.read(key)).toEqual([first, second]);
  });

  it("ignores a torn last line and lets the next append start on a fresh line", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, Date.UTC(2026, 0, 1)) });
    const key = { task: TASK_A, item: "W1", epoch: 2 };

    await journal.append(key, { step: "claimed", note: "café" });
    const file = journal.path(key);
    const intact = await readFile(file, "utf8");
    await writeFile(file, `${intact}{"step":"invo`);

    expect(await journal.read(key)).toEqual([expect.objectContaining({ step: "claimed" })]);

    await journal.append(key, { step: "worktree_created" });
    const after = await readFile(file, "utf8");
    const lines = after.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).step)).toEqual(["claimed", "worktree_created"]);
    expect(after.endsWith("\n")).toBe(true);
  });

  it("throws a typed error naming file and line for a corrupt middle record", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, Date.UTC(2026, 0, 1)) });
    const key = { task: TASK_A, item: "W2", epoch: 1 };

    await journal.append(key, { step: "claimed" });
    await journal.append(key, { step: "invoked" });
    const file = journal.path(key);
    const [first, second] = (await readFile(file, "utf8")).split("\n");
    await writeFile(file, `${first}\n{not json\n${second}\n`);

    const error = await journal.read(key).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JournalError);
    const journalError = error as JournalError;
    expect(journalError.file).toBe(file);
    expect(journalError.line).toBe(2);
    expect(journalError.message).toContain(`${file}:2:`);
  });

  it("lists exactly the attempts whose last step is non-terminal, sorted (AC 5)", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, Date.UTC(2026, 0, 1)) });

    const finished = { task: TASK_B, item: "W1", epoch: 1 };
    const open = { task: TASK_A, item: "W2", epoch: 3 };
    const earlier = { task: TASK_A, item: "W2", epoch: 1 };
    const other = { task: TASK_A, item: "W1", epoch: 1 };

    await journal.append(finished, { step: "claimed" });
    await journal.append(finished, { step: "delivered_published", seq: 4 });
    await journal.append(open, { step: "invoked", pid: 1 });
    await journal.append(earlier, { step: "checks" });
    await journal.append(other, { step: "failed", class: "crash" });

    expect(await journal.unfinishedAttempts()).toEqual([earlier, open]);
  });

  it("treats every terminal step as finished and ignores empty files", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, Date.UTC(2026, 0, 1)) });

    for (const step of TERMINAL_STEPS) {
      await journal.append(
        { task: TASK_A, item: "W1", epoch: TERMINAL_STEPS.indexOf(step) + 1 },
        {
          step,
        },
      );
    }
    expect(await journal.unfinishedAttempts()).toEqual([]);
  });

  it("returns an empty list when the journal directory is missing", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, 0) });
    expect(await journal.unfinishedAttempts()).toEqual([]);
    expect(await journal.read({ task: TASK_A, item: "W1", epoch: 1 })).toEqual([]);
  });

  it("places the journal under <roleDir>/.skep/journal/<task>/<item>-e<epoch>.jsonl", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, 0) });
    const key = { task: TASK_A, item: "W3", epoch: 4 };
    expect(journal.path(key)).toBe(path.join(dir, ".skep", "journal", TASK_A, "W3-e4.jsonl"));
  });
});
