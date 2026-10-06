/**
 * `--machine` printing without editing `output.ts` (SK-603 owns it).
 *
 * `Output.result` wraps its argument in `{ ok: true, result }` and stringifies with
 * `JSON.stringify`, which keeps insertion order rather than the canonical key order F20
 * requires. The envelope is byte-identical to what `output.result` would write — one JSON line,
 * `ok: true`, the result nested — except the bytes come from `canonicalJson`.
 */

import { canonicalJson } from "../../core/canonical.js";
import type { CliContext } from "../context.js";

/** One canonical JSON line when `--machine` is set; the human rendering otherwise. */
export function printMachine(ctx: CliContext, data: unknown, human: string): void {
  const output = ctx.output();
  if (output.machine) {
    ctx.stdout.write(`${canonicalJson({ ok: true, result: data })}\n`);
    return;
  }
  output.result(data, () => human);
}
