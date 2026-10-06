import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PlanSchema } from "../core/schemas/plan.js";
import { ReviewSchema } from "../core/schemas/review.js";
import { WorkReportSchema } from "../core/schemas/work-report.js";
import { CodexAdapterError, toCodexOutputSchema } from "./codex.js";

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
