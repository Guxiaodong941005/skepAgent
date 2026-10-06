import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SK-614 (follow-up H16) checks over `docs/RUNBOOK.md`: on the Mac the human runs `skep` with their
 * own home, the human key belongs to the human's account, and the socket is opened to the human
 * through `skepd --socket-group`. Kept apart from `runbook.test.ts` so SK-612 can edit that file.
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const runbook = readFileSync(join(ROOT, "docs/RUNBOOK.md"), "utf8");

function between(start: string, end: string): string {
  const from = runbook.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThan(-1);
  const to = runbook.indexOf(end, from + start.length);
  return to === -1 ? runbook.slice(from) : runbook.slice(from, to);
}

describe("runbook: the human's CLI home on the Mac (H16)", () => {
  const home = between("#### The human's CLI home", "### 1.2");

  it("names ~/.skep with human_signing_key and allowed_signers", () => {
    expect(home).toMatch(/~\/\.skep\/device\.toml/);
    expect(home).toMatch(/~\/\.skep\/allowed_signers/);
    expect(home).toMatch(/human_signing_key = "/);
    expect(home).toMatch(/schema = "skep\.device\/v1"/);
    // The schema requires signing_key even in a home that never runs a daemon.
    expect(home).toMatch(/signing_key = "/);
    expect(home).toMatch(/does not write `human_signing_key`/);
    expect(home).toMatch(/never `--home\s+\/var\/lib\/skep`/);
  });

  it("keeps the human key in the human's account, not under the daemon's home", () => {
    const controller = between("### 1.1", "#### The human's CLI home");
    expect(controller).toMatch(/human's own account/);
    expect(controller).toMatch(
      /ssh-keygen -t ed25519 -C human@example\.invalid -f ~\/\.skep\/keys\/human/,
    );
    expect(controller).toMatch(/--human-key ~\/\.skep\/keys\/human/);
    expect(runbook).not.toMatch(/\/var\/lib\/skep\/keys\/human/);
    expect(runbook).toMatch(/Do not run human commands as `sudo skep --home \/var\/lib\/skep`/);
  });

  it("covers both CLI paths: the daemon socket and the in-process fallback", () => {
    expect(home).toMatch(/ln -s \/var\/lib\/skep\/skepd\.sock ~\/\.skep\/skepd\.sock/);
    expect(home).toMatch(/~\/\.skep\/cli-blackboard/);
    expect(home).toMatch(/private key never reaches the daemon/);
  });

  it("documents skepd --socket-group as the Mac socket interface", () => {
    const socket = between(
      "**The socket on macOS (`--socket-group`).**",
      "Linux (`vps`), as root:",
    );
    expect(socket).toMatch(/skepd --socket-group <name>/);
    expect(socket).toMatch(/0660/);
    expect(socket).toMatch(/0750/);
    expect(socket).toMatch(/defaults stay 0600 and 0700/);
    expect(socket).toMatch(/plist passes `--socket-group skep`/);
    expect(socket).toMatch(/dseditgroup -o edit -a <you> -t user skep/);
  });

  it("keeps the human's copy of the trust root in step with rotations", () => {
    const rotation = between("### 3.2 Human key", "### 3.3");
    expect(rotation).toMatch(/~\/\.skep\/allowed_signers/);
    expect(rotation).toMatch(/human_signing_key/);
    const everyday = between("## 6. Everyday commands", "| Command |");
    expect(everyday).toMatch(/your own account with your own home/);
  });
});
