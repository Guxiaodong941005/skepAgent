import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAgentMd, parseAgentMd } from "./agent-md.js";
import { ConfigError } from "./errors.js";

const VALID = `---
schema: skep.agent/v1
role: coding
agent_cli: codex
cli_version: "0.1.0"
repos:
  - https://github.com/example/repo.git
capabilities:
  - edit
---

Write clean TypeScript.
`;

describe("parseAgentMd", () => {
  it("parses valid front-matter and keeps the body", () => {
    const agent = parseAgentMd(VALID, "coding/AGENT.md");
    expect(agent.file).toBe("coding/AGENT.md");
    expect(agent.frontMatter).toMatchObject({
      schema: "skep.agent/v1",
      role: "coding",
      agent_cli: "codex",
      cli_version: "0.1.0",
    });
    expect(agent.body).toBe("Write clean TypeScript.");
  });

  it("rejects missing front-matter fences", () => {
    expect(() => parseAgentMd("no fences", "x/AGENT.md")).toThrow(ConfigError);
  });
});

describe("loadAgentMd", () => {
  it("reads AGENT.md from a role directory", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "skep-agent-md-"));
    await writeFile(path.join(dir, "AGENT.md"), VALID, "utf8");
    const agent = await loadAgentMd(dir);
    expect(agent.frontMatter.role).toBe("coding");
    expect(agent.body).toContain("TypeScript");
  });

  it("throws ConfigError when the file is missing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "skep-agent-md-missing-"));
    await expect(loadAgentMd(dir)).rejects.toBeInstanceOf(ConfigError);
  });
});
