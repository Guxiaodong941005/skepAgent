/**
 * What the master agent must return from a refine turn
 * (docs/plans/tui-scroll-and-herdr-controller.md §3.4). Model output is external input, so it
 * is parsed strictly: unknown keys are rejected, sizes are bounded.
 */

import { z } from "zod";

/** A v2 intent carries at most 8000 characters (session `BRIEF_MAX`, D35). */
export const MAX_INTENT_CHARS = 8_000;
export const MAX_TITLE_CHARS = 200;
/**
 * "About 7800" (locked plan §9.12): the longest title, a blank line and the brief still fit one
 * v2 intent. A v1 peer gets the first 4000 characters, title first (`wireText`).
 */
export const MAX_BRIEF_CHARS = MAX_INTENT_CHARS - MAX_TITLE_CHARS - 2;
/** One intent per target repo (plan §7 Phase 3 ORCH-7); an intent names at most 16 repos. */
export const MAX_TARGETS = 16;
export const MAX_QUESTIONS = 3;

export const RefineOutputSchema = z.strictObject({
  /** A self-contained task line: a peer on ≤0.1.13 sees only this (plan §3.6). */
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  /** The full task for the peer agent, English. */
  brief: z.string().trim().min(1).max(MAX_BRIEF_CHARS),
  /**
   * Per-repo briefs (ORCH-7): one intent per target, sent with `repos=[repo]`. A target without
   * its own title or brief uses the top-level one.
   */
  targets: z
    .array(
      z.strictObject({
        repo: z.string().trim().min(1).max(200),
        title: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
        brief: z.string().trim().min(1).max(MAX_BRIEF_CHARS).optional(),
      }),
    )
    .max(MAX_TARGETS)
    // Two intents for one repo would reach the same peer as two separate tasks.
    .refine((targets) => new Set(targets.map((target) => target.repo)).size === targets.length, {
      message: "each repo may appear in targets once",
    })
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
