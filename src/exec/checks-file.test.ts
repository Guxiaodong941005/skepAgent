import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config/errors.js";
import { parseChecksFile } from "./checks-file.js";

const FIXTURES = path.resolve("test/fixtures/config");
const SOURCE = "base_commit:.skep/checks.toml";

async function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

describe("parseChecksFile", () => {
  it("parses the valid fixture and applies timeout_sec and parser defaults", async () => {
    const checks = parseChecksFile(await fixture("checks.valid.toml"), SOURCE);
    expect(checks.schema).toBe("skep.checks/v1");
    expect(checks.checks.unit).toEqual({
      argv: ["npm", "test"],
      timeout_sec: 600,
      parser: "none",
    });
    expect(checks.checks.lint).toEqual({
      argv: ["npm", "run", "lint"],
      timeout_sec: 120,
      cwd: "packages/app",
      parser: "none",
    });
    expect(checks.checks.env?.env).toEqual({ NODE_ENV: "test" });
  });

  it("rejects an argv given as a string", async () => {
    const text = await fixture("checks.bad-argv.toml");
    try {
      parseChecksFile(text, SOURCE);
      expect.fail("expected a ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.file).toBe(SOURCE);
      expect(configError.line).toBeNull();
      expect(configError.message).toMatch(/checks\.unit\.argv: /);
      expect(configError.message).toMatch(/expected array/);
    }
  });

  it("rejects an invalid check name", () => {
    const text = [
      'schema = "skep.checks/v1"',
      "",
      "[checks.Unit]",
      'argv = ["npm", "test"]',
      "",
    ].join("\n");
    expect(() => parseChecksFile(text, SOURCE)).toThrow(/checks\.Unit: /);
  });

  it("rejects a lowercase env key", () => {
    const text = [
      'schema = "skep.checks/v1"',
      "",
      "[checks.unit]",
      'argv = ["npm", "test"]',
      "",
      "[checks.unit.env]",
      'path = "/usr/bin"',
      "",
    ].join("\n");
    expect(() => parseChecksFile(text, SOURCE)).toThrow(/checks\.unit\.env\.path: /);
  });

  it("rejects unknown keys", () => {
    const text = [
      'schema = "skep.checks/v1"',
      "",
      "[checks.unit]",
      'argv = ["npm", "test"]',
      'shell = "bash"',
      "",
    ].join("\n");
    expect(() => parseChecksFile(text, SOURCE)).toThrow(/checks\.unit: Unrecognized key/);
  });

  it("reports the parser line for a TOML syntax error", () => {
    const text = ['schema = "skep.checks/v1"', "", "argv = [", ""].join("\n");
    try {
      parseChecksFile(text, SOURCE);
      expect.fail("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.line).toBe(4);
      expect(configError.message.startsWith(`${SOURCE}:4: `)).toBe(true);
    }
  });
});
