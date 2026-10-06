import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RelPathSchema } from "../core/schemas/common.js";
import type { Evidence } from "../core/schemas/evidence.js";
import { PlanSchema } from "../core/schemas/plan.js";
import { ReviewSchema } from "../core/schemas/review.js";
import { type WorkReport, WorkReportSchema } from "../core/schemas/work-report.js";
import type { Clock } from "../util/clock.js";
import { safeJoin } from "../util/fs.js";
import type {
  AdapterInvocation,
  AdapterProbe,
  AdapterResult,
  AgentAdapter,
  InvocationKind,
  InvocationOutcome,
} from "./types.js";

export interface FakeFile {
  path: string;
  /** Omit for seeded content; specify to make a trusted check pass or fail deliberately. */
  content?: string;
}

interface FakeSuccess {
  files?: readonly (string | FakeFile)[];
  /** Override the default schema-valid example to bind a plan/review to a scenario's task. */
  output?: unknown;
}

export type FakeScript =
  | ({ kind: "success" } & FakeSuccess)
  | { kind: "invalidJson"; text?: string }
  | { kind: "wrongEvidence" | "validButWrongEvidence" }
  | { kind: "hang" }
  | ({ kind: "slow"; ms: number } & FakeSuccess)
  | { kind: "permissionPrompt" }
  | { kind: "replanRequest"; evidence: readonly Evidence[]; summary?: string }
  | { kind: "crash"; exitCode?: number };

export interface FakeFileWriter {
  write(cwd: string, relativePath: string, content: string): Promise<void>;
}

/** Real temp-worktree writer; simulations may inject an in-memory writer instead. */
export const nodeFakeFileWriter: FakeFileWriter = {
  async write(cwd, relativePath, content) {
    const target = await safeJoin(cwd, RelPathSchema.parse(relativePath));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  },
};

export interface FakeAdapterOptions {
  clock: Clock;
  seed: number | string;
  /** A single script repeats; a sequence is consumed in order and fails loudly on exhaustion. */
  scripts: Partial<Record<InvocationKind, FakeScript | readonly FakeScript[]>>;
  fileWriter?: FakeFileWriter;
  cli?: AgentAdapter["cli"];
  version?: string;
}

export class FakeAdapterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FakeAdapterError";
  }
}

const EXAMPLE_COMMIT = "a".repeat(40);

function report(files: string[]): WorkReport {
  return {
    schema: "skep.work_report/v1",
    summary: "Deterministic fake invocation completed; checks are the daemon's responsibility.",
    files_intended: files,
    concerns: [],
    replan_request: null,
  };
}

function outputKind(inv: AdapterInvocation): "plan" | "review" | "work" {
  if (inv.kind === "plan" || inv.kind === "review") return inv.kind;
  const properties = inv.outputSchema.properties;
  if (properties && typeof properties === "object" && "schema" in properties) {
    const schema = properties.schema;
    if (schema && typeof schema === "object" && "const" in schema) {
      if (schema.const === "skep.plan/v1") return "plan";
      if (schema.const === "skep.review/v1") return "review";
    }
  }
  return "work";
}

function defaultOutput(inv: AdapterInvocation, files: string[]): unknown {
  switch (outputKind(inv)) {
    case "plan":
      return PlanSchema.parse({
        schema: "skep.plan/v1",
        task_id: "T-20261006-307a",
        version: 1,
        parent_version: null,
        base: { repo: "https://example.invalid/repo.git", branch: "main", commit: EXAMPLE_COMMIT },
        mode: "solo",
        summary: "Implement the example item.",
        items: [
          {
            id: "W1",
            title: "Example item",
            role: "coding",
            assignee: "vps.coding",
            depends_on: [],
            touches: ["src/"],
            risk: "normal",
            acceptance: [{ kind: "manual", text: "Review the example change." }],
          },
        ],
        stack_order: ["W1"],
        changes_from_parent: null,
      });
    case "review":
      return ReviewSchema.parse({
        schema: "skep.review/v1",
        plan_version: 1,
        plan_hash: `sha256:${"0".repeat(64)}`,
        verdict: "approve",
        blockers: [],
        suggestions: [],
      });
    case "work":
      return report(files);
  }
}

/** Schema-valid, intentionally false evidence; only the daemon's verifier may reject it (§9.5). */
function wrongEvidence(inv: AdapterInvocation): unknown {
  const evidence: Evidence = {
    id: "ev_1",
    type: "file_span",
    repo: "https://example.invalid/repo.git",
    commit: EXAMPLE_COMMIT,
    path: "src/example.ts",
    lines: [1, 1],
    sha256: "0".repeat(64),
    excerpt: "Intentionally incorrect excerpt.",
  };
  if (outputKind(inv) === "plan") {
    throw new FakeAdapterError("wrongEvidence requires a review or work-report invocation.");
  }
  if (outputKind(inv) === "review") {
    return ReviewSchema.parse({
      schema: "skep.review/v1",
      plan_version: 1,
      plan_hash: `sha256:${"0".repeat(64)}`,
      verdict: "block",
      blockers: [{ id: "B1", claim: "Example acceptance gap.", evidence: [evidence] }],
      suggestions: [],
    });
  }
  return WorkReportSchema.parse({
    ...report([]),
    replan_request: { summary: "Example plan assumption is wrong.", evidence: [evidence] },
  });
}

