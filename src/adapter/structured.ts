import { z } from "zod";
import { buildRepairPrompt } from "./prompts.js";
import type { AdapterInvocation, AdapterResult, AgentAdapter } from "./types.js";

type JsonSchema = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Last complete JSON object, with balanced containers and JSON string escaping (§9.3). Top-level
 * arrays are ignored on purpose: every model-facing schema is an object.
 *
 * A stray unmatched `{` in prose before the object would leave the container stack never empty,
 * so the forward scan alone misses it (SK-307 review note 1). When that happens, the fallback
 * parses from each `{` up to each later `}` and keeps the last object that parses.
 */
export function extractJson(text: string): unknown | null {
  return scanObjects(text) ?? scanAfterStrayBrace(text);
}

/** Forward balanced-container scan. Returns the last object, or null when none closes cleanly. */
function scanObjects(text: string): unknown | null {
  const stack: string[] = [];
  let start = 0;
  let inString = false;
  let escaped = false;
  let last: unknown = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      if (stack.length === 0) start = i;
      stack.push(char);
    } else if (char === "}" || char === "]") {
      if (stack.at(-1) !== (char === "}" ? "{" : "[")) {
        stack.length = 0;
        continue;
      }
      stack.pop();
      if (stack.length !== 0) continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        if (isObject(value)) last = value;
      } catch (error) {
        // Balanced prose or malformed JSON is not an object; later candidates may still be JSON.
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return last;
}

/**
 * Fallback for a stray unmatched `{` ahead of the real object (SK-307 review note 1). Only runs
 * when the forward scan found nothing, so the common path stays one pass. Later candidates
 * overwrite earlier ones, so the last object wins, matching the forward scan.
 */
function scanAfterStrayBrace(text: string): unknown | null {
  // The stray `{` is never closed, so no `}` returns the stack to empty. Any `}` can end the
  // object; the parse attempt decides. Braces inside strings or inside a top-level array are not
  // candidates: the schemas are objects, and an array wrapping one must stay invisible exactly as
  // the forward scan leaves it.
  const skipped = nonCandidateBraces(text);
  let last: unknown = null;
  for (let end = 0; end < text.length; end++) {
    if (text[end] !== "}" || skipped.has(end)) continue;
    // The nearest `{` that parses wins for this `}`; a later `}` then overwrites it.
    for (let start = end; start >= 0; start--) {
      if (text[start] !== "{" || skipped.has(start)) continue;
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (isObject(value)) last = value;
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return last;
}

/**
 * Positions of `{` and `}` the fallback must not treat as object boundaries: those inside JSON
 * strings, and those nested in a `[...]` that is not itself inside an object.
 *
 * A `"` only opens a string when a structural token precedes it. A quoted word in prose is not
 * one, or the fallback would hide the object that follows it.
 */
function nonCandidateBraces(text: string): Set<number> {
  const skipped = new Set<number>();
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let structural = true;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      else if (char === "{" || char === "}") skipped.add(i);
      continue;
    }
    if (char === '"' && structural) {
      inString = true;
      structural = false;
    } else if ("{[ ,:".includes(char)) {
      structural = true;
    } else if (char.trim() !== "") {
      structural = false;
    }
    if ((char === "{" || char === "}") && stack.includes("[")) skipped.add(i);
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.at(-1) === (char === "}" ? "{" : "[")) stack.pop();
      else stack.length = 0;
    }
  }
  return skipped;
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((candidate) => matchesType(value, candidate));
  switch (type) {
    case "null":
      return value === null;
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    default:
      return true;
  }
}

/** Resolve only local references from the original schema, without fetching schema resources. */
function resolveSchema(node: unknown, root: JsonSchema): JsonSchema | null {
  if (!isObject(node)) return null;
  let resolved = node;
  const seen = new Set<string>();
  while (typeof resolved.$ref === "string" && !seen.has(resolved.$ref)) {
    const ref = resolved.$ref;
    if (ref !== "#" && !ref.startsWith("#/")) break;
    seen.add(ref);
    let target: unknown = root;
    for (const token of ref === "#" ? [] : ref.slice(2).split("/")) {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      target = isObject(target) && Object.hasOwn(target, key) ? target[key] : undefined;
    }
    if (!isObject(target)) break;
    const { $ref: _ref, ...siblings } = resolved;
    resolved = { ...target, ...siblings };
  }
  return resolved;
}

