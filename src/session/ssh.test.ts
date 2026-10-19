import { describe, expect, it } from "vitest";
import { fakeSsh } from "../../test/helpers/fake-ssh.js";
import type { Clock } from "../util/clock.js";
import { openSsh, sshDestination } from "./ssh.js";

const clock: Clock = { nowMs: () => 0, monotonicMs: () => 0, sleep: () => new Promise(() => {}) };
const base = {
  destination: "alice@gateway",
  target: { host: "127.0.0.1", port: 7419 },
  env: {},
  clock,
};

describe("SSH session transport with a fake spawner", () => {
  it("spawns shell:false -W and connects binary stdio in both directions", async () => {
    const fake = fakeSsh();
    const tunnel = openSsh({ ...base, spawn: fake.spawn });
    await tunnel.ready;
    expect(fake.spawn).toHaveBeenCalledWith(
      "ssh",
      expect.arrayContaining(["-W", "127.0.0.1:7419", "alice@gateway"]),
      { shell: false, env: {}, stdio: "pipe" },
    );
    const incoming = new Promise<Buffer>((resolve) => tunnel.stream.once("data", resolve));
    fake.process.stdout.write(Buffer.from([0, 1, 255]));
    expect(await incoming).toEqual(Buffer.from([0, 1, 255]));
    const outgoing = new Promise<Buffer>((resolve) => fake.process.stdin.once("data", resolve));
    tunnel.stream.write(Buffer.from([4, 0, 6]));
    expect(await outgoing).toEqual(Buffer.from([4, 0, 6]));
    tunnel.close();
    tunnel.close();
    expect(fake.process.kill).toHaveBeenCalledOnce();
    expect(await tunnel.closed).toBeNull();
  });
  it("waits for the reverse loopback port and uses ExitOnForwardFailure", async () => {
    const fake = fakeSsh({ reversePort: 43321 });
    const tunnel = openSsh({ ...base, reverse: true, spawn: fake.spawn });
    expect(await tunnel.ready).toBe(43321);
    expect(fake.spawn.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        "-N",
        "-R",
        "127.0.0.1:0:127.0.0.1:7419",
        "ExitOnForwardFailure=yes",
      ]),
    );
    tunnel.close();
  });
  it.each([
    [{ error: "ENOENT" }, "SSH client not found"],
    [{ stderr: "Permission denied (publickey)", exit: 255 }, "SSH authentication failed"],
    [{ stderr: "remote port forwarding failed", exit: 255 }, "SSH forwarding was refused"],
    [{ exit: 1 }, "SSH tunnel exited 1"],
  ] as const)("maps SSH failure %j", async (options, message) => {
    const fake = fakeSsh(options);
    const tunnel = openSsh({ ...base, reverse: true, spawn: fake.spawn });
    await expect(tunnel.ready).rejects.toThrow(message);
    expect((await tunnel.closed)?.message).toContain(message);
  });
  it("bounds reverse readiness with the injected clock and kills a stuck process", async () => {
    let wake = () => {};
    const fake = fakeSsh();
    const tunnel = openSsh({
      ...base,
      reverse: true,
      spawn: fake.spawn,
      clock: {
        ...clock,
        sleep: () =>
          new Promise((resolve) => {
            wake = resolve;
          }),
      },
    });
    wake();
    await expect(tunnel.ready).rejects.toThrow("within 15 s");
    expect(fake.process.kill).toHaveBeenCalledOnce();
  });
  it.each(["-oProxyCommand=bad", "a b", "user@host;bad", "user@", "host\n-oBad"])(
    "rejects unsafe destination %j",
    (destination) => {
      expect(() => sshDestination(destination)).toThrow("[user@]host");
    },
  );
});
