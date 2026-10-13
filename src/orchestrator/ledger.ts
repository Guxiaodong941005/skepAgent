/**
 * The orchestration ledger: `<home>/orchestrations/<id>.json`, 0600
 * (docs/plans/tui-scroll-and-herdr-controller.md §3.7). It records what the master agent was
 * asked and answered, what was sent, and what came back, so a conversation can be re-seeded when
 * resume fails or the 500K cap is reached, and `/history` can list past requests. Everything in
 * it is already redacted (wire text) or local to this device.
 */

import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { OrchestrationState } from "../core/orchestration/reducer.js";
import { atomicWrite } from "../util/fs.js";

export const LEDGER_VERSION = 1;

export interface LedgerRecord {
  version: number;
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  cli: string;
  conversationId: string | null;
  promptVersion: number;
  state: OrchestrationState;
}

/** Read back loosely on `state` (it is our own JSON) but strictly on the envelope. */
const LedgerRecordSchema = z.strictObject({
  version: z.literal(LEDGER_VERSION),
  id: z.string().regex(/^O-[A-Za-z0-9-]+$/),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
  cli: z.string(),
  conversationId: z.string().nullable(),
  promptVersion: z.number(),
  state: z
    .object({
      id: z.string(),
      phase: z.string(),
      userText: z.string(),
      synthesis: z.string().nullable(),
    })
    .passthrough(),
});

export class Ledger {
  constructor(private readonly dir: string) {}

  static at(home: string): Ledger {
    return new Ledger(path.join(home, "orchestrations"));
  }

  file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  async write(record: LedgerRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await atomicWrite(this.file(record.id), `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  /** The newest `limit` records, newest first; unreadable files are reported, not hidden. */
  async recent(limit: number): Promise<{ records: LedgerRecord[]; problems: string[] }> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], problems: [] };
      throw error;
    }
    const records: LedgerRecord[] = [];
    const problems: string[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        const value: unknown = JSON.parse(await readFile(path.join(this.dir, name), "utf8"));
        const parsed = LedgerRecordSchema.parse(value);
        records.push(parsed as unknown as LedgerRecord);
      } catch (error) {
        problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    records.sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id));
    return { records: records.slice(0, limit), problems };
  }
}
