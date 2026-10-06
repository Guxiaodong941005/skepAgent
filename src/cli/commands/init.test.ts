import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDeviceConfig } from "../../config/device.js";
import { skepPaths } from "../../config/paths.js";
import type { ExecResult } from "../../util/exec.js";
import type { CliContext } from "../context.js";
import { runCli } from "../program.js";
import { allowedSignersLine, type InitDeps, initDevice } from "./init.js";

const PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIInitTestKeyMaterialOnlyNotASecret skepd";
const HUMAN_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHumanTestKeyMaterialOnlyNotASecret human";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "skep-init-"));
  roots.push(dir);
  return dir;
}

/** A keygen stand-in: writes the key files and never shells out. */
function fakeKeygen(pubLine = PUB): InitDeps["generateKey"] {
  return async (dir) => {
    const privPath = path.join(dir, "daemon");
    const pubPath = `${privPath}.pub`;
    await writeFile(privPath, "not-a-real-private-key\n", { mode: 0o600 });
    await writeFile(pubPath, `${pubLine}\n`, { mode: 0o644 });
    return { privPath, pubPath, pubLine };
  };
}

function capture(dir: string): { stdout: string; stderr: string; ctx: CliContext } {
  const out = { stdout: "", stderr: "" };
  const ctx: CliContext = {
    stdout: {
      write: (s) => {
        out.stdout += s;
      },
    },
    stderr: {
      write: (s) => {
        out.stderr += s;
      },
    },
    env: { SKEP_HOME: dir },
    output: () => {
      throw new Error("output() used before runCli");
    },
  };
  return {
    get stdout() {
      return out.stdout;
    },
    get stderr() {
      return out.stderr;
    },
    ctx,
  };
}

describe("allowedSignersLine", () => {
  it("formats the controller's trust-root line", () => {
    expect(allowedSignersLine("mac", PUB)).toBe(`daemon:mac namespaces="git" ${PUB}`);
  });
});

describe("initDevice", () => {
  it("writes device.toml, generates the daemon key and returns the allowed_signers line", async () => {
    const dir = await home();
    const paths = skepPaths(dir);
    const result = await initDevice(
      {
        paths,
        device: "mac",
        blackboardUrl: "git@example.invalid:owner/blackboard.git",
        repos: [{ name: "app", url: "git@example.invalid:owner/app.git" }],
        notifyUrl: "https://ntfy.example.invalid/skep-mac",
        genesis: false,
      },
      { exec: unusedExec, generateKey: fakeKeygen() },
    );

    expect(result.allowed_signers_line).toBe(`daemon:mac namespaces="git" ${PUB}`);
    expect(result.genesis_sha).toBeNull();
    const toml = await readFile(paths.deviceToml, "utf8");
    const cfg = parseDeviceConfig(toml, paths.deviceToml);
    expect(cfg.device).toBe("mac");
    expect(cfg.blackboard.url).toBe("git@example.invalid:owner/blackboard.git");
    expect(cfg.signing_key).toBe(result.signing_key);
    expect(cfg.repos).toEqual([{ name: "app", url: "git@example.invalid:owner/app.git" }]);
    expect(cfg.notify?.ntfy_topic_url).toBe("https://ntfy.example.invalid/skep-mac");
    // The daemon key is mode 0600: an agent user must not be able to read it (PRD §11.4).
    expect((await stat(result.signing_key)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.deviceToml)).mode & 0o777).toBe(0o600);
    // The private key stays on the device: the printed line carries only the public half.
    expect(result.allowed_signers_line).not.toContain("not-a-real-private-key");
  });

  it("refuses to overwrite an existing device.toml", async () => {
    const dir = await home();
    const paths = skepPaths(dir);
    await writeFile(paths.deviceToml, "already here\n");
    await expect(
      initDevice(
        {
          paths,
          device: "mac",
          blackboardUrl: "git@example.invalid:owner/bb.git",
          repos: [],
          genesis: false,
        },
        { exec: unusedExec, generateKey: fakeKeygen() },
      ),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses to replace an existing daemon key", async () => {
    const dir = await home();
    const paths = skepPaths(dir);
    await mkdir(paths.keysDir, { recursive: true });
    await writeFile(path.join(paths.keysDir, "daemon"), "kept\n");
    await expect(
      initDevice(
        {
          paths,
          device: "vps",
          blackboardUrl: "git@example.invalid:owner/bb.git",
          repos: [],
          genesis: false,
        },
        { exec: unusedExec, generateKey: fakeKeygen() },
      ),
    ).rejects.toThrow(/signing key already exists/);
  });

  it("requires the human key for --genesis", async () => {
    const dir = await home();
    await expect(
      initDevice(
        {
          paths: skepPaths(dir),
          device: "mac",
          blackboardUrl: "git@example.invalid:owner/bb.git",
          repos: [],
          genesis: true,
        },
        { exec: unusedExec, generateKey: fakeKeygen() },
      ),
    ).rejects.toThrow(/--human-key/);
  });

  it("writes the local allowed_signers with the human and daemon lines on genesis", async () => {
    const dir = await home();
    const paths = skepPaths(dir);
    await writeFile(`${path.join(dir, "human-key")}.pub`, `${HUMAN_PUB}\n`);
    const result = await initDevice(
      {
        paths,
        device: "mac",
        blackboardUrl: "git@example.invalid:owner/blackboard.git",
        repos: [],
        genesis: true,
        humanKeyPath: path.join(dir, "human-key"),
        blackboardId: "bb_test0001",
        createdAt: "2026-10-05T00:00:00Z",
      },
      { exec: unusedExec, generateKey: fakeKeygen(), createGenesis: async () => "a".repeat(40) },
    );
    const trust = await readFile(paths.allowedSigners, "utf8");
    expect(trust).toBe(`human namespaces="git" ${HUMAN_PUB}\ndaemon:mac namespaces="git" ${PUB}\n`);
    expect(result.allowed_signers).toBe(trust);
    expect((await stat(paths.allowedSigners)).mode & 0o777).toBe(0o600);
    // The trust root holds public keys only (D19).
    expect(trust).not.toContain("PRIVATE");
  });

  it("retries a genesis after a failure without regenerating the key", async () => {
    const dir = await home();
    const paths = skepPaths(dir);
    await writeFile(`${path.join(dir, "human-key")}.pub`, `${HUMAN_PUB}\n`);
    const request = {
      paths,
      device: "mac",
      blackboardUrl: "git@example.invalid:owner/blackboard.git",
      repos: [],
      genesis: true,
      humanKeyPath: path.join(dir, "human-key"),
      createdAt: "2026-10-05T00:00:00Z",
    };
    await expect(
      initDevice(request, {
        exec: unusedExec,
        generateKey: fakeKeygen(),
        createGenesis: async () => {
          throw new Error("human key unusable");
        },
      }),
    ).rejects.toThrow(/human key unusable/);
    const keyBefore = await readFile(path.join(paths.keysDir, "daemon"), "utf8");

    let mintedAgain = false;
    const result = await initDevice(request, {
      exec: unusedExec,
      generateKey: async (keysDir) => {
        mintedAgain = true;
        const generate = fakeKeygen();
        if (!generate) throw new Error("missing keygen");
        return generate(keysDir);
      },
      createGenesis: async () => "b".repeat(40),
    });
    expect(mintedAgain).toBe(false);
    expect(await readFile(path.join(paths.keysDir, "daemon"), "utf8")).toBe(keyBefore);
    expect(result.genesis_sha).toBe("b".repeat(40));
  });

  it("creates the genesis with the human signer and records its sha", async () => {
    const dir = await home();
    await writeFile(`${path.join(dir, "human-key")}.pub`, `${HUMAN_PUB}\n`);
    let seenPrincipal = "";
    const result = await initDevice(
      {
        paths: skepPaths(dir),
        device: "mac",
        blackboardUrl: "git@example.invalid:owner/blackboard.git",
        repos: [],
        genesis: true,
        humanKeyPath: path.join(dir, "human-key"),
        blackboardId: "bb_test0001",
        createdAt: "2026-10-05T00:00:00Z",
      },
      {
        exec: unusedExec,
        generateKey: fakeKeygen(),
        createGenesis: async (deps) => {
          seenPrincipal = deps.signer.principal;
          expect(deps.genesis.blackboard_id).toBe("bb_test0001");
          expect(deps.genesis.reducer_version).toBe(1);
          expect(deps.allowedSignersText).toContain(`daemon:mac namespaces="git" ${PUB}`);
          // The policy copy is audit data; it must not contain the private key (D19).
          expect(deps.allowedSignersText).not.toContain("PRIVATE");
          return "a".repeat(40);
        },
      },
    );
    expect(seenPrincipal).toBe("human");
    expect(result.genesis_sha).toBe("a".repeat(40));
  });

  it("rejects a repo spec that is not name=url", async () => {
    const dir = await home();
    const cap = capture(dir);
    const code = await runCli(
      [
        "init",
        "--device",
        "mac",
        "--blackboard",
        "git@example.invalid:owner/bb.git",
        "--repo",
        "App",
      ],
      cap.ctx,
    );
    expect(code).toBe(2);
    expect(cap.stderr).toMatch(/name=url/);
  });
});

