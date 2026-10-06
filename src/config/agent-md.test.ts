import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentMd, parseAgentMd } from "./agent-md.js";
import { ConfigError } from "./errors.js";

const FIXTURES = path.resolve("test/fixtures/config");

const FILE = "coding/AGENT.md";

describe("parseAgentMd", () => {
  it("parses the valid fixture, applies defaults, and keeps the body verbatim", async () => {
    const text = await readFile(path.join(FIXTURES, "agent.valid.md"), "utf8");
    const agent = parseAgentMd(text, FILE);
    expect(agent.file).toBe(FILE);
    expect(agent.frontMatter).toMatchObject({
      schema: "skep.agent/v1",
      role: "coding",
      agent_cli: "codex",
      cli_version: "pinned-1.2.3",
      repos: ["git@example.com:owner/app.git"],
      capabilities: ["typescript", "unit-tests"],
      requires_local: ["xcode"],
      max_parallel_items: 1,
      budgets: { max_invocation_minutes: 45 },
    });
    expect(agent.body).toBe(
      [
        "# Responsibilities",
        "Implement application code and unit tests for assigned work items.",
        "",
        "# Boundaries",
        "- Never modify files under design/.",
        "- Do not attempt to push; the daemon does this.",
      ].join("\n"),
    );
  });

  it("applies the requires_local, max_parallel_items and budgets defaults", () => {
    const agent = parseAgentMd(
      [
        "---",
        "schema: skep.agent/v1",
        "role: coding",
        "agent_cli: pi",
        'cli_version: "pinned-0.1.0"',
        "repos:",
        "  - git@example.com:owner/app.git",
        "capabilities: []",
        "---",
        "Do the assigned work.",
      ].join("\n"),
      FILE,
    );
    expect(agent.frontMatter.requires_local).toEqual([]);
    expect(agent.frontMatter.max_parallel_items).toBe(1);
    expect(agent.frontMatter.budgets).toEqual({ max_invocation_minutes: 45 });
  });

  it("rejects a file with no front-matter", async () => {
    const text = await readFile(path.join(FIXTURES, "agent.no-frontmatter.md"), "utf8");
    try {
      parseAgentMd(text, FILE);
      expect.fail("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.file).toBe(FILE);
      expect(configError.line).toBe(1);
      expect(configError.message).toMatch(/front-matter/);
    }
  });

  it("rejects an unterminated front-matter", () => {
    const text = ["---", "schema: skep.agent/v1", "role: coding", "", "# Body"].join("\n");
    expect(() => parseAgentMd(text, FILE)).toThrow(/unterminated/);
  });

  it("rejects an empty body", () => {
    const text = ["---", "schema: skep.agent/v1", "---", "", "   "].join("\n");
    try {
      parseAgentMd(text, FILE);
      expect.fail("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/body must not be empty/);
    }
  });

  it("reports the file line of a YAML syntax error", () => {
    const text = ["---", "schema: [unterminated", "role: coding", "---", "Body."].join("\n");
    try {
      parseAgentMd(text, FILE);
      expect.fail("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      // The broken `[` is on file line 2; the parser reports where it gave up, line 3.
      expect(configError.line).toBe(3);
      expect(configError.message).toMatch(/^coding\/AGENT\.md:3: /);
    }
  });

  it("names the dotted path for a schema error and rejects unknown keys", () => {
    const unknown = [
      "---",
      "schema: skep.agent/v1",
      "role: coding",
      "agent_cli: codex",
      'cli_version: "pinned-1.0.0"',
      "repos: [git@example.com:owner/app.git]",
      "capabilities: []",
      "surprise: true",
      "---",
      "Body.",
    ].join("\n");
    expect(() => parseAgentMd(unknown, FILE)).toThrow(/\(root\): Unrecognized key/);

    const badRole = unknown
      .replace("role: coding", "role: NOT-A-ROLE")
      .replace("surprise: true\n", "");
    expect(() => parseAgentMd(badRole, FILE)).toThrow(/coding\/AGENT\.md: role: /);
  });

  it("refuses custom YAML tags", () => {
    const text = [
      "---",
      "schema: skep.agent/v1",
      "role: !!something coding",
      "agent_cli: codex",
      'cli_version: "pinned-1.0.0"',
      "repos: [git@example.com:owner/app.git]",
      "capabilities: []",
      "---",
      "Body.",
    ].join("\n");
    expect(() => parseAgentMd(text, FILE)).toThrow(ConfigError);
  });
});

describe("loadAgentMd", () => {
  it("reads AGENT.md from a temp role directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "skep-role-"));
    const text = await readFile(path.join(FIXTURES, "agent.valid.md"), "utf8");
    await writeFile(path.join(dir, "AGENT.md"), text);
    const agent = await loadAgentMd(dir);
    expect(agent.file).toBe(path.join(dir, "AGENT.md"));
    expect(agent.frontMatter.role).toBe("coding");
    expect(agent.file.startsWith(path.join(os.homedir(), ".skep"))).toBe(false);
  });
});
