import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * SK-608 acceptance checks over the service units and the runbook.
 *
 * The units and docs are the deliverable; these tests pin the procedures the brief requires so a
 * later edit cannot quietly drop one (setup, key rotation, revoke, re-genesis, D18, D19, G2, G11).
 */

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const runbook = readFileSync(join(ROOT, "docs/RUNBOOK.md"), "utf8");
const service = readFileSync(join(ROOT, "deploy/skepd.service"), "utf8");
const plist = readFileSync(join(ROOT, "deploy/com.skepagent.skepd.plist"), "utf8");

/** Headings are the procedure index: each required procedure is its own section. */
function section(heading: string): string {
  const start = runbook.indexOf(`\n## ${heading}`);
  expect(start, `missing section ${heading}`).toBeGreaterThan(-1);
  const rest = runbook.slice(start + 1);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("runbook procedures (SK-608)", () => {
  it("documents setup from the device's own console", () => {
    const setup = section("1. Setup");
    expect(setup).toMatch(/skep init/);
    expect(setup).toMatch(/--device mac/);
    expect(setup).toMatch(/--device vps/);
    expect(setup).toMatch(/--genesis/);
    expect(setup).toMatch(/--human-key/);
    // D18: provisioning never dials the device. The key line is copied out, the trust root copied in.
    expect(setup).toMatch(/own console or shell/i);
    expect(setup).toMatch(/no step dials the device/i);
    expect(setup).toMatch(/printed line/);
    expect(setup).toMatch(/any channel/i);
  });

  it("documents daemon and human key rotation", () => {
    const rotation = section("3. Key rotation");
    expect(rotation).toMatch(/daemon key/i);
    expect(rotation).toMatch(/human key/i);
    expect(rotation).toMatch(/ssh-keygen -t ed25519/);
    // Old public keys stay until retired, so already-signed history keeps verifying.
    expect(rotation).toMatch(/old public key[\s\S]{0,40}stays in `allowed_signers`/i);
    expect(rotation).toMatch(/every\*\* device/);
  });

  it("documents manual lease revoke with the epoch flag", () => {
    const revoke = section("4. Revoke a lease");
    expect(revoke).toMatch(/skep lease revoke <task> <item> --epoch <n>/);
    expect(revoke).toMatch(/human-signed/i);
    expect(revoke).toMatch(/do not expire on a timer/i);
  });

  it("documents the human-only re-genesis purge", () => {
    const regen = section("5. Re-genesis");
    expect(regen).toMatch(/human-only/i);
    expect(regen).toMatch(/not automated/i);
    expect(regen).toMatch(/new\*\* blackboard repository/);
    expect(regen).toMatch(/--genesis/);
    expect(regen).toMatch(/skep doctor/);
    // The purge must not become an import of the history being purged.
    expect(regen).toMatch(/no event that imports the old log/i);
  });

  it("states the D19 non-goal and local-only provider configuration", () => {
    expect(runbook).toMatch(
      /never transports, stores, syncs or brokers provider[\s\S]{0,20}credentials/i,
    );
    expect(runbook).toMatch(/not as plaintext/);
    expect(runbook).toMatch(/not as ciphertext/);
    expect(runbook).toMatch(/not as a hash/);
    expect(runbook).toMatch(/not as a label/);
    const setup = section("1. Setup");
    expect(setup).toMatch(/Configure the agent CLI locally/);
    expect(setup).toMatch(/On \*\*each\*\* device/);
    expect(setup).toMatch(/no command that copies it to another device/i);
  });

  it("explains the three capabilities and the macOS root LaunchDaemon", () => {
    const install = section("1. Setup");
    expect(install).toMatch(/CAP_SETUID/);
    expect(install).toMatch(/CAP_SETGID/);
    expect(install).toMatch(/CAP_CHOWN/);
    expect(install).toMatch(/exactly three capabilities/);
    expect(install).toMatch(/LaunchDaemon under root/);
    // Until the socket group is configurable, the Mac keeps working through the fallback.
    expect(install).toMatch(/0660/);
    expect(install).toMatch(
      /in-process fallback publisher[\s\S]{0,40}remains usable on the[\s\S]{0,10}Mac/,
    );
    // Ownership: daemon-only state, agent-readable roles, agent-writable home.
    const layout = section("Layout on a device");
    expect(layout).toMatch(/Daemon-only/);
    expect(layout).toMatch(/Agent-readable/);
    expect(layout).toMatch(/Agent-writable/);
    expect(layout).toMatch(/\/var\/lib\/skep-roles/);
    expect(layout).toMatch(/0750/);
    expect(layout).toMatch(/ProtectHome=true/);
  });

  it("documents provisioning without Tailscale and fingerprint comparison (D18)", () => {
    expect(runbook).toMatch(/no mesh VPN/i);
    expect(runbook).toMatch(/never[\s\S]{0,20}dependenc/i);
    const trust = section("2. Trust root and fingerprint comparison");
    expect(trust).toMatch(/ssh-keygen -l -f \/var\/lib\/skep\/keys\/daemon\.pub/);
    expect(trust).toMatch(/ssh-keygen -l -f \/var\/lib\/skep\/allowed_signers/);
    expect(trust).toMatch(/out of band/i);
    expect(trust).toMatch(/first trust is never taken from the channel/i);
    // Manual until enrollment bundles exist.
    expect(runbook).toMatch(/SK-702/);
  });

  it("requires a revoke plus a human-approved replan to move an item (G2)", () => {
    const moving = runbook.slice(runbook.indexOf("### 4.1"));
    expect(moving).toMatch(
      /moving an item to another agent requires a revoke plus a\s+human-approved replan/i,
    );
    expect(moving).toMatch(/no reassign event/i);
    expect(moving).toMatch(/skep lease revoke/);
    expect(moving).toMatch(/skep replan <task> --reason/);
    expect(moving).toMatch(/skep plan approve <task>/);
  });

  it("documents explicit GH_TOKEN and the check-env denylist (G11)", () => {
    const token = runbook.slice(runbook.indexOf("### 1.5"), runbook.indexOf("### 1.6"));
    expect(token).toMatch(/GH_TOKEN/);
    expect(token).toMatch(/headless/i);
    expect(token).toMatch(/passed \*\*explicitly\*\*/);
    expect(token).toMatch(/code-host credential of the daemon, not a provider credential/i);
    expect(token).toMatch(/not[\s\S]{0,20}forwarded to agent subprocesses or to check commands/i);

    const denylist = runbook.slice(runbook.indexOf("### 1.6"), runbook.indexOf("### 1.7"));
    for (const prefix of [
      "GIT_",
      "SSH_",
      "GH_",
      "GITHUB_",
      "OPENAI_",
      "ANTHROPIC_",
      "AZURE_",
      "AWS_",
      "GOOGLE_",
      "GEMINI_",
      "CODEX_",
      "CLAUDE_",
      "PI_CODING_",
    ]) {
      expect(denylist).toContain(prefix);
    }
    expect(denylist).toMatch(/KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL\(S\), AUTH or PROVIDER/);
    expect(denylist).toMatch(/CACHE_KEY/);
  });

  it("uses example.invalid and never a real host, address, or absolute host path", () => {
    const files = [runbook, service, plist];
    for (const text of files) {
      // Naming Tailscale only to say it is not a dependency is the D18 statement.
      expect(text).not.toMatch(/over Tailscale|Tailscale SSH|tailnet/i);
      expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      // example.invalid is the only host. Log names (skepd.out.log) are not hosts.
      expect(text).not.toMatch(
        /\b(?!example\.invalid\b)[a-z0-9-]+\.(?:com|net|org|io|dev|sh|app)\b/i,
      );
      expect(text).not.toMatch(/@[a-z0-9.-]*\.(?:com|net|org|io|dev|sh|app)\b/i);
      expect(text).not.toMatch(/\/root\/|\/home\/[a-z]/);
    }
    expect(runbook).toMatch(/example\.invalid/);
    expect(service).toMatch(/example\.invalid/);
    // The human-key comment is a placeholder, not a personal address.
    expect(runbook).toMatch(/human@example\.invalid/);
  });
});

describe("service units (SK-608)", () => {
  it("runs skepd with the flags it accepts and no network listener", () => {
    for (const unit of [service, plist]) {
      expect(unit).toMatch(/skepd\.js/);
      expect(unit).toMatch(/--home/);
      expect(unit).toMatch(/--role-dir/);
      expect(unit).toMatch(/--agent-user/);
      expect(unit).toMatch(/--agent-home/);
      expect(unit).toMatch(/--agent-path/);
      // D18: supervision does not open a port. Socket is the Unix socket under the home.
      expect(unit).not.toMatch(/ListenStream|ListenDatagram|\bPort\b|0\.0\.0\.0/);
    }
    expect(service).toMatch(/SKEP_HOME=\/var\/lib\/skep/);
    expect(service).toMatch(/^User=skep$/m);
    expect(service).toMatch(/WantedBy=multi-user\.target/);
    // Role directories sit outside the 0700 state root, or the agent cannot traverse to them.
    expect(service).toMatch(/--role-dir \/var\/lib\/skep-roles\/coding/);
    expect(service).not.toMatch(/--role-dir \/var\/lib\/skep\/roles/);
    expect(plist).toMatch(/<key>Label<\/key>\s*<string>com\.skepagent\.skepd<\/string>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("keeps provider credentials and GH_TOKEN out of the unit environment", () => {
    for (const unit of [service, plist]) {
      expect(unit).not.toMatch(/GH_TOKEN=/);
      expect(unit).not.toMatch(/GITHUB_TOKEN|OPENAI_|ANTHROPIC_|API_KEY/);
      expect(unit).toMatch(/D19/);
      expect(unit).toMatch(/docs\/RUNBOOK\.md/);
    }
    // The agent user is not the daemon user (PRD §11.4).
    expect(service).toMatch(/--agent-user skep-agent/);
    expect(service).not.toMatch(/--agent-user skep( |\\)/);
  });

  it("grants exactly the privileges --agent-user needs", () => {
    // Linux: spawn as the agent uid/gid and chown the checkout. No other capability.
    expect(service).toMatch(/^AmbientCapabilities=CAP_SETUID CAP_SETGID CAP_CHOWN$/m);
    expect(service).toMatch(/^CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_CHOWN$/m);
    expect(service).toMatch(/^NoNewPrivileges=true$/m);
    expect(service).toMatch(/^User=skep$/m);
    const granted = service.match(/^AmbientCapabilities=(.+)$/m)?.[1]?.split(/\s+/) ?? [];
    expect(granted).toEqual(["CAP_SETUID", "CAP_SETGID", "CAP_CHOWN"]);
    // The agent home must be writable inside the unit's mount namespace.
    expect(service).toMatch(/^ReadWritePaths=.*\/var\/lib\/skep-agent/m);
    expect(service).toMatch(/^ReadWritePaths=.*\/var\/lib\/skep-roles/m);
    expect(service).toMatch(/^ProtectHome=true$/m);

    // macOS: a LaunchDaemon under root is the only way to setuid to the agent account.
    expect(plist).toMatch(/<key>UserName<\/key>\s*<string>root<\/string>/);
    expect(plist).toMatch(/\/Library\/LaunchDaemons\//);
    expect(plist).not.toMatch(/LaunchAgents/);
    expect(plist).toMatch(/--agent-user[\s\S]{0,40}<string>skep-agent<\/string>/);
    expect(plist).toMatch(/--role-dir[\s\S]{0,40}<string>\/var\/lib\/skep-roles\/coding<\/string>/);
    expect(plist).toMatch(/<string>\/Library\/Logs\/skep\/skepd\.out\.log<\/string>/);
  });
});
