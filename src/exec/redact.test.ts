import { describe, expect, it } from "vitest";
import { findSecrets, Redactor, type SecretRule } from "./redact.js";

// All fixtures are synthetic, recognizable examples, never usable credentials.
const FAKE_BODY = "ExampleFake0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // gitleaks:allow
const FAKE_KEY = `sk-test-${FAKE_BODY}`; // gitleaks:allow
const FAKE_GITHUB = `ghp_${FAKE_BODY}`; // gitleaks:allow

interface Fixture {
  name: string;
  rule: SecretRule;
  text: string;
  redacted: string;
}

const tokenFixtures: Fixture[] = [
  ["test API key", FAKE_KEY],
  ["legacy API key", `sk-${FAKE_BODY}`], // gitleaks:allow
  ["project API key", `sk-proj-${FAKE_BODY}`], // gitleaks:allow
  ["Anthropic-style API key", `sk-ant-api03-${FAKE_BODY}`], // gitleaks:allow
  ["Google-style API key", `AIza${FAKE_BODY.slice(0, 35)}`], // gitleaks:allow
  ["Groq-style API key", `gsk_${FAKE_BODY}`], // gitleaks:allow
  ["Hugging Face-style token", `hf_${FAKE_BODY}`], // gitleaks:allow
  ["AWS-style access key ID", `AKIA${"EXAMPLE012345678"}`], // gitleaks:allow
  ["AWS-style temporary key ID", `ASIA${"EXAMPLE012345678"}`], // gitleaks:allow
].map(([name, token]) => ({
  name: name ?? "",
  rule: "provider-api-key",
  text: `before ${token} after\n`,
  redacted: "before [REDACTED:provider-api-key] after\n",
}));

const githubFixtures: Fixture[] = ["ghp", "gho", "ghu", "ghs", "ghr", "github_pat"].map(
  (prefix) => ({
    name: `${prefix} token`,
    rule: "github-token",
    text: `before ${prefix}_${FAKE_BODY} after\n`, // gitleaks:allow
    redacted: "before [REDACTED:github-token] after\n",
  }),
);

const privateKeyFixtures: Fixture[] = [
  "PRIVATE KEY",
  "RSA PRIVATE KEY",
  "EC PRIVATE KEY",
  "DSA PRIVATE KEY",
  "OPENSSH PRIVATE KEY",
  "ENCRYPTED PRIVATE KEY",
  "PGP PRIVATE KEY BLOCK",
].map((label) => ({
  name: label,
  rule: "private-key",
  text: `before\n-----BEGIN ${label}-----\nEXAMPLE-FAKE-KEY-BODY\n-----END ${label}-----\nafter\n`, // gitleaks:allow
  redacted: "before\n[REDACTED:private-key]\nafter\n",
}));

const assignmentFixtures: Fixture[] = ["KEY", "TOKEN", "SECRET"].flatMap((suffix) =>
  ["", "'", '"'].map((quote) => ({
    name: `${suffix} assignment with ${quote || "no"} quotes`,
    rule: "secret-assignment",
    text: `export EXAMPLE_${suffix} = ${quote}${FAKE_BODY}${quote};\n`, // gitleaks:allow
    redacted: `export EXAMPLE_${suffix} = ${quote}[REDACTED:secret-assignment]${quote};\n`,
  })),
);

const fixtures = [
  ...tokenFixtures,
  ...githubFixtures,
  ...privateKeyFixtures,
  ...assignmentFixtures,
];

