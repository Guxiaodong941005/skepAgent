import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import {
  type AttemptKey,
  Journal,
  JournalError,
  TERMINAL_STEPS,
  verificationKey,
} from "./journal.js";
import { findSecrets, Redactor } from "./redact.js";

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

  it("treats every terminal step as finished and ignores an empty file", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, Date.UTC(2026, 0, 1)) });

    for (const step of TERMINAL_STEPS) {
      await journal.append(
        { task: TASK_A, item: "W1", epoch: TERMINAL_STEPS.indexOf(step) + 1 },
        { step },
      );
    }
    const empty = journal.path({ task: TASK_A, item: "W2", epoch: 1 });
    await mkdir(path.dirname(empty), { recursive: true });
    await writeFile(empty, "");

    expect(await journal.unfinishedAttempts()).toEqual([]);
  });

  it("isolates verification by task activation and keeps completed item attempts terminal", async () => {
    const dir = await roleDir();
    const clock = clockAt(0, Date.UTC(2026, 0, 1));
    const journal = new Journal({ roleDir: dir, clock });
    const attempt = { task: TASK_A, item: "W2", epoch: 1 };
    const first = verificationKey(TASK_A, "owner-1:plan-1:activation-1");
    const resumed = verificationKey(TASK_A, "owner-1:plan-1:activation-2");
    await journal.append(attempt, { step: "delivered_published" });
    const delivered = await readFile(journal.path(attempt), "utf8");
    await journal.append(first, { step: "check_started" });
    expect(await journal.unfinishedAttempts()).toEqual([first]);
    await journal.append(first, { step: "checks", run_ids: ["run_unit"] });
    await journal.append(resumed, { step: "check_started" });
    expect(first).toEqual(verificationKey(TASK_A, "owner-1:plan-1:activation-1"));
    expect(journal.path(first)).not.toBe(journal.path(resumed));
    expect(journal.path(first)).not.toBe(
      journal.path(verificationKey(TASK_B, "owner-1:plan-1:activation-1")),
    );
    expect(await journal.read(first)).toHaveLength(2);
    const restarted = new Journal({ roleDir: dir, clock });
    expect(await restarted.unfinishedAttempts()).toEqual([resumed]);
    expect(await readFile(journal.path(attempt), "utf8")).toBe(delivered);
  });

  it.each(["verification-../W1", "verification-example", `verification-${"a".repeat(65)}`])(
    "rejects an invalid verification key %s",
    async (item) => {
      const journal = new Journal({ roleDir: await roleDir(), clock: clockAt(0, 0) });
      expect(() => journal.path({ task: TASK_A, item, epoch: 1 })).toThrow(JournalError);
    },
  );

  it("reports an attempt whose only line is torn, so reconciliation cannot miss it", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, Date.UTC(2026, 0, 1)) });
    const key = { task: TASK_A, item: "W1", epoch: 1 };
    const file = journal.path(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"step":"clai');

    expect(await journal.read(key)).toEqual([]);
    expect(await journal.unfinishedAttempts()).toEqual([key]);
  });

  it("rejects a key that would escape the journal directory", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, 0) });
    const escaped: AttemptKey = { task: "../x", item: "W1", epoch: 1 };
    expect(() => journal.path(escaped)).toThrow(JournalError);
    await expect(journal.append(escaped, { step: "claimed" })).rejects.toThrow(JournalError);
  });

  it("ignores a directory whose name is not a task id", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, 0) });
    const stray = path.join(dir, ".skep", "journal", "not-a-task", "W1-e1.jsonl");
    await mkdir(path.dirname(stray), { recursive: true });
    await writeFile(
      stray,
      `${JSON.stringify({ ts_mono: 0, ts_wall: "2026-01-01T00:00:00Z", step: "claimed" })}\n`,
    );
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

  it("redacts records before writing and returns exactly the sanitized record", async () => {
    const dir = await roleDir();
    const clock = clockAt(0, Date.UTC(2026, 0, 1));
    const journal = new Journal({ roleDir: dir, clock, redactor: new Redactor() });
    const key = { task: TASK_A, item: "W1", epoch: 1 };
    const body = "ExampleFake0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // gitleaks:allow
    const fakeKey = `sk-test-${body}`; // gitleaks:allow
    const privateKey =
      "-----BEGIN PRIVATE KEY-----\nEXAMPLE-FAKE-KEY-BODY\n-----END PRIVATE KEY-----"; // gitleaks:allow
    const input = {
      step: "invocation_done",
      output: `quote: "${fakeKey}"\nnext line`,
      details: {
        [fakeKey]: [`EXAMPLE_SECRET='${body}'`, { privateKey, passed: false }],
        absent: null,
        count: 3,
      },
    };

    const stored = await journal.append(key, input);
    const raw = await readFile(journal.path(key), "utf8");
    expect(raw).not.toContain(body);
    expect(raw).not.toContain("EXAMPLE-FAKE-KEY-BODY");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.split("\n")).toHaveLength(2);
    expect(stored).toEqual({
      step: "invocation_done",
      ts_mono: 0,
      ts_wall: "2026-01-01T00:00:00Z",
      output: 'quote: "[REDACTED:provider-api-key]"\nnext line',
      details: {
        "[REDACTED:provider-api-key]": [
          "EXAMPLE_SECRET='[REDACTED:secret-assignment]'",
          { privateKey: "[REDACTED:private-key]", passed: false },
        ],
        absent: null,
        count: 3,
      },
    });
    expect(JSON.parse(raw)).toEqual(stored);
    expect(await journal.read(key)).toEqual([stored]);
    expect(findSecrets(raw)).toEqual([]);
    expect(input.output).toContain(fakeKey);
    expect(input.details[fakeKey]).toContain(`EXAMPLE_SECRET='${body}'`);
  });

  it("redacts strings from toJSON before serialization reaches disk", async () => {
    const dir = await roleDir();
    const journal = new Journal({
      roleDir: dir,
      clock: clockAt(0, 0),
      redactor: new Redactor(),
    });
    const key = { task: TASK_A, item: "W1", epoch: 1 };
    const fakeKey = `sk-test-${"ExampleFake0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"}`; // gitleaks:allow
    const stored = await journal.append(key, {
      step: "invocation_done",
      output: { toJSON: () => fakeKey },
    });
    expect(stored.output).toBe("[REDACTED:provider-api-key]");
    expect(await readFile(journal.path(key), "utf8")).not.toContain(fakeKey);
  });

  it("keeps redaction opt-in and preserves the default SK-205 behavior", async () => {
    const dir = await roleDir();
    const journal = new Journal({ roleDir: dir, clock: clockAt(0, 0) });
    const key = { task: TASK_A, item: "W1", epoch: 1 };
    const fakeKey = `sk-test-${"ExampleFake0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"}`; // gitleaks:allow
    const first = await journal.append(key, { step: "invocation_done", output: fakeKey });
    expect(first.output).toBe(fakeKey);
    expect(await readFile(journal.path(key), "utf8")).toContain(fakeKey);
    expect(await journal.read(key)).toEqual([first]);
  });

  it("propagates redactor errors before repairing or writing the journal", async () => {
    const dir = await roleDir();
    const journal = new Journal({
      roleDir: dir,
      clock: clockAt(0, 0),
      redactor: {
        redact: () => {
          throw new Error("Redaction unavailable");
        },
      },
    });
    const key = { task: TASK_A, item: "W1", epoch: 1 };
    const file = journal.path(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"step":"clai');
    await expect(journal.append(key, { step: "invoked" })).rejects.toThrow("Redaction unavailable");
    expect(await readFile(file, "utf8")).toBe('{"step":"clai');
  });

  it("rejects redacted field collisions without exposing secrets or losing data", async () => {
    const dir = await roleDir();
    const journal = new Journal({
      roleDir: dir,
      clock: clockAt(0, 0),
      redactor: new Redactor(),
    });
    const key = { task: TASK_A, item: "W1", epoch: 1 };
    const fakeKey = `sk-test-${"ExampleFake0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"}`; // gitleaks:allow
    const error = await journal
      .append(key, { step: "invocation_done", details: { [fakeKey]: 1, [`${fakeKey}2`]: 2 } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JournalError);
    expect((error as JournalError).message).toContain("use non-secret journal field names");
    expect((error as JournalError).message).not.toContain(fakeKey);
    await expect(readFile(journal.path(key))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
