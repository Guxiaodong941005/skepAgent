function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * B1/SK-307: strict generation requires nullable optional properties. Remove those placeholders
 * before original Zod validation, retaining required nulls and unknown keys for Zod to reject.
 */
export function normalizeOptionalNulls(
  value: unknown,
  outputSchema: Record<string, unknown>,
): unknown {
  const resolve = (schema: Record<string, unknown>): Record<string, unknown> => {
    const seen = new Set<string>();
    while (
      typeof schema.$ref === "string" &&
      schema.$ref.startsWith("#/") &&
      !seen.has(schema.$ref)
    ) {
      seen.add(schema.$ref);
      let target: unknown = outputSchema;
      for (const segment of schema.$ref.slice(2).split("/")) {
        target = record(target)?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
      }
      const resolved = record(target);
      if (!resolved) break;
      schema = { ...schema, ...resolved };
      if (resolved.$ref === undefined) delete schema.$ref;
    }
    return schema;
  };

  const matches = (data: unknown, input: Record<string, unknown>): boolean => {
    const schema = resolve(input);
    if (Object.hasOwn(schema, "const") && schema.const !== data) return false;
    if (Array.isArray(schema.enum) && !schema.enum.includes(data)) return false;
    const types = Array.isArray(schema.type)
      ? schema.type
      : schema.type === undefined
        ? []
        : [schema.type];
    if (
      types.length > 0 &&
      !types.some((type) => {
        if (type === "null") return data === null;
        if (type === "object") return record(data) !== null;
        if (type === "array") return Array.isArray(data);
        if (type === "integer") return typeof data === "number" && Number.isInteger(data);
        if (type === "number") return typeof data === "number";
        return typeof data === type;
      })
    )
      return false;
    const properties = record(schema.properties);
    const object = record(data);
    // Literal discriminators identify the evidence/acceptance variant without validating it.
    return (
      !properties ||
      !object ||
      Object.entries(properties).every(([key, property]) => {
        const child = record(property);
        return (
          !child ||
          !Object.hasOwn(object, key) ||
          (!Object.hasOwn(child, "const") && !Array.isArray(child.enum)) ||
          matches(object[key], child)
        );
      })
    );
  };

  const normalize = (data: unknown, input: unknown): unknown => {
    const original = record(input);
    if (!original) return data;
    const schema = resolve(original);
    const alternatives = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(alternatives)) {
      const candidates = alternatives
        .map(record)
        .filter((candidate) => candidate !== null && matches(data, candidate));
      const normalized = candidates.map((candidate) => normalize(data, candidate));
      if (normalized.length === 1) data = normalized[0];
      else if (
        normalized.length > 1 &&
        normalized.every((candidate) => JSON.stringify(candidate) === JSON.stringify(normalized[0]))
      ) {
        data = normalized[0];
      }
      // Ambiguous unions are left intact: normalization must never guess away required values.
    }
    if (Array.isArray(data)) {
      const prefix = schema.prefixItems ?? (Array.isArray(schema.items) ? schema.items : []);
      const rest = Array.isArray(schema.items) ? schema.additionalItems : schema.items;
      return data.map((element, index) =>
        normalize(element, Array.isArray(prefix) && index < prefix.length ? prefix[index] : rest),
      );
    }
    const object = record(data);
    const properties = record(schema.properties);
    if (!object || !properties) return data;
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    return Object.fromEntries(
      Object.entries(object).flatMap(([key, element]) => {
        if (!Object.hasOwn(properties, key)) return [[key, element]];
        if (element === null && !required.has(key)) return [];
        return [[key, normalize(element, properties[key])]];
      }),
    );
  };
  return normalize(value, outputSchema);
}
