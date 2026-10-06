import { parse as parseToml, TomlError } from "smol-toml";
import type { ZodError, ZodIssue, ZodType } from "zod";

/**
 * A device.toml / AGENT.md / checks.toml that could not be parsed or that fails its schema
 * (PRD §7.2, §7.3, §11.5). `line` is the 1-based source line for syntax errors and null for
 * schema errors, which name a dotted path instead.
 */
export class ConfigError extends Error {
  readonly file: string;
  readonly line: number | null;

  constructor(file: string, line: number | null, problem: string, options?: ErrorOptions) {
    super(line === null ? `${file}: ${problem}` : `${file}:${line}: ${problem}`, options);
    this.name = "ConfigError";
    this.file = file;
    this.line = line;
  }
}

/** `repos.0.name` — the shape the acceptance criteria require schema errors to name. */
function dottedPath(path: PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `.${segment}`;
    } else if (typeof segment === "string") {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out;
}

/**
 * One `<dotted.path>: <message>` line per Zod issue. The root path renders as `(root)` because an
 * empty path would leave a bare colon.
 */
export function formatZodIssues(error: ZodError): string {
  return error.issues.map((issue) => formatIssue(issue)).join("\n");
}

function formatIssue(issue: ZodIssue): string {
  const path = dottedPath(issue.path);
  return `${path === "" ? "(root)" : path}: ${issue.message}`;
}

/** TOML text → schema. Syntax errors carry the parser's 1-based line (PRD §11.5). */
export function parseTomlConfig<T>(schema: ZodType<T>, text: string, file: string): T {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) {
      throw new ConfigError(file, error.line, firstLine(error.message), { cause: error });
    }
    throw new ConfigError(file, null, error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  return validateConfig(schema, raw, file);
}

/** Schema check shared by every loader. Issues name their dotted path, one per line. */
export function validateConfig<T>(schema: ZodType<T>, raw: unknown, file: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(file, null, formatZodIssues(parsed.error), { cause: parsed.error });
  }
  return parsed.data;
}

function firstLine(message: string): string {
  const [head] = message.split("\n");
  return (head ?? message).trim();
}
