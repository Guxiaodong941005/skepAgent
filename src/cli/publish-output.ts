/**
 * How a write command reports a publication (PRD §15.2).
 *
 * `accepted` and `rejected` both name the `#seq` the commit landed at, because a rejection is
 * still a commit on the log (ARCHITECTURE §5.3). `dropped` never was: the intent returned null
 * against the replayed state, so there is no seq to show.
 *
 * The exit code distinguishes them — accepted is 0, everything else is {@link EXIT.rejected} —
 * and it is returned through `ctx.exitCode`, which `runCli` reports when the action resolves.
 * Throwing would make `runCli` print a second error line after this verdict.
 *
 * A non-accepted verdict goes through `Output.fail`, so the machine line's top-level `ok`
 * is `false` and agrees with the non-zero exit (G5; SK-603 review, follow-up H10). The verdict
 * itself stays under `result`, and the error code is the status.
 */

import type { CliContext } from "./context.js";
import { CliError, EXIT } from "./output.js";
import type { Published } from "./publish.js";

/** Print the verdict. A non-accepted verdict sets `ctx.exitCode` to {@link EXIT.rejected}. */
export function reportPublished(ctx: CliContext, published: Published): void {
  const output = ctx.output();
  if (published.status === "accepted") {
    output.result(machineBody(published), () => humanLine(published));
    return;
  }
  const error = new CliError(published.status, failureMessage(published), EXIT.rejected);
  output.fail(error, machineBody(published), () => humanLine(published));
  ctx.exitCode = EXIT.rejected;
}

function failureMessage(published: Published): string {
  const reason = published.reason === undefined ? "" : `: ${published.reason}`;
  switch (published.status) {
    case "rejected":
      return `the intent was committed at #${published.seq ?? "?"} but rejected${reason}`;
    case "dropped":
      return `the intent no longer applies to the current state; nothing was published${reason}`;
    default:
      return `the publication failed${reason}`;
  }
}

function machineBody(published: Published): unknown {
  return {
    status: published.status,
    ...(published.seq === undefined ? {} : { seq: published.seq }),
    ...(published.reason === undefined ? {} : { reason: published.reason }),
    ...(published.eventId === undefined ? {} : { event_id: published.eventId }),
    ...(published.plan === undefined
      ? {}
      : { plan_version: published.plan.version, plan_hash: published.plan.planHash }),
  };
}

function humanLine(published: Published): string {
  const seq = published.seq === undefined ? "" : ` #${published.seq}`;
  const plan =
    published.plan === undefined
      ? ""
      : ` plan v${published.plan.version} (${published.plan.planHash})`;
  const reason = published.reason === undefined ? "" : `: ${published.reason}`;
  return `${published.status}${seq}${plan}${reason}\n`;
}
