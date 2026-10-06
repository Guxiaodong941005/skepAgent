import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ITEM_ID_RE, type ItemId, TASK_ID_RE, type TaskId } from "../core/ids.js";
import { type Clock, isoUtc } from "../util/clock.js";
import { appendFsync } from "../util/fs.js";

/**
 * Append-only, fsync'd JSONL run journal (ARCHITECTURE §11.3, PRD §10.6).
 *
 * One file per attempt: `<roleDir>/.skep/journal/<task>/<item>-e<epoch>.jsonl`. Restart
 * reconciliation reads it back to decide which attempts are still in flight, so a torn final line
 * (crash mid-write) must not hide the records before it, and a corrupt line in the middle must
 * fail loudly rather than be skipped.
 *
 * One writer per attempt file. `append` repairs a torn tail and then writes; two overlapping
 * appends to the same key in one process could truncate each other's line. The attempt runner is
 * that single writer, so appends are not serialized here.
 */

export interface AttemptKey {
  task: TaskId;
  item: ItemId;
  epoch: number;
}

/** A journal line. `step` is required; callers attach whatever else the pipeline recorded. */
export type JournalRecord = {
  ts_mono: number;
  ts_wall: string;
  step: string;
  [k: string]: unknown;
};

/** Steps after which an attempt needs no reconciliation (ARCHITECTURE §9.7 side exits). */
export const TERMINAL_STEPS = ["delivered_published", "failed", "checkpointed", "stale"] as const;

export type TerminalStep = (typeof TERMINAL_STEPS)[number];

const JOURNAL_DIR = path.join(".skep", "journal");

/** `<item>-e<epoch>.jsonl`; epoch is a positive integer so `e` cannot be confused with the item. */
const FILE_RE = /^(W[1-9]\d{0,2})-e([1-9]\d*)\.jsonl$/;

export class JournalError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    message: string,
  ) {
    super(`${file}:${line}: ${message}`);
    this.name = "JournalError";
  }
}

export class Journal {
  private readonly root: string;
  private readonly clock: Clock;

  constructor(opts: { roleDir: string; clock: Clock }) {
    this.root = path.join(opts.roleDir, JOURNAL_DIR);
    this.clock = opts.clock;
  }

  /**
   * Absolute path of the JSONL file for `key`. Does not create it. Rejects a key whose task,
   * item or epoch is not a protocol id: `path.join` would otherwise let `../` in a task id write
   * outside the journal root.
   */
  path(key: AttemptKey): string {
    assertKey(key);
    return journalFile(this.root, key);
  }

  /**
   * Appends one record, stamping `ts_mono` and `ts_wall` from the injected clock (never
   * `Date.now`). Resolves only after the line has been fsynced.
   */
  async append(
    key: AttemptKey,
    record: { step: string; [k: string]: unknown },
  ): Promise<JournalRecord> {
    assertKey(key);
    const stamped: JournalRecord = {
      ...record,
      ts_mono: this.clock.monotonicMs(),
      ts_wall: isoUtc(this.clock.nowMs()),
      step: record.step,
    };
    const file = this.path(key);
    await this.repairTornTail(file);
    await appendFsync(file, `${JSON.stringify(stamped)}\n`);
    return stamped;
  }

  /** Records in write order. A trailing partial line (no newline) is ignored; a bad middle line throws. */
  async read(key: AttemptKey): Promise<JournalRecord[]> {
    const file = this.path(key);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseJournal(file, text);
  }