describe("Redactor", () => {
  const redactor = new Redactor();

  it.each(fixtures)("redacts $name with its rule marker", ({ text, redacted, rule }) => {
    expect(redactor.redact(text)).toBe(redacted);
    expect(findSecrets(text)).toEqual([
      { rule, start: expect.any(Number), end: expect.any(Number) },
    ]);
    expect(findSecrets(redacted)).toEqual([]);
    expect(redactor.redact(redacted)).toBe(redacted);
  });

  it("preserves ordinary text, low-entropy assignments, public keys and placeholders", () => {
    const text = [
      "ordinary text at example.invalid: café",
      "sk-test-short ghp_example github_pat_example",
      "EXAMPLE_KEY=development EXAMPLE_TOKEN=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "EXAMPLE_SECRET=012345678901234567890123456789 EXAMPLE_TOKEN='a normal sentence'",
      'EXAMPLE_KEY="" EXAMPLE_SECRET="[REDACTED:secret-assignment]"',
      "-----BEGIN PUBLIC KEY-----\nEXAMPLE-PUBLIC-KEY\n-----END PUBLIC KEY-----",
      "ssh-ed25519 EXAMPLE-PUBLIC-KEY mac@example.invalid",
      `ORDINARY_VALUE=${FAKE_BODY}`,
    ].join("\n");
    expect(redactor.redact(text)).toBe(text);
    expect(findSecrets(text)).toEqual([]);
  });

  it("supports lowercase names, tabs, punctuation and escaped quotes in assignments", () => {
    const value = `${FAKE_BODY}\\"!?%+=/`;
    const text = `example_secret\t=\t"${value}"\n`;
    expect(redactor.redact(text)).toBe('example_secret\t=\t"[REDACTED:secret-assignment]"\n');
  });

  it("redacts an unterminated high-entropy quoted assignment", () => {
    const text = `EXAMPLE_TOKEN="${FAKE_BODY}`; // gitleaks:allow
    expect(redactor.redact(text)).toBe('EXAMPLE_TOKEN="[REDACTED:secret-assignment]');
  });

  it("measures assignment entropy in characters rather than UTF-16 code units", () => {
    const value = "😀😁😂😃😄😅😆😉😊😋😎😍😘😗😙😚";
    const text = `EXAMPLE_SECRET='${value}'`;
    expect(redactor.redact(text)).toBe("EXAMPLE_SECRET='[REDACTED:secret-assignment]'");
  });

  it("finds multiple secrets in source order without returning their contents", () => {
    const text = `café 🐝 ${FAKE_GITHUB} then ${FAKE_KEY} and EXAMPLE_SECRET=${FAKE_BODY}`;
    const found = findSecrets(text);
    expect(found).toEqual([
      {
        rule: "github-token",
        start: text.indexOf(FAKE_GITHUB),
        end: text.indexOf(FAKE_GITHUB) + FAKE_GITHUB.length,
      },
      {
        rule: "provider-api-key",
        start: text.indexOf(FAKE_KEY),
        end: text.indexOf(FAKE_KEY) + FAKE_KEY.length,
      },
      {
        rule: "secret-assignment",
        start: text.lastIndexOf(FAKE_BODY),
        end: text.length,
      },
    ]);
    expect(JSON.stringify(found)).not.toContain(FAKE_BODY);
    expect(redactor.redact(text)).toBe(
      "café 🐝 [REDACTED:github-token] then [REDACTED:provider-api-key] and " +
        "EXAMPLE_SECRET=[REDACTED:secret-assignment]",
    );
  });

  it("merges overlapping assignment and token matches using the specific rule", () => {
    const text = `EXAMPLE_TOKEN='${FAKE_GITHUB}' EXAMPLE_KEY=${FAKE_KEY}`;
    expect(findSecrets(text).map((match) => match.rule)).toEqual([
      "github-token",
      "provider-api-key",
    ]);
    expect(redactor.redact(text)).toBe(
      "EXAMPLE_TOKEN='[REDACTED:github-token]' EXAMPLE_KEY=[REDACTED:provider-api-key]",
    );
  });

  it("merges tokens inside private-key blocks into one finding", () => {
    const text = `-----BEGIN PRIVATE KEY-----\n${FAKE_KEY}\n-----END PRIVATE KEY-----`; // gitleaks:allow
    expect(findSecrets(text)).toEqual([{ rule: "private-key", start: 0, end: text.length }]);
    expect(redactor.redact(text)).toBe("[REDACTED:private-key]");
  });

  it("redacts truncated private keys and mismatched footers through EOF", () => {
    for (const tail of ["", "\n-----END EC PRIVATE KEY-----\nafter"]) {
      const text = `before\n-----BEGIN RSA PRIVATE KEY-----\nEXAMPLE-FAKE-KEY-BODY${tail}`; // gitleaks:allow
      expect(redactor.redact(text)).toBe("before\n[REDACTED:private-key]");
    }
  });

  it("does not truncate long tokens or mistake an embedded prefix for a token", () => {
    const longKey = `${FAKE_KEY}${FAKE_BODY.repeat(100)}`;
    expect(redactor.redact(`(${longKey})`)).toBe("([REDACTED:provider-api-key])");
    expect(redactor.redact(`not_${FAKE_KEY}`)).toBe(`not_${FAKE_KEY}`);
  });
});

