import { describe, expect, it, vi } from "vitest";
import { parseDeviceConfig } from "../config/device.js";
import { notifyWorkers, pullCommand, workersOf } from "./pull-notify.js";

describe("pullCommand", () => {
  it("asks the worker to fetch, with no event payload", () => {
    expect(pullCommand({ device: "mac", ssh: "agent@mac" })).toEqual(["skep", "pull"]);
    expect(
      pullCommand({
        device: "mac",
        ssh: "agent@mac",
        skepBin: "/usr/local/bin/skep",
        home: "/var/lib/skep",
      }),
    ).toEqual(["/usr/local/bin/skep", "pull", "--home", "/var/lib/skep"]);
  });
});

describe("notifyWorkers", () => {
  it("sshes each worker and keeps going when one is down", async () => {
    const exec = vi.fn(async (file: string, args: string[]) => {
      expect(file).toBe("ssh");
      if (args.includes("down@vps")) throw new Error("ssh down@vps timed out");
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
    });
    const results = await notifyWorkers(
      [
        { device: "mac", ssh: "agent@mac" },
        { device: "vps", ssh: "down@vps" },
      ],
      exec as never,
    );
    expect(results).toEqual([
      { device: "mac", ok: true, detail: "fetch requested" },
      { device: "vps", ok: false, detail: "ssh down@vps timed out" },
    ]);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe("workersOf", () => {
  it("reads the optional controller worker list", () => {
    const cfg = parseDeviceConfig(
      [
        'schema = "skep.device/v1"',
        'device = "vps"',
        'signing_key = "keys/daemon"',
        "repos = []",
        "[blackboard]",
        'url = "git@example.invalid:example/blackboard.git"',
        "[[workers]]",
        'device = "mac"',
        'ssh = "agent@mac"',
        'skep_bin = "/usr/local/bin/skep"',
        'home = "/var/lib/skep"',
      ].join("\n"),
      "device.toml",
    );
    expect(workersOf(cfg)).toEqual([
      {
        device: "mac",
        ssh: "agent@mac",
        skepBin: "/usr/local/bin/skep",
        home: "/var/lib/skep",
      },
    ]);
  });

  it("rejects a worker ssh target with shell metacharacters", () => {
    expect(() =>
      parseDeviceConfig(
        [
          'schema = "skep.device/v1"',
          'device = "vps"',
          'signing_key = "keys/daemon"',
          "repos = []",
          "[blackboard]",
          'url = "git@example.invalid:example/blackboard.git"',
          "[[workers]]",
          'device = "mac"',
          'ssh = "agent@mac;rm"',
        ].join("\n"),
        "device.toml",
      ),
    ).toThrow(/workers/);
  });
});
