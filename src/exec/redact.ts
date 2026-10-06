/** Pattern-only defence in depth (ARCHITECTURE §16, D19); never reads credentials or config. */
export type SecretRule = "provider-api-key" | "github-token" | "private-key" | "secret-assignment";

/** UTF-16 offsets, with an exclusive end. Findings deliberately contain no matched secret. */
export interface SecretMatch {
  rule: SecretRule;
  start: number;
  end: number;
}

export interface TextRedactor {
  redact(text: string): string;
}

export interface RedactionStream {
  push(chunk: string): string;
  flush(): string;
}

const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?)-----/g;
const PROVIDER_KEY =
  /(?<![A-Za-z0-9_-])(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{35,}|gsk_[A-Za-z0-9]{32,}|hf_[A-Za-z0-9]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Za-z0-9_-])/g;
const GITHUB_TOKEN =
  /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})(?![A-Za-z0-9_])/g;
const SECRET_ASSIGNMENT =
  /\b[A-Za-z_][A-Za-z0-9_]*(?:_KEY|_TOKEN|_SECRET)[ \t]*=[ \t]*(?:"((?:\\[^\r\n]|[^"\\\r\n])*)"?|'((?:\\[^\r\n]|[^'\\\r\n])*)'?|([^\s"'`,;]+))/gi;
const REDACTED_VALUE = /^\[REDACTED:[a-z-]+\]$/;
const PRIORITY: Record<SecretRule, number> = {
  "private-key": 0,
  "github-token": 1,
  "provider-api-key": 2,
  "secret-assignment": 3,
};

interface PrivateKeyMatch extends SecretMatch {
  complete: boolean;
}

function privateKeys(text: string): PrivateKeyMatch[] {
  const pattern = new RegExp(PRIVATE_KEY_BEGIN);
  const matches: PrivateKeyMatch[] = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const footer = `-----END ${match[1]}-----`;
    const footerStart = text.indexOf(footer, pattern.lastIndex);
    const complete = footerStart !== -1;
    const end = complete ? footerStart + footer.length : text.length;
    matches.push({ rule: "private-key", start: match.index, end, complete });
    // Truncated blocks fail closed: their remaining contents must not escape (D19).
    if (!complete) break;
    pattern.lastIndex = end;
  }
  return matches;
}

function tokenMatches(text: string, pattern: RegExp, rule: SecretRule): SecretMatch[] {
  return Array.from(text.matchAll(pattern), (match) => ({
    rule,
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function highEntropy(value: string): boolean {
  // gitleaks-style generic assignments: short values, prose and placeholders are not secrets.
  if (value.length < 16 || /\s/.test(value) || REDACTED_VALUE.test(value)) return false;
  const counts = new Map<string, number>();
  let symbols = 0;
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
    symbols += 1;
  }
  if (symbols < 16) return false;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / symbols;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.5;
}

function assignmentMatches(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (!highEntropy(value)) continue;
    const prefix = match[0].indexOf("=") + 1;
    const valueStart = match[0].indexOf(value, prefix);
    matches.push({
      rule: "secret-assignment",
      start: match.index + valueStart,
      end: match.index + valueStart + value.length,
    });
  }
  return matches;
}

/** Uses exactly the redaction rules for the pre-publication scan (ARCHITECTURE §16). */
export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [
    ...privateKeys(text).map(({ rule, start, end }) => ({ rule, start, end })),
    ...tokenMatches(text, PROVIDER_KEY, "provider-api-key"),
    ...tokenMatches(text, GITHUB_TOKEN, "github-token"),
    ...assignmentMatches(text),
  ];
  matches.sort((a, b) => a.start - b.start || PRIORITY[a.rule] - PRIORITY[b.rule] || b.end - a.end);

  const merged: SecretMatch[] = [];
  for (const match of matches) {
    const previous = merged.at(-1);
    if (!previous || match.start >= previous.end) {
      merged.push({ ...match });
      continue;
    }
    // Overlapping rules cover the union, so a less specific rule cannot expose a suffix.
    previous.end = Math.max(previous.end, match.end);
    if (PRIORITY[match.rule] < PRIORITY[previous.rule]) previous.rule = match.rule;
  }
  return merged;
}

export class Redactor implements TextRedactor {
  redact(text: string): string {
    const parts: string[] = [];
    let offset = 0;
    for (const match of findSecrets(text)) {
      parts.push(text.slice(offset, match.start), `[REDACTED:${match.rule}]`);
      offset = match.end;
    }
    parts.push(text.slice(offset));
    return parts.join("");
  }

  /** Each output source needs its own stream; whole-record redaction is stateless. */
  createStream(): RedactionStream {
    return new PatternRedactionStream(this);
  }
}

class PatternRedactionStream implements RedactionStream {
  private pending = "";

  constructor(private readonly redactor: TextRedactor) {}

  /**
   * Hold the unfinished line and any private-key block crossing its boundary. Emitting a fixed
   * lookbehind window would leak arbitrarily long tokens or split PEM bodies (ARCHITECTURE §16).
   */
  push(chunk: string): string {
    this.pending += chunk;
    let end = this.pending.lastIndexOf("\n") + 1;
    if (end === 0) return "";
    for (const match of privateKeys(this.pending)) {
      if (match.start < end && (!match.complete || match.end > end)) {
        end = this.pending.lastIndexOf("\n", match.start - 1) + 1;
        break;
      }
    }
    const ready = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    return this.redactor.redact(ready);
  }

  /** Call at EOF, including after interruption, to redact and release the remaining text. */
  flush(): string {
    const ready = this.pending;
    this.pending = "";
    return this.redactor.redact(ready);
  }
}