/** Scripted adapter for deterministic scenarios (ARCHITECTURE §13.4), with no agent processes. */
export class FakeAdapter implements AgentAdapter {
  readonly cli: AgentAdapter["cli"];
  readonly invocations: AdapterInvocation[] = [];
  private readonly positions: Partial<Record<InvocationKind, number>> = {};
  private readonly fileWriter: FakeFileWriter;

  constructor(private readonly options: FakeAdapterOptions) {
    this.cli = options.cli ?? "codex";
    this.fileWriter = options.fileWriter ?? nodeFakeFileWriter;
  }

  async probe(): Promise<AdapterProbe> {
    return {
      ok: true,
      version: this.options.version ?? "fake-adapter/v1",
      detail: "Deterministic fake adapter; no CLI or provider configuration is read.",
    };
  }

  async invoke(inv: AdapterInvocation): Promise<AdapterResult> {
    const start = this.options.clock.monotonicMs();
    if (!Number.isFinite(inv.timeoutMs) || inv.timeoutMs < 0) {
      throw new FakeAdapterError("Fake invocation timeoutMs must be finite and non-negative.");
    }
    const result = (
      outcome: InvocationOutcome,
      finalMessage: string | null = null,
      exitCode: number | null = null,
    ): AdapterResult => ({
      outcome,
      exitCode,
      finalMessage,
      usage: null,
      durationMs: this.options.clock.monotonicMs() - start,
      pid: null,
    });
    this.invocations.push({
      ...inv,
      env: { ...inv.env },
      outputSchema: structuredClone(inv.outputSchema),
    });
    if (inv.signal.aborted) return result("interrupted");

    const position = this.positions[inv.kind] ?? 0;
    const configured = this.options.scripts[inv.kind];
    const script: FakeScript | undefined = Array.isArray(configured)
      ? configured[position]
      : (configured as FakeScript | undefined);
    if (!script) {
      throw new FakeAdapterError(
        `No fake script for ${inv.kind} invocation ${position + 1}; configure the scenario explicitly.`,
      );
    }
    this.positions[inv.kind] = position + 1;

    if (script.kind === "hang" || script.kind === "slow") {
      if (script.kind === "slow" && (!Number.isFinite(script.ms) || script.ms < 0)) {
        throw new FakeAdapterError("Fake slow duration must be finite and non-negative.");
      }
      const timedOut = script.kind === "hang" || script.ms >= inv.timeoutMs;
      const ms = timedOut ? inv.timeoutMs : script.ms;
      try {
        await this.options.clock.sleep(ms, inv.signal);
      } catch (error) {
        if (inv.signal.aborted && error instanceof Error && error.name === "AbortError") {
          return result("interrupted");
        }
        throw new FakeAdapterError("Fake adapter clock.sleep failed.", { cause: error });
      }
      if (inv.signal.aborted) return result("interrupted");
      if (timedOut) return result("timeout");
    }

    switch (script.kind) {
      case "permissionPrompt":
        return result("permission_prompt");
      case "crash": {
        const code = script.exitCode ?? 1;
        if (!Number.isInteger(code) || code === 0) {
          throw new FakeAdapterError("Fake crash exitCode must be a non-zero integer.");
        }
        // AdapterResult has no crash outcome: the runner classifies a non-zero completed exit.
        return result("completed", null, code);
      }
      case "invalidJson":
        return result("completed", script.text ?? "{invalid JSON}", 0);
      case "wrongEvidence":
      case "validButWrongEvidence":
        return result("completed", JSON.stringify(wrongEvidence(inv)), 0);
      case "replanRequest": {
        if (outputKind(inv) !== "work") {
          throw new FakeAdapterError("replanRequest requires a work-report invocation.");
        }
        const output = WorkReportSchema.parse({
          ...report([]),
          replan_request: {
            summary: script.summary ?? "The plan must be revised based on the supplied evidence.",
            evidence: script.evidence,
          },
        });
        return result("completed", JSON.stringify(output), 0);
      }
      case "success":
      case "slow": {
        const files = (script.files ?? []).map((file) =>
          typeof file === "string" ? { path: file } : file,
        );
        for (const file of files) RelPathSchema.parse(file.path);
        if (files.length > 0 && inv.kind !== "work" && inv.kind !== "fixup") {
          throw new FakeAdapterError(
            "Fake file edits are allowed only for work/fixup invocations.",
          );
        }
        for (const file of files) {
          if (inv.signal.aborted) return result("interrupted");
          const hash = createHash("sha256")
            .update(JSON.stringify([this.options.seed, inv.kind, position, file.path]))
            .digest("hex");
          try {
            await this.fileWriter.write(inv.cwd, file.path, file.content ?? `skep fake ${hash}\n`);
          } catch (error) {
            throw new FakeAdapterError(`Could not write fake worktree file ${file.path}.`, {
              cause: error,
            });
          }
        }
        if (inv.signal.aborted) return result("interrupted");
        const output =
          script.output === undefined
            ? defaultOutput(
                inv,
                files.map((file) => file.path),
              )
            : script.output;
        return result("completed", JSON.stringify(output), 0);
      }
    }
  }
}
