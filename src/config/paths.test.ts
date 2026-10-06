import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { skepHome, skepPaths } from "./paths.js";

describe("skepHome", () => {
  it("honours SKEP_HOME", () => {
    expect(skepHome({ SKEP_HOME: "/tmp/skep-test" })).toBe("/tmp/skep-test");
  });

  it("ignores an empty SKEP_HOME and falls back to ~/.skep", () => {
    expect(skepHome({ SKEP_HOME: "" })).toBe(path.join(os.homedir(), ".skep"));
    expect(skepHome({})).toBe(path.join(os.homedir(), ".skep"));
  });

  it("does not read the real process environment", () => {
    // Passing an explicit env keeps the test from depending on (or writing via) the user's home.
    expect(skepHome({ SKEP_HOME: "/var/skep" })).toBe("/var/skep");
  });
});

describe("skepPaths", () => {
  it("returns absolute paths for every well-known file", () => {
    const paths = skepPaths("/tmp/skep-home");
    for (const p of Object.values(paths)) {
      expect(path.isAbsolute(p)).toBe(true);
    }
    expect(paths).toEqual({
      home: "/tmp/skep-home",
      deviceToml: "/tmp/skep-home/device.toml",
      allowedSigners: "/tmp/skep-home/allowed_signers",
      socket: "/tmp/skep-home/skepd.sock",
      lockFile: "/tmp/skep-home/skepd.lock",
      blackboardClone: "/tmp/skep-home/blackboard",
      cliBlackboardClone: "/tmp/skep-home/cli-blackboard",
      keysDir: "/tmp/skep-home/keys",
    });
  });

  it("resolves a relative home against the cwd", () => {
    const paths = skepPaths("rel-home");
    expect(paths.home).toBe(path.resolve("rel-home"));
    expect(paths.socket).toBe(path.resolve("rel-home", "skepd.sock"));
  });
});
