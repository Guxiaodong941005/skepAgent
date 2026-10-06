import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parsePrincipal } from "../core/principal.js";

export interface TrustEntry {
  principals: string[];
  namespaces: string[] | null;
  keyType: string;
  key: string;
  comment: string;
}

export class TrustRootError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TrustRootError";
  }
}

const KeyTypeSchema = z.string().regex(/^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._+-]+$/);
const KeySchema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/);

function tokenAt(text: string, offset: number): { token: string; end: number } {
  let end = offset;
  let quoted = false;
  while (end < text.length) {
    const ch = text[end];
    if (ch === "\\" && quoted && end + 1 < text.length) {
      end += 2;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && /\s/.test(ch ?? "")) break;
    end++;
  }
  if (quoted) throw new TrustRootError("unterminated quoted option");
  return { token: text.slice(offset, end), end };
}

function parseOptions(text: string): string[] | null {
  const options: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= text.length; i++) {
    if (text[i] === "\\" && quoted) {
      i++;
      continue;
    }
    if (text[i] === '"') quoted = !quoted;
    if (i === text.length || (text[i] === "," && !quoted)) {
      options.push(text.slice(start, i));
      start = i + 1;
    }
  }
  let namespaces: string[] | null = null;
  const seen = new Set<string>();
  for (const option of options) {
    const name = option.split("=", 1)[0] ?? "";
    if (seen.has(name)) throw new TrustRootError(`duplicate option ${name}`);
    seen.add(name);
    if (option === "cert-authority") continue;
    const match = /^(namespaces|valid-after|valid-before)="([^"\\]*)"$/.exec(option);
    if (!match) throw new TrustRootError(`invalid or unsupported option ${option}`);
    const value = match[2] ?? "";
    if (name === "namespaces") {
      namespaces = value.split(",");
      if (namespaces.some((ns) => ns.length === 0 || /\s/.test(ns))) {
        throw new TrustRootError("namespaces must contain nonempty patterns without whitespace");
      }
    } else if (!/^(?:\d{8}|\d{12}|\d{14})Z?$/.test(value)) {
      throw new TrustRootError(`invalid ${name} timestamp ${value}`);
    }
  }
  return namespaces;
}

export function parseAllowedSigners(text: string): { entries: TrustEntry[]; errors: string[] } {
  const entries: TrustEntry[] = [];
  const errors: string[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    try {
      let offset = 0;
      const next = () => {
        while (/\s/.test(line[offset] ?? "")) offset++;
        const result = tokenAt(line, offset);
        offset = result.end;
        return result.token;
      };
      const principals = next().split(",");
      const invalid = principals.filter((principal) => parsePrincipal(principal) === null);
      if (invalid.length > 0) {
        throw new TrustRootError(
          `invalid principal(s): ${invalid.map((p) => JSON.stringify(p)).join(", ")}`,
        );
      }
      let keyType = next();
      let namespaces: string[] | null = null;
      if (!KeyTypeSchema.safeParse(keyType).success) {
        namespaces = parseOptions(keyType);
        keyType = next();
      }
      const key = next();
      if (!KeyTypeSchema.safeParse(keyType).success || !KeySchema.safeParse(key).success) {
        throw new TrustRootError("expected an SSH key type and base64 public key");
      }
      entries.push({ principals, namespaces, keyType, key, comment: line.slice(offset).trim() });
    } catch (error) {
      if (!(error instanceof TrustRootError)) throw error;
      errors.push(`line ${index + 1}: ${error.message}`);
    }
  }
  return { entries, errors };
}

export class TrustRoot {
  constructor(
    readonly path: string,
    readonly entries: TrustEntry[],
  ) {}

  /** Key metadata only; git enforces namespace, certificate and validity options (PRD §11.2). */
  principalsForKey(keyType: string, key: string): string[] {
    return [
      ...new Set(
        this.entries
          .filter((entry) => entry.keyType === keyType && entry.key === key)
          .flatMap((entry) => entry.principals),
      ),
    ];
  }
}

export async function loadTrustRoot(path: string): Promise<TrustRoot> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new TrustRootError(`Cannot read local allowed signers file ${path}`, { cause: error });
  }
  const { entries, errors } = parseAllowedSigners(text);
  if (errors.length > 0) {
    throw new TrustRootError(`Invalid local allowed signers file ${path}:\n${errors.join("\n")}`);
  }
  return new TrustRoot(path, entries);
}
