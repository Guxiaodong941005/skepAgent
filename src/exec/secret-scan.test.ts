import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../../test/helpers/git-fixture.js";
import { ExecError, type ExecResult, type execFileChecked } from "../util/exec.js";
import { SecretScanError, type SecretScanOptions, scanSecrets } from "./secret-scan.js";

describe("gitleaks secret scan", () => {
  const dirs: string[] = [];
  let options: SecretScanOptions;
  const result: ExecResult = { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };

  beforeEach(async () => {
    const root = await tempDir("secret-scan-");
    dirs.push(root);
    options = {
      cwd: root,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      env: {
        home: root,
        user: "agent",
        source: {
          PATH: "example-bin",
          GIT_ASKPASS: "blocked",
          SSH_AUTH_SOCK: "blocked",
          GH_TOKEN: "blocked",
        },
      },
    };
  });

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("scans the pinned commit range with redacted findings and a sanitized environment", async () => {
    const exec = vi.fn<typeof execFileChecked>().mockResolvedValue(result);
    expect(await scanSecrets(options, { exec })).toEqual({ status: "clean" });
    expect(exec).toHaveBeenCalledWith(
      "gitleaks",
      [
        "git",
        "--no-banner",
        "--redact",
        "--exit-code=42",
        `--log-opts=${options.baseSha}..${options.headSha}`,
        ".",
      ],
      {
        cwd: options.cwd,
        env: { PATH: "example-bin", HOME: options.cwd, USER: "agent", LOGNAME: "agent" },
        allowFailure: true,
      },
    );
  });

  it("blocks publication on findings without returning scanner output", async () => {
    const exec = vi.fn<typeof execFileChecked>().mockResolvedValue({
      ...result,
      code: 42,
      stdout: "redacted findings",
      stderr: "redacted findings",
    });
    expect(await scanSecrets(options, { exec })).toEqual({ status: "secrets_detected" });
  });

  it.each([
    { code: 1 },
    { code: 2 },
    { code: 0, timedOut: true },
    { code: null, signal: "SIGTERM" },
    { code: 42, timedOut: true },
  ])("fails closed on scanner errors: %j", async (change) => {
    const exec = vi.fn<typeof execFileChecked>().mockResolvedValue({ ...result, ...change });
    await expect(scanSecrets({ ...options, allowMissingForTests: true }, { exec })).rejects.toThrow(
      SecretScanError,
    );
  });

  function missing() {
    return new ExecError(
      "gitleaks",
      [],
      { ...result, code: null },
      { cause: Object.assign(new Error("unavailable executable"), { code: "ENOENT" }) },
    );
  }

  it("allows an explicit test-only missing-binary skip with a warning", async () => {
    const exec = vi.fn<typeof execFileChecked>().mockRejectedValue(missing());
    const warn = vi.fn();
    const scan = await scanSecrets({ ...options, allowMissingForTests: true }, { exec, warn });
    expect(scan).toMatchObject({
      status: "skipped",
      warning: expect.stringContaining("skipped for this test only"),
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("requires gitleaks in production and does not skip other spawn failures", async () => {
    const exec = vi.fn<typeof execFileChecked>().mockRejectedValue(missing());
    await expect(scanSecrets(options, { exec })).rejects.toThrow("install it before publishing");
    exec.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    await expect(scanSecrets({ ...options, allowMissingForTests: true }, { exec })).rejects.toThrow(
      SecretScanError,
    );
  });

  it("rejects non-SHA refs and missing or non-directory scan roots without invoking gitleaks", async () => {
    const exec = vi.fn<typeof execFileChecked>();
    await expect(scanSecrets({ ...options, baseSha: "HEAD; unsafe" }, { exec })).rejects.toThrow(
      SecretScanError,
    );
    await expect(
      scanSecrets(
        { ...options, cwd: path.join(options.cwd, "missing"), allowMissingForTests: true },
        { exec },
      ),
    ).rejects.toThrow();
    const file = path.join(options.cwd, "example.txt");
    await writeFile(file, "example\n");
    await expect(scanSecrets({ ...options, cwd: file }, { exec })).rejects.toThrow(SecretScanError);
    expect(exec).not.toHaveBeenCalled();
  });
});