  /**
   * Attempts whose last complete record is not a terminal step, sorted by task, item, then epoch.
   * A missing journal directory, or one with no files, is an empty result rather than an error:
   * a fresh role simply has nothing to reconcile. A non-empty file with no complete record is not:
   * its only line was torn by a crash, and reconciliation must see the attempt rather than skip it.
   * Directory names that are not task ids are ignored; they are not attempts.
   */
  async unfinishedAttempts(): Promise<AttemptKey[]> {
    let tasks: string[];
    try {
      tasks = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const unfinished: AttemptKey[] = [];
    for (const task of tasks) {
      if (!TASK_ID_RE.test(task)) continue;
      const taskDir = path.join(this.root, task);
      let files: string[];
      try {
        files = await readdir(taskDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") continue;
        throw error;
      }
      for (const name of files) {
        const match = FILE_RE.exec(name);
        if (!match || match[1] === undefined || match[2] === undefined) continue;
        const key: AttemptKey = { task, item: match[1], epoch: Number(match[2]) };
        const records = await this.read(key);
        const last = records.at(-1);
        // No complete record in a non-empty file means the first step was torn. Fail closed:
        // report the attempt so reconciliation can decide, instead of forgetting it.
        if (!last) {
          if (await fileNonEmpty(journalFile(this.root, key))) unfinished.push(key);
          continue;
        }
        if (!isTerminal(last.step)) unfinished.push(key);
      }
    }

    unfinished.sort(compareAttempts);
    return unfinished;
  }

  /**
   * A crash can leave a final line without its newline (PRD §10.6). Drop that fragment so the next
   * record starts on its own line; everything before the last newline is left untouched.
   */
  private async repairTornTail(file: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (text === "" || text.endsWith("\n")) return;
    // Keep every complete line, counted in bytes: `text` is decoded, so a character offset would
    // truncate inside a multibyte sequence when the torn tail follows non-ASCII content.
    const keptBytes = Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1));
    const handle = await open(file, "r+");
    try {
      await handle.truncate(keptBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function journalFile(root: string, key: AttemptKey): string {
  return path.join(root, key.task, `${key.item}-e${key.epoch}.jsonl`);
}

/**
 * Protocol ids only. `TaskId`/`ItemId` are plain strings, so a value that typechecks can still
 * contain `../`; `path.join` would then write outside the journal root.
 */
function assertKey(key: { task: string; item: string; epoch: number }): asserts key is AttemptKey {
  if (!TASK_ID_RE.test(key.task)) {
    throw new JournalError(key.task, 0, `invalid task id ${JSON.stringify(key.task)}`);
  }
  if (!ITEM_ID_RE.test(key.item)) {
    throw new JournalError(key.item, 0, `invalid item id ${JSON.stringify(key.item)}`);
  }
  if (!Number.isInteger(key.epoch) || key.epoch < 1) {
    throw new JournalError(key.item, 0, `invalid epoch ${key.epoch}`);
  }
}

async function fileNonEmpty(file: string): Promise<boolean> {
  return (await stat(file)).size > 0;
}

function isTerminal(step: string): step is TerminalStep {
  return (TERMINAL_STEPS as readonly string[]).includes(step);
}

function compareAttempts(a: AttemptKey, b: AttemptKey): number {
  if (a.task !== b.task) return a.task < b.task ? -1 : 1;
  if (a.item !== b.item) return a.item < b.item ? -1 : 1;
  return a.epoch - b.epoch;
}

/**
 * Parses JSONL. The last line may be torn — a crash between `write` and the closing newline — and
 * is ignored. Any other line that is not valid JSON is a corrupt journal, not a torn write, and
 * throws naming the file and the 1-based line.
 */
export function parseJournal(file: string, text: string): JournalRecord[] {
  if (text === "") return [];
  const torn = !text.endsWith("\n");
  const lines = text.split("\n");
  if (torn) lines.pop();
  // `split` on a trailing newline yields a final empty element; it is not a record.
  if (lines.at(-1) === "") lines.pop();

  const records: JournalRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new JournalError(file, i + 1, `corrupt journal record: ${(error as Error).message}`);
    }
    if (!isRecord(parsed)) {
      throw new JournalError(file, i + 1, "corrupt journal record: expected an object");
    }
    records.push(parsed);
  }
  return records;
}

function isRecord(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.step === "string" &&
    typeof record.ts_mono === "number" &&
    typeof record.ts_wall === "string"
  );
}