describe("Redactor streams", () => {
  const redactor = new Redactor();

  it.each(fixtures)("handles $name split at every character boundary", ({ text, redacted }) => {
    for (let split = 0; split <= text.length; split++) {
      const stream = redactor.createStream();
      const first = stream.push(text.slice(0, split));
      const second = stream.push(text.slice(split));
      const final = stream.flush();
      expect(first + second + final, `split ${split}`).toBe(redacted);
      expect(first + second).not.toContain(FAKE_BODY);
      expect(stream.flush()).toBe("");
    }
  });

  it("handles one-character chunks, multiple rules, CRLF and EOF without a newline", () => {
    const text = fixtures
      .map((fixture) => fixture.text)
      .join("")
      .replaceAll("\n", "\r\n");
    const source = `${text}trailing ${FAKE_KEY}`;
    const stream = redactor.createStream();
    const emitted = Array.from(source, (char) => stream.push(char));
    emitted.push(stream.flush());
    expect(emitted.join("")).toBe(redactor.redact(source));
    for (const chunk of emitted) expect(chunk).not.toContain(FAKE_BODY);
  });

  it("emits complete safe lines while holding an unfinished key block", () => {
    const stream = redactor.createStream();
    expect(stream.push("safe\npartial")).toBe("safe\n");
    expect(stream.push(" line\n-----BEGIN OPENSSH PRIVATE KEY-----\n")) // gitleaks:allow
      .toBe("partial line\n");
    expect(stream.push("EXAMPLE-FAKE-KEY-BODY\n-----END OPENSSH PRI")).toBe("");
    expect(stream.push("VATE KEY-----\nafter\n")).toBe("[REDACTED:private-key]\nafter\n");
    expect(stream.flush()).toBe("");
  });

  it("holds a block whose footer is complete but has no newline yet", () => {
    const stream = redactor.createStream();
    expect(stream.push("before\n-----BEGIN PRIVATE KEY-----\nEXAMPLE-FAKE-KEY-BODY\n")) // gitleaks:allow
      .toBe("before\n");
    expect(stream.push("-----END PRIVATE KEY-----")).toBe("");
    expect(stream.flush()).toBe("[REDACTED:private-key]");
  });

  it("fails closed on interrupted private keys and preserves an ordinary partial line", () => {
    const stream = redactor.createStream();
    expect(stream.push("before\n-----BEGIN PRIVATE KEY-----\nEXAMPLE-FAKE-KEY-BODY\n")) // gitleaks:allow
      .toBe("before\n");
    expect(stream.flush()).toBe("[REDACTED:private-key]");
    expect(stream.push("ordinary partial line")).toBe("");
    expect(stream.flush()).toBe("ordinary partial line");
  });

  it("keeps independent streams and whole-text calls isolated", () => {
    const first = redactor.createStream();
    const second = redactor.createStream();
    expect(first.push(FAKE_KEY.slice(0, 8))).toBe("");
    expect(second.push("mac\n")).toBe("mac\n");
    expect(redactor.redact("vps")).toBe("vps");
    expect(first.push(`${FAKE_KEY.slice(8)}\n`)).toBe("[REDACTED:provider-api-key]\n");
    expect(first.flush()).toBe("");
    expect(second.flush()).toBe("");
  });

  it("buffers a token longer than a fixed lookbehind window without leaking its prefix", () => {
    const stream = redactor.createStream();
    const token = `${FAKE_KEY}${FAKE_BODY.repeat(100)}`;
    for (let offset = 0; offset < token.length; offset += 13) {
      expect(stream.push(token.slice(offset, offset + 13))).toBe("");
    }
    expect(stream.flush()).toBe("[REDACTED:provider-api-key]");
  });
});
