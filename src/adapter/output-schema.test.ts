import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanSchema } from "../core/schemas/plan.js";
import { ReviewSchema } from "../core/schemas/review.js";
import { WorkReportSchema } from "../core/schemas/work-report.js";
import { CodexAdapterError, toCodexOutputSchema } from "./codex.js";
import { normalizeOptionalNulls } from "./output-schema.js";

const forbidden = new Set([
  "$schema",
  "$id",
  "oneOf",
  "const",
  "prefixItems",
  "additionalItems",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "unevaluatedProperties",
  "contains",
  "default",
  "examples",
  "readOnly",
  "writeOnly",
  "definitions",
]);

// Walk every schema node, including definitions and nested alternatives. Property names and
// enum literal contents are data, so names such as "pattern" are not forbidden keywords.
function checkProviderTree(node: Record<string, unknown>): void {
  for (const key of Object.keys(node)) expect(forbidden.has(key), key).toBe(false);
  if (node.type === "object" || node.properties !== undefined) {
    const properties = node.properties as Record<string, Record<string, unknown>>;
    expect(node.additionalProperties).toBe(false);
    expect(node.required).toEqual(Object.keys(properties));
    for (const child of Object.values(properties)) checkProviderTree(child);
  }
  for (const key of ["$defs"]) {
    if (node[key]) {
      for (const child of Object.values(node[key] as Record<string, Record<string, unknown>>)) {
        checkProviderTree(child);
      }
    }
  }
  if (node.items) {
    expect(Array.isArray(node.items)).toBe(false);
    expect(typeof node.items).toBe("object");
    checkProviderTree(node.items as Record<string, unknown>);
  }
  if (node.anyOf)
    for (const child of node.anyOf as Record<string, unknown>[]) checkProviderTree(child);
}

describe("toCodexOutputSchema (B1)", () => {
  it.each([
    ["WorkReport", WorkReportSchema],
    ["Plan", PlanSchema],
    ["Review", ReviewSchema],
  ] as const)(
    "transforms every node of the real %s schema without mutating it",
    (_name, schema) => {
      const original = z.toJSONSchema(schema);
      const snapshot = structuredClone(original);
      const converted = toCodexOutputSchema(original);
      checkProviderTree(converted);
      expect(converted.type).toBe("object");
      expect(original).toEqual(snapshot);
      expect(toCodexOutputSchema(converted)).toEqual(converted);
    },
  );

  it("requires and null-wraps optional properties while retaining required nullable values", () => {
    expect(
      toCodexOutputSchema({
        type: "object",
        additionalProperties: true,
        properties: {
          required: { type: ["string", "null"] },
          optional: { type: "string", pattern: "^example$", default: "example" },
        },
        required: ["required"],
      }),
    ).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["required", "optional"],
      properties: {
        required: { type: ["string", "null"] },
        optional: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
  });

  it("converts discriminated oneOf and constants without rewriting literal property names", () => {
    const transformed = toCodexOutputSchema({
      oneOf: [
        {
          type: "object",
          properties: { pattern: { const: "example", type: "string" } },
          required: ["pattern"],
        },
        { type: "null", const: null },
      ],
    });
    expect(transformed).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { pattern: { type: "string", enum: ["example"] } },
          required: ["pattern"],
          additionalProperties: false,
        },
        { type: "null", enum: [null] },
      ],
    });
    checkProviderTree(transformed);
  });

  it.each(["prefixItems", "items"])(
    "turns %s tuples into a homogeneous element union",
    (keyword) => {
      const schema = {
        type: "array",
        [keyword]: [
          { type: "integer", exclusiveMinimum: 0 },
          { type: "string", format: "date" },
        ],
        minItems: 2,
        maxItems: 2,
      };
      expect(toCodexOutputSchema(schema)).toEqual({
        type: "array",
        items: { anyOf: [{ type: "integer" }, { type: "string" }] },
      });
    },
  );

  it("retains rest element types and deduplicates identical tuple elements", () => {
    expect(
      toCodexOutputSchema({
        type: "array",
        prefixItems: [{ type: "integer" }, { type: "integer" }],
        items: { type: "boolean" },
      }),
    ).toEqual({ type: "array", items: { anyOf: [{ type: "integer" }, { type: "boolean" }] } });
    expect(
      toCodexOutputSchema({
        type: "array",
        prefixItems: [{ type: "integer" }, { type: "integer" }],
        items: false,
      }),
    ).toEqual({ type: "array", items: { type: "integer" } });
    expect(
      toCodexOutputSchema({
        type: "array",
        items: [{ type: "integer" }],
        additionalItems: { type: "boolean" },
      }),
    ).toEqual({ type: "array", items: { anyOf: [{ type: "integer" }, { type: "boolean" }] } });
  });

  it("uses a valid item schema for an empty tuple", () => {
    expect(toCodexOutputSchema({ type: "array", prefixItems: [], items: false })).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("transforms definitions and optional references, including recursive references", () => {
    const transformed = toCodexOutputSchema({
      type: "object",
      properties: { next: { $ref: "#/definitions/node" } },
      definitions: {
        node: { type: "object", properties: { next: { $ref: "#/definitions/node" } } },
      },
    });
    expect(transformed).toMatchObject({
      properties: { next: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] } },
      $defs: {
        node: {
          additionalProperties: false,
          required: ["next"],
          properties: { next: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] } },
        },
      },
    });
    checkProviderTree(transformed);
  });

  it("drops validation and annotation keywords at every schema level", () => {
    const transformed = toCodexOutputSchema({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      minProperties: 1,
      properties: {
        value: {
          type: "number",
          minimum: 0,
          maximum: 9,
          exclusiveMinimum: 0,
          exclusiveMaximum: 9,
          multipleOf: 0.5,
          default: 2,
        },
      },
      required: ["value"],
    });
    checkProviderTree(transformed);
    expect(transformed).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    });
  });

  it("throws a typed configuration error for an unsupported boolean property schema", () => {
    expect(() => toCodexOutputSchema({ type: "object", properties: { value: false } })).toThrow(
      CodexAdapterError,
    );
  });
});

