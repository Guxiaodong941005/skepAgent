import { readFileSync, writeFileSync } from "node:fs";
import { contentHash } from "../../src/core/canonical.js";
import type { LogEntry } from "../../src/core/log.js";
import { replay } from "../../src/core/reducer/replay.js";
import type { State } from "../../src/core/reducer/state.js";

/**
 * Golden replay fixtures (SK-305, ARCHITECTURE §14).
 *
 * A fixture is one blackboard log — genesis plus every later commit, exactly as the git log
 * reader would hand it to the reducer — together with the `contentHash` of the state `replay`
 * produces. The hash is of the whole state, outcomes included, so a change to any handler, the
 * audit trail or `REDUCER_VERSION` moves it. Fixtures live as JSON under `test/fixtures/golden/`
 * and are the guard for reducer versioning: a reducer change that should keep old logs replaying
 * identically must keep these hashes, and one that should not must bump the reducer version and
 * update the fixtures deliberately.
 *
 * Updating: `SKEP_UPDATE_GOLDEN=1 npx vitest run test/integration/golden.test.ts` rewrites every
 * fixture's `state_hash` and its entries from the scenarios in `golden-scenarios.ts`. There is no
 * script and no npm target for it, so a hash only changes when someone runs that and reviews it.
 */

export const GOLDEN_DIR = "test/fixtures/golden";

export interface GoldenFixture {
  /** Scenario name; also the file name (`<name>.json`). */
  name: string;
  /** What the log pins, so a hash change can be judged against the intended path. */
  summary: string;
  /** `contentHash(replay(entries))` — `sha256:<hex>` of the canonical state JSON. */
  state_hash: string;
  entries: LogEntry[];
}

export function fixturePath(name: string): string {
  return `${GOLDEN_DIR}/${name}.json`;
}

/** Read and structurally check one fixture file. Schema-level validation is the reducer's job. */
export function loadFixture(name: string): GoldenFixture {
  const raw: unknown = JSON.parse(readFileSync(fixturePath(name), "utf8"));
  if (!isFixture(raw)) {
    throw new Error(
      `${fixturePath(name)} is not a golden fixture (name, summary, state_hash, entries)`,
    );
  }
  return raw;
}

export function saveFixture(fixture: GoldenFixture): void {
  writeFileSync(fixturePath(fixture.name), `${JSON.stringify(fixture, null, 2)}\n`);
}

/** Replay a fixture's log and return the state plus its content hash. */
export function replayFixture(fixture: GoldenFixture): { state: State; hash: string } {
  const state = replay(fixture.entries);
  return { state, hash: contentHash(state) };
}

function isFixture(value: unknown): value is GoldenFixture {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.summary === "string" &&
    typeof record.state_hash === "string" &&
    Array.isArray(record.entries)
  );
}
