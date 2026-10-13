/**
 * What the master agent must return from a refine turn
 * (docs/plans/tui-scroll-and-herdr-controller.md §3.4). Model output is external input, so it
 * is parsed strictly: unknown keys are rejected, sizes are bounded.
 */

import { z } from "zod";

/** The wire intent text is at most 4000 characters; the title line and a blank line come first. */
export const MAX_BRIEF_CHARS = 3_800;
export const MAX_TITLE_CHARS = 200;
export const MAX_QUESTIONS = 3;

export const RefineOutputSchema = z.strictObject({
  /** A self-contained task line: a peer on ≤0.1.13 sees only this (plan §3.6). */
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  /** The full task for the peer agent, English. */
  brief: z.string().trim().min(1).max(MAX_BRIEF_CHARS),
  /** Phase 3: per-repo briefs. v1 accepts and records them; dispatch uses one brief. */
  targets: z
    .array(
      z.strictObject({
        repo: z.string().trim().min(1).max(200),
        brief: z.string().trim().min(1).max(MAX_BRIEF_CHARS).optional(),
      }),
    )
    .max(16)
    .optional(),
  /** Asked to the human before dispatch. */
  questions: z.array(z.string().trim().min(1).max(500)).max(MAX_QUESTIONS).optional(),
  /** Master-side context; never sent to peers. */
  notes: z.string().max(1_000).optional(),
});

export type RefineOutput = z.infer<typeof RefineOutputSchema>;

export type RefineParse = { ok: true; output: RefineOutput } | { ok: false; reason: string };

/**
 * The last fenced ```json block of a reply, parsed against {@link RefineOutputSchema}. A reply
 * that is only a JSON object (no fence) is accepted too: some CLIs strip fences.
 */
export function parseRefineOutput(reply: string): RefineParse {
  const fences = [...reply.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/g)];
  const candidate = fences.at(-1)?.[1] ?? reply.trim();
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch (error) {
    return {
      ok: false,
      reason:
        fences.length === 0
          ? "no fenced ```json block in the reply"
          : `the json block does not parse: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = RefineOutputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
    return { ok: false, reason: `the json does not match the contract: ${where}${issue?.message}` };
  }
  return { ok: true, output: parsed.data };
}

/** The text that goes on the wire: the title line (what old peers see), a blank line, the brief. */
export function briefText(title: string, brief: string): string {
  return `${title}\n\n${brief}`;
}
