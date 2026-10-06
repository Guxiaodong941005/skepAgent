import { parseEventPath } from "../ids.js";
import type { LogEntry } from "../log.js";
import { type Principal, parsePrincipal } from "../principal.js";
import { parseEventFile, type SkepEvent } from "../schemas/events.js";
import type { InvalidReason } from "./state.js";

export type StructureResult =
  | { ok: true; event: SkepEvent; principal: Principal }
  | { ok: false; reason: InvalidReason; detail: string };

export function checkStructure(entry: LogEntry, prevTip: string): StructureResult {
  // ARCHITECTURE §5.3: the first failed check determines the audit reason.
  if (entry.parents.length !== 1) {
    return { ok: false, reason: "not_linear", detail: "expected exactly one parent" };
  }
  if (entry.parents[0] !== prevTip) {
    return {
      ok: false,
      reason: "parent_mismatch",
      detail: "parent does not match the previous tip",
    };
  }
  switch (entry.signature.status) {
    case "missing":
      return { ok: false, reason: "unsigned", detail: "commit has no signature" };
    case "bad":
      return { ok: false, reason: "bad_signature", detail: entry.signature.detail };
    case "unknown_key":
      return { ok: false, reason: "unknown_signer", detail: entry.signature.detail };
  }
  const principal = parsePrincipal(entry.signature.principal);
  if (!principal) {
    return { ok: false, reason: "unknown_signer", detail: "signer principal is not recognized" };
  }
  const change = entry.changes[0];
  if (entry.changes.length !== 1 || change?.status !== "A") {
    return { ok: false, reason: "not_single_add", detail: "expected exactly one added file" };
  }
  const path = parseEventPath(change.path);
  if (!path) {
    return {
      ok: false,
      reason: "bad_event_path",
      detail: "file must be events/<task|_skep>/<evt>.json",
    };
  }
  const content = entry.added[change.path];
  if (content == null) {
    return {
      ok: false,
      reason: "unreadable_event",
      detail: "event is missing, oversized or not UTF-8",
    };
  }
  const parsed = parseEventFile(content);
  if (!parsed.ok) return { ok: false, reason: "schema_invalid", detail: parsed.error };
  const event = parsed.event;
  if (path.taskId !== event.task_id || path.eventId !== event.event_id) {
    return {
      ok: false,
      reason: "path_mismatch",
      detail: "path IDs do not match the event envelope",
    };
  }
  return { ok: true, event, principal };
}
