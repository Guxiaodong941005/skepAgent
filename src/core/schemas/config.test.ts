import { describe, expect, it } from "vitest";
import { DeviceConfigSchema, DeviceSubmitSchema } from "./config.js";

const device = {
  schema: "skep.device/v1",
  device: "mac",
  blackboard: { url: "https://example.invalid/blackboard.git" },
  repos: [],
  signing_key: "daemon.key",
};

describe("device submit policy", () => {
  it.each([undefined, {}, { method: "pr" }, { host: "github" }])(
    "defaults absent settings %j",
    (submit) => {
      expect(
        DeviceConfigSchema.parse({ ...device, ...(submit === undefined ? {} : { submit }) }).submit,
      ).toEqual({ method: "pr", host: "github" });
    },
  );
  it.each(["pr", "mr", "push", "none", "ask"] as const)(
    "accepts method %s with each local host",
    (method) => {
      for (const host of ["github", "gitlab", "git"] as const)
        expect(DeviceSubmitSchema.parse({ method, host })).toEqual({ method, host });
    },
  );
  it.each([
    { method: "skip" },
    { method: "device" },
    { host: "other" },
    { credentials: "unsupported" },
  ])("rejects invalid policy %j", (submit) => {
    expect(DeviceSubmitSchema.safeParse(submit).success).toBe(false);
  });
});
