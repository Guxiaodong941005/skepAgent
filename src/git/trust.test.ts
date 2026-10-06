import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../../test/helpers/git-fixture.js";
import { loadTrustRoot, parseAllowedSigners, TrustRoot, TrustRootError } from "./trust.js";

const key = "AAAAC3NzaC1lZDI1NTE5AAAAIOQ=";
const pub = `ssh-ed25519 ${key}`;

describe("parseAllowedSigners", () => {
  it("handles comments, blank lines, CRLF, namespaces and multiple principals (AC 5)", () => {
    const result = parseAllowedSigners(
      `\r\n # local trust\r\nhuman,daemon:mac namespaces="git" ${pub} human and daemon\r\ndaemon:vps\t${pub}\t# device key\r\n`,
    );
    expect(result).toEqual({
      entries: [
        {
          principals: ["human", "daemon:mac"],
          namespaces: ["git"],
          keyType: "ssh-ed25519",
          key,
          comment: "human and daemon",
        },
        {
          principals: ["daemon:vps"],
          namespaces: null,
          keyType: "ssh-ed25519",
          key,
          comment: "# device key",
        },
      ],
      errors: [],
    });
  });

  it("parses comma-separated options without splitting quoted namespace patterns", () => {
    const result = parseAllowedSigners(
      `human cert-authority,namespaces="git,ssh-*",valid-after="20260101",valid-before="20300101000000Z" ${pub}`,
    );
    expect(result.errors).toEqual([]);
    expect(result.entries[0]?.namespaces).toEqual(["git", "ssh-*"]);
  });

  it.each(["admin", "daemon:", "daemon:MAC", "daemon:mac*", "human,invalid", "human,"])(
    "rejects the entire line for invalid principal list %s (AC 5)",
    (principals) => {
      const result = parseAllowedSigners(`# header\n${principals} ${pub}\nhuman ${pub}\n`);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]?.principals).toEqual(["human"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/^line 2: invalid principal/);
    },
  );

  it.each([
    `human namespaces="git ${pub}`,
    `human namespaces="git",namespaces="ssh" ${pub}`,
    `human namespaces="" ${pub}`,
    `human namespaces="git," ${pub}`,
    `human unexpected="git" ${pub}`,
    `human valid-before="yesterday" ${pub}`,
    "human ssh-ed25519",
    "human ssh-ed25519 bad!key",
  ])("reports malformed input instead of trusting it: %s", (line) => {
    const result = parseAllowedSigners(line);
    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("line 1:");
  });
});

describe("TrustRoot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir("trust-");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads only the requested local file and looks up unique principals for an exact key", async () => {
    const path = join(dir, "allowed_signers");
    await writeFile(path, `human,daemon:mac namespaces="git" ${pub}\ndaemon:mac ${pub}\n`);
    const trust = await loadTrustRoot(path);
    expect(trust).toBeInstanceOf(TrustRoot);
    expect(trust.path).toBe(path);
    expect(trust.principalsForKey("ssh-ed25519", key)).toEqual(["human", "daemon:mac"]);
    expect(trust.principalsForKey("ssh-rsa", key)).toEqual([]);
    expect(trust.principalsForKey("ssh-ed25519", "another-key")).toEqual([]);
  });

  it("fails closed on parse errors even when another line is valid", async () => {
    const path = join(dir, "allowed_signers");
    await writeFile(path, `human ${pub}\nattacker ${pub}\n`);
    await expect(loadTrustRoot(path)).rejects.toMatchObject({
      name: "TrustRootError",
      message: expect.stringContaining("line 2: invalid principal"),
    });
  });

  it("reports unreadable files with an actionable typed error", async () => {
    const path = join(dir, "missing");
    await expect(loadTrustRoot(path)).rejects.toBeInstanceOf(TrustRootError);
    await expect(loadTrustRoot(path)).rejects.toThrow(path);
  });

  it("accepts an empty trust root with no trusted principals", async () => {
    const path = join(dir, "allowed_signers");
    await writeFile(path, "# no keys installed\n");
    expect((await loadTrustRoot(path)).entries).toEqual([]);
  });
});