/** Only narrow branches using shape/literal discriminants; this is not JSON Schema validation. */
function couldMatch(value: unknown, node: JsonSchema, root: JsonSchema): boolean {
  const schema = resolveSchema(node, root) ?? node;
  if (!matchesType(value, schema.type)) return false;
  if (Object.hasOwn(schema, "const") && schema.const !== value) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (isObject(value) && isObject(schema.properties)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key === "string" && !Object.hasOwn(value, key))) {
      return false;
    }
    if (
      schema.additionalProperties === false &&
      Object.keys(value).some((key) => !Object.hasOwn(schema.properties as JsonSchema, key))
    ) {
      return false;
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key) || !isObject(property)) continue;
      // An optional null is the provider's placeholder, not a discriminating value.
      if (value[key] === null && !required.includes(key)) continue;
      if (!couldMatch(value[key], property, root)) return false;
    }
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item =
        Array.isArray(schema.prefixItems) && index < schema.prefixItems.length
          ? schema.prefixItems[index]
          : schema.items;
      if (isObject(item) && !couldMatch(value[index], item, root)) return false;
    }
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    const branches = schema[keyword];
    if (
      Array.isArray(branches) &&
      !branches.some((s) => isObject(s) && couldMatch(value, s, root))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Undo the provider's required-but-nullable placeholders using the ORIGINAL schema (SK-207 B1).
 * Required nulls and ambiguous unions are retained. Zod remains the sole validation authority.
 */
export function normalizeOptionalNulls(value: unknown, schema: JsonSchema): unknown {
  function walk(current: unknown, input: unknown): unknown {
    const node = resolveSchema(input, schema);
    if (node === null) return current;
    let normalized = current;
    if (isObject(current) && isObject(node.properties)) {
      const required = Array.isArray(node.required) ? node.required : [];
      normalized = Object.fromEntries(
        Object.entries(current).flatMap(([key, entry]) => {
          const property = Object.hasOwn(node.properties as JsonSchema, key)
            ? (node.properties as JsonSchema)[key]
            : undefined;
          if (property !== undefined && entry === null && !required.includes(key)) return [];
          return [[key, walk(entry, property)]];
        }),
      );
    } else if (Array.isArray(current)) {
      normalized = current.map((entry, index) => {
        const item =
          Array.isArray(node.prefixItems) && index < node.prefixItems.length
            ? node.prefixItems[index]
            : node.items;
        return walk(entry, item);
      });
    }
    for (const keyword of ["anyOf", "oneOf"]) {
      const branches = node[keyword];
      if (!Array.isArray(branches)) continue;
      const candidates = branches.filter((s) => isObject(s) && couldMatch(normalized, s, schema));
      if (candidates.length === 1) normalized = walk(normalized, candidates[0]);
    }
    return normalized;
  }
  return walk(value, schema);
}

export type StructuredResult<T> =
  | { ok: true; value: T; result: AdapterResult }
  | { ok: false; error: string; result: AdapterResult };

function invocationError(result: AdapterResult, signal: AbortSignal): string | null {
  if (result.outcome !== "completed") return result.outcome;
  if (result.exitCode !== 0) return "crash";
  if (signal.aborted) return "interrupted";
  return null;
}

function validate<T>(message: string | null, schema: z.ZodType<T>, outputSchema: JsonSchema) {
  const extracted = message === null ? null : extractJson(message);
  if (extracted === null) {
    return { ok: false as const, errors: "No complete JSON object found in the final message." };
  }
  const parsed = schema.safeParse(normalizeOptionalNulls(extracted, outputSchema));
  return parsed.success
    ? { ok: true as const, value: parsed.data }
    : { ok: false as const, errors: JSON.stringify(parsed.error.issues, null, 2) };
}

/** Run, validate, then repair once; process failures never consume a JSON repair (§9.3). */
export async function runStructured<T>(
  adapter: AgentAdapter,
  inv: AdapterInvocation,
  schema: z.ZodType<T>,
): Promise<StructuredResult<T>> {
  const outputSchema = z.toJSONSchema(schema);
  // Adapters may transform their copy for the provider; normalization always uses the original.
  const first = await adapter.invoke({ ...inv, outputSchema: structuredClone(outputSchema) });
  const firstError = invocationError(first, inv.signal);
  if (firstError !== null) return { ok: false, error: firstError, result: first };
  const validated = validate(first.finalMessage, schema, outputSchema);
  if (validated.ok) return { ok: true, value: validated.value, result: first };
  if (inv.kind === "repair") return { ok: false, error: "invalid_output", result: first };

  const repaired = await adapter.invoke({
    ...inv,
    kind: "repair",
    outputSchema: structuredClone(outputSchema),
    prompt: buildRepairPrompt({
      originalPrompt: inv.prompt,
      finalMessage: first.finalMessage,
      validationErrors: validated.errors,
      outputSchema,
    }),
  });
  const repairError = invocationError(repaired, inv.signal);
  if (repairError !== null) return { ok: false, error: repairError, result: repaired };
  const final = validate(repaired.finalMessage, schema, outputSchema);
  return final.ok
    ? { ok: true, value: final.value, result: repaired }
    : { ok: false, error: "invalid_output", result: repaired };
}