const sha = "a".repeat(40);
const hash = "b".repeat(64);
const fileEvidence = {
  id: "ev_file",
  type: "file_span",
  repo: "git@example.com:owner/app.git",
  commit: sha,
  path: "src/example.ts",
  lines: [1, 2],
  sha256: hash,
  excerpt: null,
};
const checkEvidence = {
  id: "ev_check",
  type: "check_run",
  run_id: "example-run",
  check: "unit",
  sha,
  exit: 0,
  passed: null,
  failed: null,
  log_sha256: hash,
};
const plan = {
  schema: "skep.plan/v1",
  task_id: "T-20261006-abcd",
  version: 1,
  parent_version: null,
  base: { repo: "git@example.com:owner/app.git", branch: "main", commit: sha },
  mode: "solo",
  summary: "Example plan",
  items: [
    {
      id: "W1",
      title: "Example item",
      details: null,
      role: "coding",
      assignee: "vps.coding",
      depends_on: [],
      requires: null,
      touches: ["src/example.ts"],
      risk: "normal",
      acceptance: [{ kind: "manual", text: "Example behaviour works" }],
    },
  ],
  stack_order: ["W1"],
  changes_from_parent: null,
};

describe("normalizeOptionalNulls (SK-307 validation boundary)", () => {
  it("normalizes nested plan optional fields while retaining required nulls", () => {
    const original = structuredClone(plan);
    expect(PlanSchema.safeParse(plan).success).toBe(false);
    const normalized = normalizeOptionalNulls(plan, z.toJSONSchema(PlanSchema));
    const validated = PlanSchema.parse(normalized);
    expect(validated.items[0]).not.toHaveProperty("details");
    expect(validated.items[0]).not.toHaveProperty("requires");
    expect(validated.parent_version).toBeNull();
    expect(validated.changes_from_parent).toBeNull();
    expect(plan).toEqual(original);
  });

  it("normalizes WorkReport evidence through discriminated unions and tuples", () => {
    const value = {
      schema: "skep.work_report/v1",
      summary: "Example report",
      files_intended: [],
      concerns: [],
      replan_request: { summary: "Example mismatch", evidence: [fileEvidence, checkEvidence] },
    };
    const normalized = normalizeOptionalNulls(value, z.toJSONSchema(WorkReportSchema));
    const validated = WorkReportSchema.parse(normalized);
    expect(validated.replan_request?.evidence[0]).not.toHaveProperty("excerpt");
    expect(validated.replan_request?.evidence[1]).not.toHaveProperty("passed");
    expect(validated.replan_request?.evidence[1]).not.toHaveProperty("failed");
  });

  it("normalizes Review optional fields inside nested arrays and evidence variants", () => {
    const value = {
      schema: "skep.review/v1",
      plan_version: 1,
      plan_hash: `sha256:${hash}`,
      verdict: "block",
      blockers: [
        { id: "B1", claim: "Example gap", acceptance_gap: null, evidence: [fileEvidence] },
      ],
      suggestions: [],
    };
    const validated = ReviewSchema.parse(
      normalizeOptionalNulls(value, z.toJSONSchema(ReviewSchema)),
    );
    expect(validated.blockers[0]).not.toHaveProperty("acceptance_gap");
    expect(validated.blockers[0]?.evidence[0]).not.toHaveProperty("excerpt");
  });

  it("preserves required nulls, unknown null properties, and invalid scalar values for Zod", () => {
    const schema = z.strictObject({
      required: z.string(),
      optional: z.string().optional(),
      nullable: z.string().nullable(),
    });
    const value = { required: null, optional: null, nullable: null, unknown: null };
    expect(normalizeOptionalNulls(value, z.toJSONSchema(schema))).toEqual({
      required: null,
      nullable: null,
      unknown: null,
    });
    expect(schema.safeParse(normalizeOptionalNulls(value, z.toJSONSchema(schema))).success).toBe(
      false,
    );
  });

  it("does not weaken original Zod refinements or constraints dropped for generation", () => {
    const badPlan = { ...plan, stack_order: ["W2"] };
    expect(
      PlanSchema.safeParse(normalizeOptionalNulls(badPlan, z.toJSONSchema(PlanSchema))).success,
    ).toBe(false);
    const badReport = {
      schema: "skep.work_report/v1",
      summary: "",
      files_intended: [],
      concerns: [],
      replan_request: null,
    };
    expect(
      WorkReportSchema.safeParse(
        normalizeOptionalNulls(badReport, z.toJSONSchema(WorkReportSchema)),
      ).success,
    ).toBe(false);
  });

  it("walks tuple elements using their original schemas", () => {
    const schema = z.tuple([
      z.strictObject({ optional: z.string().optional() }),
      z.strictObject({ required: z.string().nullable() }),
    ]);
    const value = [{ optional: null }, { required: null }];
    const normalized = normalizeOptionalNulls(value, z.toJSONSchema(schema));
    expect(normalized).toEqual([{}, { required: null }]);
    expect(schema.safeParse(normalized).success).toBe(true);
    const legacy = {
      type: "array",
      items: [{ type: "string" }],
      additionalItems: { type: "object", properties: { optional: { type: "string" } } },
    };
    expect(normalizeOptionalNulls(["example", { optional: null }], legacy)).toEqual([
      "example",
      {},
    ]);
  });

  it("resolves recursive local references with escaped definition names", () => {
    const schema = {
      $ref: "#/$defs/example~1node~0",
      $defs: {
        "example/node~": {
          type: "object",
          properties: { next: { $ref: "#/$defs/example~1node~0" }, value: { type: "string" } },
          required: ["value"],
        },
      },
    };
    const value = { value: "example", next: { value: "example", next: null } };
    expect(normalizeOptionalNulls(value, schema)).toEqual({
      value: "example",
      next: { value: "example" },
    });
  });

  it("retains ambiguous optional-versus-required union values for Zod to decide", () => {
    const schema = {
      anyOf: [
        { type: "object", properties: { value: { type: "string" } }, required: [] },
        { type: "object", properties: { value: { type: "null" } }, required: ["value"] },
      ],
    };
    expect(normalizeOptionalNulls({ value: null }, schema)).toEqual({ value: null });
  });
});
