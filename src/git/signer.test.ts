import { ChildProcess, type ExecFileException, execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKey, tempDir } from "../../test/helpers/git-fixture.js";
import { SshKeySigner, SshSignatureSchema, SshSigningError } from "./signer.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

describe("SshKeySigner", () => {
  let dir: string;
  let key: Awaited<ReturnType<typeof generateKey>>;
  let signer: SshKeySigner;

  beforeAll(async () => {
    dir = await tempDir("signer-");
    vi.stubEnv("HOME", dir);
    key = await generateKey(dir, "daemon");
    signer = new SshKeySigner({ principal: "daemon:mac", keyPath: key.privPath });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns deterministic ed25519 signatures for the same key and payload (AC 6)", async () => {
    const payload = Buffer.from("signed payload\0with binary bytes\n", "utf8");
    const first = await signer.sign(payload);
    expect(SshSignatureSchema.safeParse(first).success).toBe(true);
    expect(await signer.sign(payload)).toBe(first);
    expect(await signer.sign(Buffer.from("different payload"))).not.toBe(first);
    expect(signer.principal).toBe("daemon:mac");
  });

  it("passes the public key, agent socket, -U and original payload to ssh-keygen", async () => {
    const socket = join(dir, "agent.sock");
    const payload = Buffer.from("agent signing\n");
    const signature = await signer.sign(payload);
    const received: Buffer[] = [];
    // The sandbox forbids Unix socket listeners; emulate only the ssh-agent process boundary.
    vi.mocked(execFile).mockImplementationOnce((...args) => {
      const callback = args[args.length - 1] as (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void;
      const stdin = new PassThrough();
      stdin.on("data", (chunk: Buffer) => received.push(chunk));
      stdin.on("finish", () => callback(null, signature, ""));
      const child = new ChildProcess();
      child.stdin = stdin;
      return child;
    });
    const oldSocket = process.env.SSH_AUTH_SOCK;
    try {
      vi.stubEnv("SSH_AUTH_SOCK", socket);
      const agentSigner = new SshKeySigner({
        principal: "human",
        keyPath: key.pubPath,
        useAgent: true,
      });
      expect(await agentSigner.sign(payload)).toBe(signature);
      expect(Buffer.concat(received)).toEqual(payload);
      expect(execFile).toHaveBeenLastCalledWith(
        "ssh-keygen",
        ["-Y", "sign", "-n", "git", "-f", key.pubPath, "-U"],
        expect.objectContaining({
          shell: false,
          env: expect.objectContaining({ SSH_AUTH_SOCK: socket }),
        }),
        expect.any(Function),
      );
    } finally {
      vi.stubEnv("SSH_AUTH_SOCK", oldSocket);
    }
  });

  it.each(["attacker", "daemon:mac\n"])(
    "rejects invalid principal %j before invoking ssh-keygen",
    (principal) => {
      expect(() => new SshKeySigner({ principal, keyPath: key.privPath })).toThrow(SshSigningError);
    },
  );

  it("reports a missing key with typed diagnostics", async () => {
    const bad = new SshKeySigner({ principal: "human", keyPath: join(dir, "missing") });
    await expect(bad.sign(Buffer.from("payload"))).rejects.toMatchObject({
      name: "SshSigningError",
      message: expect.stringContaining("missing"),
    });
  });

  it("supports a custom ssh-keygen executable and reports launch failures", async () => {
    const bad = new SshKeySigner({
      principal: "human",
      keyPath: key.privPath,
      sshKeygen: join(dir, "missing-ssh-keygen"),
    });
    await expect(bad.sign(Buffer.from("payload"))).rejects.toMatchObject({
      name: "SshSigningError",
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
  });
});
