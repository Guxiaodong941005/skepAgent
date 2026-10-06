import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  isMap,
  isScalar,
  LineCounter,
  parseDocument,
  type SchemaOptions,
  type YAMLError,
} from "yaml";
import { type AgentMdFrontMatter, AgentMdFrontMatterSchema } from "../core/schemas/config.js";
import { ConfigError, validateConfig } from "./errors.js";

export interface AgentMd {
  frontMatter: AgentMdFrontMatter;
  /** English instructions for the model: everything after the front-matter, trimmed. */
  body: string;
  file: string;
}

/**
 * AGENT.md is trusted local policy read from the role directory, never from a worktree
 * (PRD §7.1, §7.3). Front-matter is YAML between the opening `---` line and the next `---` line;
 * the body is handed to the model verbatim apart from surrounding whitespace.
 *
 * Stricter than the brief: parser warnings (unresolved custom tags, for example) are fatal, not
 * just errors, so a front-matter cannot silently degrade into plain text.
 */
export function parseAgentMd(text: string, file: string): AgentMd {
  const split = splitFrontMatter(text, file);
  return {
    frontMatter: parseFrontMatter(split.yaml, file, split.yamlStartsAt),
    body: split.body,
    file,
  };
}

/** Read `<roleDir>/AGENT.md` (PRD §7.1). */
export async function loadAgentMd(roleDir: string): Promise<AgentMd> {
  const file = path.join(roleDir, "AGENT.md");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new ConfigError(file, null, error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  return parseAgentMd(text, file);
}

interface FrontMatterSplit {
  /** YAML text of the front-matter, without the `---` fences. */
  yaml: string;
  /** Added to a parser-relative line (1 = its first line) to reach the file line. */
  yamlStartsAt: number;
  body: string;
}

/**
 * The core schema rejects YAML 1.1 tricks (binary, merge keys, omap) and custom tags fail
 * resolution, so a front-matter cannot smuggle a type past the Zod schema (PRD §11.5).
 */
const YAML_OPTIONS: SchemaOptions = { schema: "core", customTags: [] };

function splitFrontMatter(text: string, file: string): FrontMatterSplit {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    throw new ConfigError(file, 1, "AGENT.md must start with a YAML front-matter block (---)");
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    throw new ConfigError(
      file,
      null,
      "AGENT.md front-matter is unterminated (missing closing ---)",
    );
  }
  // Trimmed for the non-empty check, but otherwise the bytes the model will see.
  const body = lines
    .slice(close + 1)
    .join("\n")
    .trim();
  if (body === "") {
    throw new ConfigError(file, close + 2, "AGENT.md body must not be empty");
  }
  return { yaml: lines.slice(1, close).join("\n"), yamlStartsAt: 1, body };
}

function parseFrontMatter(yaml: string, file: string, yamlStartsAt: number): AgentMdFrontMatter {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yaml, { ...YAML_OPTIONS, lineCounter });
  const problems = [...doc.errors, ...doc.warnings];
  const first = problems[0];
  if (first !== undefined) {
    throw new ConfigError(
      file,
      fileLine(first, lineCounter, yamlStartsAt),
      firstLine(first.message),
      {
        cause: first,
      },
    );
  }
  if (!isPlainMapping(doc.contents)) {
    throw new ConfigError(file, yamlStartsAt + 1, "AGENT.md front-matter must be a YAML mapping");
  }
  return validateConfig(AgentMdFrontMatterSchema, doc.toJS(), file);
}

/** A mapping whose keys are plain strings — aliases and tagged nodes are refused. */
function isPlainMapping(contents: unknown): boolean {
  if (!isMap(contents)) return false;
  return contents.items.every((pair) => {
    const key = pair.key;
    // `source === value` rejects tagged keys (`!!str name`), whose source includes the tag.
    return isScalar(key) && typeof key.value === "string" && key.source === key.value;
  });
}

/** Map a parser error back to a 1-based line of the whole AGENT.md file. */
function fileLine(error: YAMLError, lineCounter: LineCounter, yamlStartsAt: number): number | null {
  const reported = error.linePos?.[0]?.line;
  const line =
    reported ?? (error.pos !== undefined ? lineCounter.linePos(error.pos[0]).line : undefined);
  return line === undefined ? null : line + yamlStartsAt;
}

function firstLine(message: string): string {
  const [head] = message.split("\n");
  return (head ?? message).trim();
}
