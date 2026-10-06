import { canonicalJson, sha256Hex } from "../core/canonical.js";
import { CheckRunSchema } from "../core/schemas/common.js";
import {
  CommandRunEvidenceSchema,
  type Evidence,
  EvidenceSchema,
  type FileSpanEvidence,
} from "../core/schemas/evidence.js";
import type { GitRunner } from "../git/runner.js";
import type { AttemptKey, Journal, JournalRecord } from "./journal.js";
import { type CodeMirror, CodeMirrorError } from "./worktree.js";

export class EvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EvidenceError";
  }
}

export interface EvidenceVerifierOptions {
  git: GitRunner;
  mirror: Pick<CodeMirror, "mirrorPath">;
  journal: Pick<Journal, "read">;
}

const CommandRunSchema = CommandRunEvidenceSchema.omit({ id: true, type: true });

/** ARCHITECTURE §9.5: local journal runs only; cross-device assertions are not MVP evidence. */
export class EvidenceVerifier {
  constructor(private readonly opts: EvidenceVerifierOptions) {}

  async verify(input: unknown, attempt: AttemptKey): Promise<boolean> {
    const parsed = EvidenceSchema.safeParse(input);
    if (!parsed.success) return false;
    const evidence = parsed.data;
    if (evidence.type === "file_span") return this.verifyFile(evidence);
    let records: JournalRecord[];
    try {
      records = await this.opts.journal.read(attempt);
    } catch (error) {
      throw new EvidenceError("Cannot read local run evidence; repair the attempt journal", {
        cause: error,
      });
    }
    const matching = records.filter(
      (record) =>
        record.run_id === evidence.run_id &&
        (evidence.type === "command_run"
          ? record.step === "command_run" || record.step === "check_run"
          : record.step === "check_run"),
    );
    // A run id identifies one completion. Duplicates cannot establish an unambiguous fact.
    if (matching.length !== 1) return false;
    const record = matching[0];
    if (!record) return false;
    if (evidence.type === "command_run") {
      const run = CommandRunSchema.safeParse({
        run_id: record.run_id,
        argv_sha256: record.argv_sha256,
        sha: record.sha,
        exit: record.exit,
        log_sha256: record.log_sha256,
      });
      const { id: _id, type: _type, ...expected } = evidence;
      return run.success && canonicalJson(run.data) === canonicalJson(expected);
    }
    const run = CheckRunSchema.safeParse({
      run_id: record.run_id,
      check: record.check,
      sha: record.sha,
      exit: record.exit,
      duration_ms: record.duration_ms,
      passed: record.passed,
      failed: record.failed,
      log_sha256: record.log_sha256,
    });
    return (
      run.success &&
      run.data.sha === evidence.sha &&
      run.data.check === evidence.check &&
      run.data.exit === evidence.exit &&
      run.data.log_sha256 === evidence.log_sha256 &&
      (evidence.passed === undefined || run.data.passed === evidence.passed) &&
      (evidence.failed === undefined || run.data.failed === evidence.failed)
    );
  }

  async verifyAll(inputs: readonly unknown[], attempt: AttemptKey): Promise<Evidence[]> {
    const verified: Evidence[] = [];
    for (const input of inputs) {
      const parsed = EvidenceSchema.safeParse(input);
      if (parsed.success && (await this.verify(parsed.data, attempt))) verified.push(parsed.data);
    }
    return verified;
  }

  private async verifyFile(evidence: FileSpanEvidence): Promise<boolean> {
    let dir: string;
    try {
      dir = await this.opts.mirror.mirrorPath(evidence.repo);
    } catch (error) {
      if (error instanceof CodeMirrorError) return false;
      throw new EvidenceError("Cannot access the evidence repository mirror", { cause: error });
    }
    let text: string;
    try {
      const result = await this.opts.git.run(["show", `${evidence.commit}:${evidence.path}`], {
        cwd: dir,
        allowFailure: true,
      });
      if (result.code !== 0) return false;
      text = result.stdout;
    } catch (error) {
      throw new EvidenceError("Cannot read pinned file evidence from the mirror", { cause: error });
    }
    const lines = text === "" ? [] : text.split("\n");
    // A terminal newline terminates the last line; it does not create an additional empty line.
    if (text.endsWith("\n")) lines.pop();
    const [start, end] = evidence.lines;
    if (end > lines.length) return false;
    const span = lines.slice(start - 1, end).join("\n");
    return (
      sha256Hex(span) === evidence.sha256 &&
      (evidence.excerpt === undefined || evidence.excerpt === span)
    );
  }
}
