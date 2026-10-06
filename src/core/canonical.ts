import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit order, no insignificant whitespace,
 * arrays in order. Used for content hashes (plan_hash) and for byte-identical state comparison
 * across daemons (replay determinism invariant).
 *
 * Only JSON values are accepted: `undefined`, functions, symbols, bigint, non-finite numbers,
 * Maps/Sets and class instances other than plain objects/arrays throw.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, "$");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => serialize(v, `${path}[${i}]`)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: non-plain object at ${path}`);
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k], `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** `sha256:<hex>` of the canonical JSON of a value. Used for `plan_hash`. */
export function contentHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}