describe("skep init", () => {
  it("prints the allowed_signers line and one JSON result with --machine", async () => {
    const dir = await home();
    const cap = capture(dir);
    // The command shells out to ssh-keygen for real here: that is the production path.
    const code = await runCli(
      ["init", "--device", "mac", "--blackboard", "git@example.invalid:owner/blackboard.git"],
      cap.ctx,
    );
    expect(code).toBe(0);
    expect(cap.stdout).toContain(`daemon:mac namespaces="git" ssh-ed25519`);
    expect(cap.stdout).toContain("private key stays on this device");
    const key = path.join(skepPaths(dir).keysDir, "daemon");
    expect((await stat(key)).mode & 0o777).toBe(0o600);

    const again = capture(dir);
    const machine = await runCli(
      [
        "--machine",
        "--home",
        dir,
        "init",
        "--device",
        "vps",
        "--blackboard",
        "git@example.invalid:o/bb.git",
      ],
      again.ctx,
    );
    // A second init must not overwrite the first device.
    expect(machine).not.toBe(0);
    const line = again.stdout.split("\n").filter((l) => l !== "");
    expect(line).toHaveLength(1);
    expect(JSON.parse(line[0] ?? "")).toMatchObject({ ok: false });
  });

  it("reports a keygen failure instead of writing a half configuration", async () => {
    const dir = await home();
    const paths = skepPaths(dir);
    const exec: InitDeps["exec"] = async () => {
      const result: ExecResult = {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "no entropy",
        timedOut: false,
      };
      throw Object.assign(new Error("ssh-keygen failed"), { result });
    };
    await expect(
      initDevice(
        {
          paths,
          device: "mac",
          blackboardUrl: "git@example.invalid:owner/bb.git",
          repos: [],
          genesis: false,
        },
        { exec },
      ),
    ).rejects.toThrow(/daemon key/);
    await expect(stat(paths.deviceToml)).rejects.toThrow();
  });
});

const unusedExec: InitDeps["exec"] = async () => {
  throw new Error("exec should not be called when generateKey is injected");
};
