import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findRepo, loadDeviceConfig, parseDeviceConfig } from "./device.js";
import { ConfigError } from "./errors.js";

const FIXTURES = path.resolve("test/fixtures/config");

async function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

describe("parseDeviceConfig", () => {
  it("parses the valid fixture and applies poll defaults", async () => {
    const cfg = parseDeviceConfig(await fixture("device.valid.toml"), "device.valid.toml");
    expect(cfg.device).toBe("mac");
    expect(cfg.repos).toEqual([
      { name: "app", url: "git@example.com:owner/app.git" },
      { name: "libs", url: "https://example.com/owner/libs.git" },
    ]);
    expect(cfg.blackboard).toEqual({ url: "git@example.com:owner/blackboard.git" });
    // poll is omitted from the fixture; the schema default fills it in (PRD §7.2).
    expect(cfg.poll).toEqual({ active_sec: 20, idle_sec: 90 });
    expect(cfg.notify).toEqual({ ntfy_topic_url: "https://ntfy.example.com/skep-mac" });
    expect(cfg.human_signing_key).toBeUndefined();
  });

  it("names the dotted path for an invalid repo name", async () => {
    const text = await fixture("device.bad-repo.toml");
    expect(() => parseDeviceConfig(text, "device.bad-repo.toml")).toThrow(ConfigError);
    try {
      parseDeviceConfig(text, "device.bad-repo.toml");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.file).toBe("device.bad-repo.toml");
      expect(configError.line).toBeNull();
      expect(configError.message).toMatch(/^device\.bad-repo\.toml: repos\.0\.name: /);
    }
  });

  it("rejects unknown keys", () => {
    const text = [
      'schema = "skep.device/v1"',
      'device = "vps"',
      'signing_key = "keys/daemon"',
      "surprise = true",
      "",
      "[blackboard]",
      'url = "git@example.com:owner/blackboard.git"',
      "",
    ].join("\n");
    expect(() => parseDeviceConfig(text, "device.toml")).toThrow(
      /\(root\): Unrecognized key: "surprise"/,
    );
  });

  it("reports the parser's 1-based line for a TOML syntax error", () => {
    const text = ['schema = "skep.device/v1"', "device = ", ""].join("\n");
    try {
      parseDeviceConfig(text, "/tmp/skep-test/device.toml");
      expect.fail("expected a syntax error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const configError = error as ConfigError;
      expect(configError.line).toBe(2);
      expect(configError.message).toMatch(/^\/tmp\/skep-test\/device\.toml:2: /);
    }
  });

  it("rejects a device name that fails DEVICE_RE", () => {
    const text = [
      'schema = "skep.device/v1"',
      'device = "Not A Device"',
      'signing_key = "keys/daemon"',
      "[blackboard]",
      'url = "git@example.com:owner/blackboard.git"',
    ].join("\n");
    expect(() => parseDeviceConfig(text, "device.toml")).toThrow(/device\.toml: device: /);
  });
});

describe("loadDeviceConfig", () => {
  it("reads a temp file and never the real home directory", async () => {
    const dir = await osTmp();
    const file = path.join(dir, "device.toml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, await fixture("device.valid.toml"));
    const cfg = await loadDeviceConfig(file);
    expect(cfg.device).toBe("mac");
    expect(file.startsWith(path.join(os.homedir(), ".skep"))).toBe(false);
  });

  it("wraps a missing file in ConfigError naming the path", async () => {
    const missing = path.join(os.tmpdir(), `skep-missing-${process.pid}.toml`);
    await expect(loadDeviceConfig(missing)).rejects.toThrow(ConfigError);
  });
});

describe("findRepo", () => {
  async function cfg() {
    return parseDeviceConfig(await fixture("device.valid.toml"), "device.valid.toml");
  }

  it("matches by name", async () => {
    expect(findRepo(await cfg(), "libs")).toEqual({
      name: "libs",
      url: "https://example.com/owner/libs.git",
    });
  });

  it("matches a URL with and without a trailing .git and trailing slash", async () => {
    const device = await cfg();
    expect(findRepo(device, "git@example.com:owner/app.git")?.name).toBe("app");
    expect(findRepo(device, "git@example.com:owner/app")?.name).toBe("app");
    expect(findRepo(device, "https://example.com/owner/libs/")?.name).toBe("libs");
    expect(findRepo(device, "https://example.com/owner/libs")?.name).toBe("libs");
    // Slashes are stripped before `.git`, so a slash after the suffix still matches.
    expect(findRepo(device, "git@example.com:owner/app.git/")?.name).toBe("app");
    expect(findRepo(device, "https://example.com/owner/libs.git/")?.name).toBe("libs");
  });

  it("returns null for an unknown repo", async () => {
    expect(findRepo(await cfg(), "other")).toBeNull();
    expect(findRepo(await cfg(), "git@example.com:owner/other.git")).toBeNull();
  });
});

async function osTmp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), "skep-config-"));
}
