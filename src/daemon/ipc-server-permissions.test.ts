import { chmod, chown, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Redactor } from "../exec/redact.js";
import { connectIpc } from "../ipc/client.js";
import { execFileChecked } from "../util/exec.js";
import { IpcServer, IpcServerError, type IpcServerOptions } from "./ipc-server.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, chown: vi.fn(actual.chown) };
});

describe("IPC socket permissions (D22)", () => {
  let dir: string;
  let server: IpcServer | undefined;
  let group: string;

  beforeAll(async () => {
    group = (await execFileChecked("/usr/bin/id", ["-gn"])).stdout.trim();
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
    vi.mocked(chown).mockReset();
  });

  async function setup(
    permissions: Pick<IpcServerOptions, "group" | "mode">,
    exec?: typeof execFileChecked,
  ): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), "skep-ipc-mode-"));
    const socketPath = join(dir, "skepd.sock");
    server = new IpcServer(
      {
        socketPath,
        ...permissions,
        redactor: new Redactor(),
        handlers: {
          status: vi.fn(),
          log: vi.fn(),
          publish: vi.fn(),
          agentStart: vi.fn(),
          agentStop: vi.fn(),
          logsTail: vi.fn(),
          doctor: vi.fn(),
          ping: async () => ({ pong: true }),
          pull: async () => ({ fetched: true }),
        },
      },
      { exec },
    );
    return socketPath;
  }

  it("sets a named group on both inodes and serves requests with 0660/0750", async () => {
    const socketPath = await setup({ group, mode: 0o660 });
    // A pre-existing directory may belong to a different group and have excess permissions.
    if (process.getuid?.() === 0) await chown(dir, -1, 65534);
    await chmod(dir, 0o777);
    await server?.start();
    const socket = await lstat(socketPath);
    const directory = await lstat(dir);
    expect(socket.isSocket()).toBe(true);
    expect(socket.mode & 0o777).toBe(0o660);
    expect(directory.mode & 0o777).toBe(0o750);
    expect(socket.gid).toBe(process.getgid?.());
    expect(directory.gid).toBe(socket.gid);
    expect(socket.uid).toBe(process.getuid?.());
    expect(directory.uid).toBe(socket.uid);
    const client = await connectIpc(socketPath);
    try {
      expect(await client.call("ping", {})).toEqual({ ok: true, result: { pong: true } });
    } finally {
      client.close();
    }
  });

  it("permits mode 0660 with the directory's existing group", async () => {
    const socketPath = await setup({ mode: 0o660 });
    await server?.start();
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o660);
    expect((await lstat(dir)).mode & 0o777).toBe(0o750);
    expect((await lstat(socketPath)).gid).toBe((await lstat(dir)).gid);
  });

  it.each([undefined, 0o600] as const)(
    "keeps access private with a named group and mode %s",
    async (mode) => {
      const socketPath = await setup({ group, mode });
      await server?.start();
      expect((await lstat(socketPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
      expect((await lstat(socketPath)).gid).toBe(process.getgid?.());
    },
  );

  it.each(["", "-R", "skep\nother", "skep/other"])(
    "rejects an invalid group name %j before invoking chgrp",
    async (invalid) => {
      const exec = vi.fn();
      const socketPath = await setup({ group: invalid, mode: 0o660 }, exec);
      await expect(server?.start()).rejects.toThrow(IpcServerError);
      expect(exec).not.toHaveBeenCalled();
      await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects unsupported modes even from untyped callers", async () => {
    await setup({ mode: 0o666 as 0o660 });
    await expect(server?.start()).rejects.toThrow("mode 0600 or 0660");
  });

  it("refuses a symlinked directory before changing its target's group or mode", async () => {
    const exec = vi.fn();
    await setup({ group: "skep", mode: 0o660 }, exec);
    const target = `${dir}-target`;
    try {
      await mkdir(target, { mode: 0o755 });
      const originalMode = (await lstat(target)).mode;
      await rm(dir, { recursive: true });
      await symlink(target, dir);
      await expect(server?.start()).rejects.toThrow("not a symlink");
      expect(exec).not.toHaveBeenCalled();
      expect((await lstat(target)).mode).toBe(originalMode);
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("fails closed with an actionable error if the group cannot be assigned", async () => {
    const cause = new Error("Group missing or permission denied");
    const exec = vi.fn(async () => {
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
      throw cause;
    });
    const socketPath = await setup({ group: "skep", mode: 0o660 }, exec);
    await chmod(dir, 0o777);
    await expect(server?.start()).rejects.toMatchObject({
      name: "IpcServerError",
      message: expect.stringContaining("ensure the group exists and the daemon may use it"),
      cause,
    });
    expect(exec).toHaveBeenCalledWith("/usr/bin/chgrp", ["skep", dir], {
      env: { LC_ALL: "C" },
    });
    expect(server?.listening).toBe(false);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("closes and removes the socket if ownership fails after binding, allowing retry", async () => {
    const socketPath = await setup({ group, mode: 0o660 });
    vi.mocked(chown).mockRejectedValueOnce(new Error("Permission denied"));
    await expect(server?.start()).rejects.toThrow(IpcServerError);
    expect(server?.listening).toBe(false);
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await server?.start();
    expect(server?.listening).toBe(true);
  });

  // Switching credentials requires root. The inode assertions above also run unprivileged.
  // The OS denies a non-owner outside the selected group at the 0750 directory (EACCES),
  // before IPC framing/authentication; root bypasses DAC and is not a wrong-group client.
  it.runIf(process.getuid?.() === 0).each(["primary", "supplementary", "wrong"])(
    "checks access from a different uid with %s group membership",
    async (membership) => {
      const socketPath = await setup({ group, mode: 0o660 });
      await server?.start();
      const { gid } = await lstat(socketPath);
      const result = await execFileChecked(
        process.execPath,
        [
          "-e",
          `
            const net = require("node:net");
            const [path, group, membership] = process.argv.slice(1);
            const gid = Number(group);
            process.setgroups(membership === "supplementary" ? [gid] : []);
            process.setgid(membership === "primary" ? gid : (gid === 65534 ? 65533 : 65534));
            process.setuid(65534);
            const socket = net.createConnection(path);
            socket.on("error", error => { process.stdout.write(error.code); });
            socket.on("connect", () => socket.write(
              JSON.stringify({ v: 1, id: "c1", method: "ping", params: {} }) + "\\n"
            ));
            let text = "";
            socket.on("data", chunk => {
              text += chunk;
              if (text.includes("\\n")) { process.stdout.write(text); socket.end(); }
            });
          `,
          "skepd.sock",
          String(gid),
          membership,
        ],
        // Start inside the test directory so a private platform TMPDIR ancestor cannot
        // mask the socket directory's own access checks after the child drops privileges.
        { cwd: dir, timeoutMs: 5_000 },
      );
      if (membership === "wrong") expect(result.stdout).toBe("EACCES");
      else expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, result: { pong: true } });
    },
  );
});
