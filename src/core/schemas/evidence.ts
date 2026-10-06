import { z } from "zod";
import {
  NonNegIntSchema,
  PositiveIntSchema,
  RelPathSchema,
  RepoRefSchema,
  Sha256HexSchema,
  ShaSchema,
} from "./common.js";

/**
 * Typed, machine-checkable evidence (PRD §9.3, §9.6). Every item is pinned to a commit SHA or to
 * a daemon run-journal entry so any daemon can re-verify it. Free-text claims are never evidence.
 */

const EvidenceIdSchema = z.string().regex(/^ev_[0-9a-z_]{1,32}$/, "invalid evidence id");

/** Lines `[start, end]` (1-based, inclusive) of a file at a commit; `sha256` of those lines. */
export const FileSpanEvidenceSchema = z
  .strictObject({
    id: EvidenceIdSchema,
    type: z.literal("file_span"),
    repo: RepoRefSchema,
    commit: ShaSchema,
    path: RelPathSchema,
    lines: z.tuple([PositiveIntSchema, PositiveIntSchema]),
    sha256: Sha256HexSchema,
    /** Optional verbatim excerpt, at most 20 lines (PRD §8.2). */
    excerpt: z.string().max(4000).optional(),
  })
  .refine((e) => e.lines[0] <= e.lines[1] && e.lines[1] - e.lines[0] < 400, {
    message: "invalid line range",
  })
  .refine((e) => e.excerpt === undefined || e.excerpt.split("\n").length <= 20, {
    message: "excerpt longer than 20 lines",
  });

/** A command the daemon ran and journaled (never a model assertion). */
export const CommandRunEvidenceSchema = z.strictObject({
  id: EvidenceIdSchema,
  type: z.literal("command_run"),
  /** Run-journal id on the emitting device. */
  run_id: z.string().min(1).max(64),
  /** sha256 of the canonical argv JSON. */
  argv_sha256: Sha256HexSchema,
  sha: ShaSchema,
  exit: z.number().int(),
  log_sha256: Sha256HexSchema,
});

/** A trusted named check the daemon ran (subset of CheckRun with an evidence id). */
export const CheckRunEvidenceSchema = z.strictObject({
  id: EvidenceIdSchema,
  type: z.literal("check_run"),
  run_id: z.string().min(1).max(64),
  check: z.string().min(1).max(64),
  sha: ShaSchema,
  exit: z.number().int(),
  passed: NonNegIntSchema.optional(),
  failed: NonNegIntSchema.optional(),
  log_sha256: Sha256HexSchema,
});

export const EvidenceSchema = z.discriminatedUnion("type", [
  FileSpanEvidenceSchema,
  CommandRunEvidenceSchema,
  CheckRunEvidenceSchema,
]);

export type FileSpanEvidence = z.infer<typeof FileSpanEvidenceSchema>;
export type CommandRunEvidence = z.infer<typeof CommandRunEvidenceSchema>;
export type CheckRunEvidence = z.infer<typeof CheckRunEvidenceSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
