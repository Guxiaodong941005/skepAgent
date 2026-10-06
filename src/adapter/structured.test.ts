import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PlanSchema } from "../core/schemas/plan.js";
import { ReviewSchema } from "../core/schemas/review.js";
import { WorkReportSchema } from "../core/schemas/work-report.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import { toCodexOutputSchema } from "./codex.js";
import { FakeAdapter } from "./fake.js";
import { extractJson, normalizeOptionalNulls, runStructured } from "./structured.js";
import type { AdapterInvocation, AdapterResult, AgentAdapter, InvocationOutcome } from "./types.js";

function invocation(overrides: Partial<AdapterInvocation> = {}): AdapterInvocation {
  return {
    kind: "work",
    cwd: "/worktree",
    prompt: "Implement the example item.",
    outputSchema: { ignored: true },
    timeoutMs: 1000,
    env: {},
    logPath: "/worktree/run.log",
    scratchDir: "/worktree/scratch",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function completed(message: unknown, overrides: Partial<AdapterResult> = {}): AdapterResult {
  return {
    outcome: "completed",
    exitCode: 0,
    finalMessage: typeof message === "string" ? message : JSON.stringify(message),
    usage: { input_tokens: 10, output_tokens: 4 },
    durationMs: 10,
    pid: 123,
    ...overrides,
  };
}

function scripted(...results: AdapterResult[]) {
  const invoke = vi.fn(async (_inv: AdapterInvocation) => {
    const next = results.shift();
    if (!next) throw new Error("Unexpected adapter invocation.");
    return next;
  });
  const adapter: AgentAdapter = {
    cli: "codex",
    invoke,
    probe: async () => ({ ok: true, version: "fake/v1", detail: "Test adapter." }),
  };
  return { adapter, invoke };
}

describe("extractJson", () => {
  it.each([
    ['{"summary":"Example"}', { summary: "Example" }],
    ['Prose before\n{"summary":"Example"}\nProse after', { summary: "Example" }],
    ['```json\n{"summary":"Example"}\n```', { summary: "Example" }],
    ['```\n{"summary":"Example"}\n```', { summary: "Example" }],
    ['{"first":1}\n```json\n{"last":2}\n```', { last: 2 }],
    ['```json\n{"first":1}\n```\n{"last":2}', { last: 2 }],
    ['{not JSON}\n{"last":2}\n{still not JSON}', { last: 2 }],
    [
      '{"nested":{"value":1},"items":[{"value":2}]}',
      { nested: { value: 1 }, items: [{ value: 2 }] },
    ],
    [
      JSON.stringify({ text: 'A } brace, [bracket], "quote", and \\ slash.', nested: {} }),
      { text: 'A } brace, [bracket], "quote", and \\ slash.', nested: {} },
    ],
    ['{"complete":true}\n{"truncated":', { complete: true }],
  ])("extracts the last complete object from %s", (text, expected) => {
    expect(extractJson(text)).toEqual(expected);
  });

  it("recovers the object that follows a stray unmatched brace in prose", () => {
    // The forward scan never returns to an empty stack here, so only the fallback finds it.
    const text = 'Using {x as a placeholder, then {"summary": "Example", "n": 1}';
    expect(extractJson(text)).toEqual({ summary: "Example", n: 1 });
    // The last object still wins when the prose has more than one.
    expect(extractJson('note {a then {"first": 1} and {"last": 2}')).toEqual({ last: 2 });
    // A brace quoted inside the object is not a candidate start.
    expect(extractJson('prose { then {"text": "a { brace"}')).toEqual({ text: "a { brace" });
  });

  it.each([
    "",
    "No JSON here.",
    "null",
    "42",
    "true",
    "[]",
    '[{"nested":true}]',
    '"{}"',
    '{"missing":',
    '{"invalid":undefined}',
  ])("returns null for non-object output %s", (text) => {
    expect(extractJson(text)).toBeNull();
  });
});

describe("normalizeOptionalNulls", () => {
  it("removes optional nulls recursively, retains required nullable fields, and does not mutate inputs", () => {
    const child = z.strictObject({
      optional: z.string().optional(),
      required: z.string().nullable(),
    });
    const schema = z.strictObject({
      child,
      items: z.array(child),
      optionalObject: child.optional(),
      optionalNullable: z.string().nullable().optional(),
      required: z.string().nullable(),
    });
    const originalSchema = z.toJSONSchema(schema);
    const schemaBefore = structuredClone(originalSchema);
    const value = {
      child: { optional: null, required: null },
      items: [{ optional: null, required: null }],
      optionalObject: null,
      optionalNullable: null,
      required: null,
    };
    const before = structuredClone(value);
    const normalized = normalizeOptionalNulls(value, originalSchema);
    expect(normalized).toEqual({
      child: { required: null },
      items: [{ required: null }],
      required: null,
    });
    expect(schema.parse(normalized)).toEqual(normalized);
    expect(value).toEqual(before);
    expect(originalSchema).toEqual(schemaBefore);
  });

  it("uses anyOf discriminants inside arrays and nullable object branches", () => {
    const union = z.discriminatedUnion("type", [
      z.strictObject({
        type: z.literal("file"),
        excerpt: z.string().optional(),
        note: z.string().nullable(),
      }),
      z.strictObject({
        type: z.literal("run"),
        passed: z.number().optional(),
        note: z.string().nullable(),
      }),
    ]);
    const schema = z.strictObject({ items: z.array(union), entry: union.nullable() });
    const value = {
      items: [
        { type: "file", excerpt: null, note: null },
        { type: "run", passed: null, note: null },
      ],
      entry: { type: "run", passed: null, note: null },
    };
    expect(schema.parse(normalizeOptionalNulls(value, z.toJSONSchema(schema)))).toEqual({
      items: [
        { type: "file", note: null },
        { type: "run", note: null },
      ],
      entry: { type: "run", note: null },
    });
    expect(normalizeOptionalNulls({ items: [], entry: null }, z.toJSONSchema(schema))).toEqual({
      items: [],
      entry: null,
    });
  });

  it("normalizes oneOf branches selected by literal values", () => {
    const schema = {
      oneOf: [
        {
          type: "object",
          properties: { tag: { const: "file" }, optional: { type: "string" } },
          required: ["tag"],
        },
        {
          type: "object",
          properties: { tag: { const: "run" }, optional: { type: ["string", "null"] } },
          required: ["tag", "optional"],
        },
      ],
    };
    expect(normalizeOptionalNulls({ tag: "file", optional: null }, schema)).toEqual({
      tag: "file",
    });
    expect(normalizeOptionalNulls({ tag: "run", optional: null }, schema)).toEqual({
      tag: "run",
      optional: null,
    });
  });

  it("selects object union branches by required fields and strict property shapes", () => {
    const schema = z.union([
      z.strictObject({ file: z.string(), excerpt: z.string().optional() }),
      z.strictObject({ run: z.string(), passed: z.number().optional() }),
    ]);
    expect(
      schema.parse(
        normalizeOptionalNulls({ file: "src/example.ts", excerpt: null }, z.toJSONSchema(schema)),
      ),
    ).toEqual({ file: "src/example.ts" });
    const optionalBranches = z.union([
      z.strictObject({ excerpt: z.string().optional() }),
      z.strictObject({ passed: z.number().optional() }),
    ]);
    expect(
      optionalBranches.parse(
        normalizeOptionalNulls({ excerpt: null }, z.toJSONSchema(optionalBranches)),
      ),
    ).toEqual({});
  });

  it("selects array union branches using element discriminants", () => {
    const schema = z.union([
      z.array(z.strictObject({ type: z.literal("file"), excerpt: z.string().optional() })),
      z.array(z.strictObject({ type: z.literal("run"), passed: z.number().optional() })),
    ]);
    expect(
      schema.parse(
        normalizeOptionalNulls([{ type: "file", excerpt: null }], z.toJSONSchema(schema)),
      ),
    ).toEqual([{ type: "file" }]);
    expect(
      schema.parse(normalizeOptionalNulls([{ type: "run", passed: null }], z.toJSONSchema(schema))),
    ).toEqual([{ type: "run" }]);
  });

  it("leaves ambiguous or unmatched union branches to Zod", () => {
    const schema = z.union([
      z.strictObject({ value: z.string().optional() }),
      z.strictObject({ value: z.string().nullable() }),
    ]);
    expect(normalizeOptionalNulls({ value: null }, z.toJSONSchema(schema))).toEqual({
      value: null,
    });
    expect(
      normalizeOptionalNulls(
        { tag: "unknown", optional: null },
        {
          anyOf: [
            {
              properties: { tag: { const: "known" }, optional: { type: "string" } },
              required: ["tag"],
            },
          ],
        },
      ),
    ).toEqual({ tag: "unknown", optional: null });
  });

  it("handles tuples and locally referenced recursive Zod schemas", () => {
    const entry = z.strictObject({
      optional: z.string().optional(),
      required: z.string().nullable(),
    });
    const tuple = z.tuple([entry, z.string().nullable()]);
    expect(
      tuple.parse(
        normalizeOptionalNulls([{ optional: null, required: null }, null], z.toJSONSchema(tuple)),
      ),
    ).toEqual([{ required: null }, null]);
    const recursive = z.strictObject({
      optional: z.string().optional(),
      get next(): z.ZodNullable<typeof recursive> {
        return recursive.nullable();
      },
    });
    const value = { optional: null, next: { optional: null, next: null } };
    expect(recursive.parse(normalizeOptionalNulls(value, z.toJSONSchema(recursive)))).toEqual({
      next: { next: null },
    });
  });

  it("resolves $defs pointers without treating unknown null keys as optional", () => {
    const schema = {
      $defs: {
        "entry/type": {
          type: "object",
          properties: { optional: { type: "string" }, required: { type: "null" } },
          required: ["required"],
        },
      },
      type: "array",
      items: { $ref: "#/$defs/entry~1type" },
    };
    expect(
      normalizeOptionalNulls([{ optional: null, required: null, unknown: null }], schema),
    ).toEqual([{ required: null, unknown: null }]);
  });

  it("preserves values and invalid required nulls for validation", () => {
    const schema = z.strictObject({ required: z.string(), optional: z.string().optional() });
    const value = { required: null, optional: "value", unknown: null };
    const normalized = normalizeOptionalNulls(value, z.toJSONSchema(schema));
    expect(normalized).toEqual(value);
    expect(schema.safeParse(normalized).success).toBe(false);
    expect(normalizeOptionalNulls(null, z.toJSONSchema(schema))).toBeNull();
  });
});

describe("provider schema round trip", () => {
  type JsonSchema = Record<string, unknown>;

  function isSchemaObject(value: unknown): value is JsonSchema {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * What the provider is forced to emit (SK-207 B1): every property present, the ones the original
   * schema left optional filled with null. Union branches are chosen by the value's `type`
   * literal, which is how the provider's schema distinguishes them.
   */
  function providerShaped(value: unknown, schema: JsonSchema): unknown {
    const branches = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(branches)) {
      const match = branches.find(
        (branch) => isSchemaObject(branch) && branchMatches(value, branch),
      );
      return providerShaped(value, isSchemaObject(match) ? match : {});
    }
    if (Array.isArray(value)) {
      const item = isSchemaObject(schema.items) ? schema.items : {};
      return value.map((entry) => providerShaped(entry, item));
    }
    if (value === null || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const properties = isSchemaObject(schema.properties) ? schema.properties : null;
    if (properties === null) return value;
    const shaped: Record<string, unknown> = {};
    for (const [key, property] of Object.entries(properties)) {
      const child = isSchemaObject(property) ? property : {};
      shaped[key] = Object.hasOwn(record, key) ? providerShaped(record[key], child) : null;
    }
    return shaped;
  }

  /** A union branch matches when its `type` const/enum agrees with the value's, if it has one. */
  function branchMatches(value: unknown, branch: JsonSchema): boolean {
    if (!isSchemaObject(value) || !isSchemaObject(branch.properties)) return false;
    const type = isSchemaObject(branch.properties.type) ? branch.properties.type : {};
    if (typeof type.const === "string") return value.type === type.const;
    return true;
  }

  function roundTrip<T>(schema: z.ZodType<T>, value: T): unknown {
    const original = z.toJSONSchema(schema) as JsonSchema;
    const transformed = toCodexOutputSchema(original);
    // The transform is what the provider sees; the value below is what it would send back.
    expect(transformed).not.toBe(original);
    const provided = providerShaped(value, original);
    return schema.parse(normalizeOptionalNulls(provided, original));
  }

  it("round-trips a Plan through the provider schema and back to Zod", () => {
    const plan = PlanSchema.parse({
      schema: "skep.plan/v1",
      task_id: "T-20261005-0001",
      version: 1,
      parent_version: null,
      base: { repo: "git@example.invalid:example/app.git", branch: "main", commit: "a".repeat(40) },
      mode: "solo",
      summary: "Ship the example change.",
      items: [
        {
          id: "W1",
          title: "Implement W1",
          details: "Touch only the example path.",
          role: "coding",
          assignee: "vps.coding",
          depends_on: [],
          touches: ["src/w1/"],
          risk: "normal",
          acceptance: [{ kind: "check", name: "unit" }],
        },
      ],
      stack_order: ["W1"],
      changes_from_parent: null,
    });
    expect(roundTrip(PlanSchema, plan)).toEqual(plan);
  });

  it("round-trips a Review, keeping a required null and dropping optional ones", () => {
    const review = ReviewSchema.parse({
      schema: "skep.review/v1",
      plan_version: 1,
      plan_hash: `sha256:${"0".repeat(64)}`,
      verdict: "block",
      blockers: [
        {
          id: "B1",
          claim: "The check does not cover the changed path.",
          evidence: [
            {
              id: "ev_1",
              type: "file_span",
              repo: "git@example.invalid:example/app.git",
              commit: "b".repeat(40),
              path: "src/w1/index.ts",
              lines: [1, 4],
              sha256: "c".repeat(64),
              excerpt: "const example = 1;",
            },
          ],
        },
      ],
      suggestions: [],
    });
    expect(roundTrip(ReviewSchema, review)).toEqual(review);
  });

  it("round-trips a WorkReport through the provider schema and back to Zod", () => {
    const report = WorkReportSchema.parse({
      schema: "skep.work_report/v1",
      summary: "Implemented the example item.",
      files_intended: ["src/w1/index.ts"],
      concerns: [],
      replan_request: null,
    });
    expect(roundTrip(WorkReportSchema, report)).toEqual(report);
  });

  it("still rejects a required null and an unknown key after normalization", () => {
    const schema = z.strictObject({ required: z.string(), optional: z.string().optional() });
    const original = z.toJSONSchema(schema) as JsonSchema;
    const normalized = normalizeOptionalNulls(
      { required: null, optional: null, unknown: null },
      original,
    );
    expect(schema.safeParse(normalized).success).toBe(false);
    // The transform really does demand the optional key, which is what produced the null.
    const transformed = toCodexOutputSchema(original);
    const properties = transformed.properties as Record<string, unknown>;
    expect(transformed.required).toEqual(expect.arrayContaining(["required", "optional"]));
    expect(JSON.stringify(properties.optional)).toContain('"type":"null"');
  });
});

describe("runStructured", () => {
  const schema = z.strictObject({ summary: z.string() });

  it("generates the original JSON schema, validates fenced output, and preserves result metadata", async () => {
    const result = completed('```json\n{"summary":"Example"}\n```');
    const { adapter, invoke } = scripted(result);
    const inv = invocation();
    const output = await runStructured(adapter, inv, schema);
    expect(output).toEqual({ ok: true, value: { summary: "Example" }, result });
    expect(invoke).toHaveBeenCalledExactlyOnceWith({
      ...inv,
      outputSchema: z.toJSONSchema(schema),
    });
    expect(inv.outputSchema).toEqual({ ignored: true });
  });

  it.each(["No JSON", '{"summary":3}', '{"summary":"Example","unexpected":true}'])(
    "repairs malformed or schema-invalid output exactly once: %s",
    async (message) => {
      const repaired = completed({ summary: "Repaired" });
      const { adapter, invoke } = scripted(completed(message), repaired);
      const inv = invocation();
      const output = await runStructured(adapter, inv, schema);
      expect(output).toEqual({ ok: true, value: { summary: "Repaired" }, result: repaired });
      expect(invoke).toHaveBeenCalledTimes(2);
      const repair = invoke.mock.calls[1]?.[0];
      expect(repair).toMatchObject({
        ...inv,
        kind: "repair",
        outputSchema: z.toJSONSchema(schema),
        prompt: expect.any(String),
      });
      expect(repair?.signal).toBe(inv.signal);
      expect(repair?.prompt).toContain("Validator errors");
      expect(repair?.prompt).toContain(JSON.stringify(message));
      expect(repair?.prompt).toContain(inv.prompt);
      expect(repair?.prompt).toContain(
        message === "No JSON" ? "No complete JSON object" : "summary",
      );
    },
  );

  it.each([null, "still not JSON", '{"summary":false}'])(
    "returns invalid_output after the sole repair also fails: %s",
    async (message) => {
      const second = completed(message, { finalMessage: message });
      const { adapter, invoke } = scripted(completed("invalid"), second);
      expect(await runStructured(adapter, invocation(), schema)).toEqual({
        ok: false,
        error: "invalid_output",
        result: second,
      });
      expect(invoke.mock.calls.map(([inv]) => inv.kind)).toEqual(["work", "repair"]);
    },
  );

  it("repairs a missing final message once", async () => {
    const { adapter, invoke } = scripted(
      completed(null, { finalMessage: null }),
      completed({ summary: "Repaired" }),
    );
    expect((await runStructured(adapter, invocation(), schema)).ok).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("does not repair a repair invocation recursively", async () => {
    const result = completed("invalid");
    const { adapter, invoke } = scripted(result);
    expect(await runStructured(adapter, invocation({ kind: "repair" }), schema)).toEqual({
      ok: false,
      error: "invalid_output",
      result,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each<InvocationOutcome>(["interrupted", "killed", "timeout", "permission_prompt", "unknown"])(
    "does not repair a %s invocation even with valid JSON",
    async (outcome) => {
      const result = completed({ summary: "Example" }, { outcome });
      const { adapter, invoke } = scripted(result);
      expect(await runStructured(adapter, invocation(), schema)).toEqual({
        ok: false,
        error: outcome,
        result,
      });
      expect(invoke).toHaveBeenCalledTimes(1);
    },
  );

  it("classifies non-zero completed exits as crashes without repair", async () => {
    const result = completed({ summary: "Example" }, { exitCode: 1 });
    const { adapter, invoke } = scripted(result);
    expect(await runStructured(adapter, invocation(), schema)).toEqual({
      ok: false,
      error: "crash",
      result,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("returns a repair process failure without another repair", async () => {
    const result = completed(null, { outcome: "permission_prompt", finalMessage: null });
    const { adapter, invoke } = scripted(completed("invalid"), result);
    expect(await runStructured(adapter, invocation(), schema)).toEqual({
      ok: false,
      error: "permission_prompt",
      result,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("honors an abort between completion and validation without repair", async () => {
    const controller = new AbortController();
    const { adapter, invoke } = scripted(completed("invalid"));
    invoke.mockImplementationOnce(async () => {
      controller.abort();
      return completed("invalid");
    });
    expect(
      await runStructured(adapter, invocation({ signal: controller.signal }), schema),
    ).toMatchObject({ ok: false, error: "interrupted" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("normalizes optional nulls using the original schema even if the adapter transforms its copy", async () => {
    const original = z.strictObject({
      required: z.string().nullable(),
      optional: z.string().optional(),
    });
    const { adapter, invoke } = scripted();
    invoke.mockImplementationOnce(async (inv) => {
      inv.outputSchema.required = ["required", "optional"];
      return completed({ required: null, optional: null });
    });
    expect(await runStructured(adapter, invocation(), original)).toMatchObject({
      ok: true,
      value: { required: null },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("normalizes a repair response before Zod validation", async () => {
    const original = z.strictObject({
      required: z.string().nullable(),
      optional: z.string().optional(),
    });
    const { adapter, invoke } = scripted(
      completed({ required: 3 }),
      completed({ required: null, optional: null }),
    );
    expect(await runStructured(adapter, invocation(), original)).toMatchObject({
      ok: true,
      value: { required: null },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps required nulls and unknown keys invalid instead of bypassing Zod", async () => {
    const original = z.strictObject({ required: z.string(), optional: z.string().optional() });
    const { adapter, invoke } = scripted(
      completed({ required: null, optional: null, unknown: null }),
      completed({ required: null, optional: null, unknown: null }),
    );
    expect(await runStructured(adapter, invocation(), original)).toMatchObject({
      ok: false,
      error: "invalid_output",
    });
    expect(invoke.mock.calls[1]?.[0].prompt).toContain("unrecognized_keys");
    expect(invoke.mock.calls[1]?.[0].prompt).toContain("invalid_type");
  });

  it("retains Zod refinements as the validation authority", async () => {
    const refined = z
      .strictObject({ summary: z.string() })
      .refine((value) => value.summary === "Accepted", { message: "Summary must be Accepted." });
    const { adapter, invoke } = scripted(
      completed({ summary: "Rejected" }),
      completed({ summary: "Accepted" }),
    );
    expect(await runStructured(adapter, invocation(), refined)).toMatchObject({
      ok: true,
      value: { summary: "Accepted" },
    });
    expect(invoke.mock.calls[1]?.[0].prompt).toContain("Summary must be Accepted.");
  });

  it("propagates adapter exceptions without hiding them as invalid output", async () => {
    const { adapter, invoke } = scripted();
    const failure = new Error("Adapter cannot start.");
    invoke.mockRejectedValueOnce(failure);
    await expect(runStructured(adapter, invocation(), schema)).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("normalizes originally optional fields in the actual plan schema", async () => {
    const fake = new FakeAdapter({
      clock: new FakeClock(new VirtualTime()),
      seed: 1,
      scripts: { plan: { kind: "success" } },
    });
    const generated = await runStructured(fake, invocation({ kind: "plan" }), PlanSchema);
    if (!generated.ok) throw new Error("Expected a valid fake plan.");
    const value = {
      ...generated.value,
      items: generated.value.items.map((item) => ({ ...item, details: null, requires: null })),
    };
    const { adapter, invoke } = scripted(completed(value));
    expect(await runStructured(adapter, invocation({ kind: "plan" }), PlanSchema)).toMatchObject({
      ok: true,
      value: generated.value,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("normalizes evidence union optionals in actual review and work-report schemas", async () => {
    const evidence = {
      id: "ev_1",
      type: "check_run",
      run_id: "run_1",
      check: "unit",
      sha: "a".repeat(40),
      exit: 1,
      log_sha256: "0".repeat(64),
      passed: null,
      failed: null,
    };
    const review = {
      schema: "skep.review/v1",
      plan_version: 1,
      plan_hash: `sha256:${"0".repeat(64)}`,
      verdict: "block",
      blockers: [{ id: "B1", claim: "Check failed.", acceptance_gap: null, evidence: [evidence] }],
      suggestions: [],
    };
    const work = {
      schema: "skep.work_report/v1",
      summary: "Check failed.",
      files_intended: [],
      concerns: [],
      replan_request: { summary: "Revise the plan.", evidence: [evidence] },
    };
    const first = scripted(completed(review));
    const second = scripted(completed(work));
    const reviewed = await runStructured(
      first.adapter,
      invocation({ kind: "review" }),
      ReviewSchema,
    );
    const worked = await runStructured(second.adapter, invocation(), WorkReportSchema);
    expect(reviewed.ok).toBe(true);
    expect(worked.ok).toBe(true);
    if (reviewed.ok) expect(reviewed.value.blockers[0]).not.toHaveProperty("acceptance_gap");
    if (worked.ok) expect(worked.value.replan_request?.evidence[0]).not.toHaveProperty("passed");
    expect(first.invoke).toHaveBeenCalledTimes(1);
    expect(second.invoke).toHaveBeenCalledTimes(1);
  });
});
