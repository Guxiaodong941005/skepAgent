import { z } from "zod";
import { groupBrief } from "../core/orchestration/reducer.js";
import type { Ledger, LedgerRecord } from "./ledger.js";

export const ReportOptionsSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^O-[A-Za-z0-9-]+$/)
      .optional(),
    last: z.coerce.number().int().min(1).max(100).optional(),
    json: z.boolean().optional(),
  })
  .refine(
    (options) => !(options.id && options.last !== undefined),
    "choose an O-id or --last N, not both",
  );
export type ReportOptions = z.input<typeof ReportOptionsSchema>;
export class ReportError extends Error {
  override readonly name = "ReportError";
}

export async function sessionReport(
  ledger: Ledger,
  input: ReportOptions = {},
): Promise<{ text: string; records: LedgerRecord[]; problems: string[] }> {
  const parsed = ReportOptionsSchema.safeParse(input);
  if (!parsed.success)
    throw new ReportError(
      `Invalid report selection: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  const options = parsed.data;
  const { records: all, problems } = await ledger.recent(
    options.id ? Number.MAX_SAFE_INTEGER : (options.last ?? 1),
  );
  let records = all;
  if (options.id) {
    records = all.filter((r) => r.id === options.id);
    if (records.length === 0) records = all.filter((r) => r.state.id === options.id);
    if (records.length === 0)
      throw new ReportError(
        `No readable orchestration ${options.id}; use /history or a full ledger O-id`,
      );
    if (records.length > 1)
      throw new ReportError(
        `${options.id} occurs in multiple sessions; select its full ledger O-id from /history`,
      );
  }
  return {
    records,
    problems,
    text: options.json ? `${JSON.stringify(records, null, 2)}\n` : renderReport(records),
  };
}

function cell(value: string): string {
  return value.replace(
    /[&<>|\r\n]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "\\|", "\r": " ", "\n": " " })[c] ?? c,
  );
}
/** A user/model supplied fence must not escape its literal report section. */
function literal(text: string): string {
  const length = Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1));
  const fence = "`".repeat(length);
  return `${fence}text\n${text}\n${fence}`;
}
export function renderReport(records: readonly LedgerRecord[]): string {
  if (!records.length) return "No orchestrations recorded in this project yet.\n";
  return (
    "# Skep orchestration report\n\nSource: local orchestration ledger only; raw intents and session join/leave events are not recorded.\n\n" +
    records
      .map((record) => {
        const s = record.state;
        const lines = [
          `## ${cell(record.id)} (${cell(s.id)})`,
          "",
          `State: ${s.phase} · master agent: ${cell(record.cli)} · prompt version: ${record.promptVersion}`,
          `Created: ${new Date(record.createdAtMs).toISOString()} · Updated: ${new Date(record.updatedAtMs).toISOString()}`,
          "",
          "### Request",
          "",
          literal(s.userText),
          "",
          "### Refined brief",
          "",
          literal(s.brief ? `${s.brief.title}\n\n${s.brief.text}` : "(not refined)"),
          "",
          "### Skill and contract",
          "",
          s.skill
            ? `${cell(s.skill.skillId)} ${cell(s.skill.version)} (${cell(s.skill.scope)}) · digest ${cell(s.skill.digest)}`
            : "Generic (no active skill)",
          "",
          literal(s.contract ?? "(no shared contract)"),
          "",
          "### Stages",
          "",
          ...(s.stages?.length
            ? s.stages.map((stage) => `- ${cell(stage.id)}: ${stage.status}`)
            : ["Single dispatch wave."]),
          "",
          "### Dispatches",
          "",
        ];
        for (const group of s.groups) {
          const brief = groupBrief(s, group);
          lines.push(
            `- ${cell(group.intentId ?? "not sent")} · repo ${cell(group.repo ?? "route selected")} · roles ${cell(group.roles?.join(", ") || "unspecified")}${group.stage ? ` · stage ${cell(group.stage)}` : ""}${group.error ? ` · ${cell(group.error)}` : ""}`,
            "",
            literal(`${brief.title}\n\n${brief.text}`),
            "",
          );
        }
        lines.push("### Per-peer items", "");
        if (!s.items.length) lines.push("No items recorded.", "");
        for (const item of s.items) {
          const roles =
            s.groups.find((g) => g.intentId === item.intentId)?.roles?.join(", ") ||
            item.role ||
            "unspecified";
          const binding = s.bindings?.find((b) => b.peerId === item.peerId);
          const verdict =
            item.verdict +
            (item.skipped ? " (skipped deliberately)" : "") +
            (item.supersededBy ? ` (retried as ${item.supersededBy})` : "");
          lines.push(
            `#### ${cell(item.itemId)} · ${cell(verdict)}`,
            "",
            "| Peer | Device | Role | Repo | Intent |",
            "| --- | --- | --- | --- | --- |",
            `| ${cell(item.peerId ?? "unknown")} | ${cell(item.device ?? binding?.device ?? "unknown")} | ${cell(roles)} | ${cell(item.repo)} | ${cell(item.intentId)} |`,
            "",
            literal(item.summary ?? "(no result received)"),
            "",
            "Changed files:",
            "",
          );
          if (!item.changed) lines.push("Not recorded.", "");
          else {
            lines.push(
              `Recorded ${item.changed.files.length} of ${item.changed.total}${item.changed.partial ? " (partial)" : ""}.`,
              "",
              "| Path | Change | Added | Removed |",
              "| --- | --- | --- | --- |",
            );
            for (const f of item.changed.files)
              lines.push(
                `| ${cell(f.path)} | ${cell(f.change)} | ${f.added ?? "unknown"} | ${f.removed ?? "unknown"} |`,
              );
            lines.push("");
          }
        }
        lines.push(
          "### Skipped roles",
          "",
          ...(s.skippedRoles?.length
            ? s.skippedRoles.map((role) => `- ${cell(role)}`)
            : ["None recorded."]),
          "",
          "### Synthesis",
          "",
          literal(s.synthesis ?? "(no synthesis)"),
        );
        if (s.failure)
          lines.push("", "Failure:", "", literal(`${s.failure.stage}: ${s.failure.cause}`));
        return lines.join("\n");
      })
      .join("\n\n---\n\n") +
    "\n"
  );
}
