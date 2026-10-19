import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../cli/program.js";
import { startOrchestration } from "../core/orchestration/reducer.js";
import { Ledger, type LedgerRecord, LedgerRecordSchema } from "./ledger.js";
import { sessionReport } from "./report.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), "skep-report-"));
  roots.push(home);
  return { home, ledger: Ledger.at(home) };
}
function record(id = "O-session-1", createdAtMs = 1000): LedgerRecord {
  return {
    version: 1,
    id,
    createdAtMs,
    updatedAtMs: createdAtMs + 1,
    cli: "codex",
    conversationId: null,
    promptVersion: 4,
    state: {
      ...startOrchestration("O-1", "Add auto-lock", "auto"),
      phase: "done",
      brief: { title: "Auto-lock", text: "Implement with tests" },
      skill: {
        skillId: "iot-ble-feature",
        version: "1.0.0",
        scope: "packaged",
        digest: "a".repeat(64),
      },
      contract: "autoLockMinutes: integer",
      stages: [{ id: "providers", status: "settled" }],
      skippedRoles: ["device (skipped after peer lost)"],
      groups: [
        {
          repo: "device-repo",
          roles: ["device"],
          stage: "providers",
          intentId: "intent-1",
          title: null,
          brief: null,
          error: null,
        },
      ],
      intentIds: ["intent-1"],
      items: [
        {
          itemId: "I-1",
          intentId: "intent-1",
          peerId: "peer-1",
          device: "bench",
          repo: "device-repo",
          verdict: "lost",
          skipped: true,
          summary: "Work stopped",
          changed: {
            total: 1,
            partial: false,
            files: [{ path: "src/timer.ts", change: "modified", added: 3, removed: 1 }],
          },
        },
      ],
      synthesis: "Partial implementation; device skipped",
    },
  };
}

describe("offline orchestration reports", () => {
  it("renders skill, contract, stages, peer outcomes, skipped/lost, changed files, briefs and synthesis", async () => {
    const { ledger } = await setup();
    await ledger.write(record());
    const { text } = await sessionReport(ledger);
    for (const part of [
      "Add auto-lock",
      "Implement with tests",
      "iot-ble-feature",
      "autoLockMinutes",
      "providers: settled",
      "bench",
      "device-repo",
      "lost (skipped deliberately)",
      "src/timer.ts",
      "Work stopped",
      "Partial implementation",
    ])
      expect(text).toContain(part);
    expect(text).toContain("local orchestration ledger only");
  });
  it("selects recent records or an exact id, and emits fully validated JSON without modifying files", async () => {
    const { ledger, home } = await setup();
    await ledger.write(record("O-first-1", 1000));
    await ledger.write(record("O-second-1", 2000));
    const before = await readFile(ledger.file("O-first-1"), "utf8");
    const recent = await sessionReport(ledger, { last: "2", json: true });
    expect(JSON.parse(recent.text).map((r: LedgerRecord) => r.id)).toEqual([
      "O-second-1",
      "O-first-1",
    ]);
    for (const r of JSON.parse(recent.text))
      expect(LedgerRecordSchema.safeParse(r).success).toBe(true);
    expect((await sessionReport(ledger, { id: "O-first-1" })).records).toHaveLength(1);
    expect(await readFile(ledger.file("O-first-1"), "utf8")).toBe(before);
    expect(await readdir(home)).toEqual(["orchestrations"]);
    await expect(sessionReport(ledger, { id: "O-1" })).rejects.toThrow("multiple sessions");
  });
  it("accepts pre-skill ledger records and detects malformed nested item data", async () => {
    const { ledger } = await setup();
    const old = { ...record(), state: startOrchestration("O-1", "Old request", "auto") };
    await ledger.write(old);
    expect((await sessionReport(ledger, { id: "O-1" })).records[0]?.state.skill).toBeUndefined();
    await writeFile(
      ledger.file(old.id),
      JSON.stringify({
        ...record(),
        state: { ...record().state, items: [{ verdict: "invented" }] },
      }),
    );
    const result = await sessionReport(ledger, { json: true });
    expect(JSON.parse(result.text)).toEqual([]);
    expect(result.problems[0]).toContain("O-session-1.json");
    await expect(sessionReport(ledger, { id: "O-session-1" })).rejects.toThrow(
      "No readable orchestration",
    );
  });
  it.each([
    { last: 0 },
    { last: "no" },
    { last: 101 },
    { id: "../../file" },
    { id: "O-1", last: 2 },
  ])("rejects invalid selections %j", async (options) => {
    const { ledger } = await setup();
    await expect(sessionReport(ledger, options)).rejects.toThrow("Invalid report selection");
  });
  it("keeps model supplied fences literal and escapes table cells", async () => {
    const { ledger } = await setup();
    const r = record();
    r.state.userText = "```\n<script>bad</script>";
    if (r.state.items[0]) r.state.items[0].device = "x|<img>";
    await ledger.write(r);
    const { text } = await sessionReport(ledger);
    expect(text).toContain("````text\n```\n<script>bad</script>\n````");
    expect(text).toContain("x\\|&lt;img&gt;");
  });
  it("CLI exports offline with a temp SKEP_HOME and never connects to a session", async () => {
    const { ledger, home } = await setup();
    await ledger.write(record());
    let out = "";
    let err = "";
    const ctx = {
      env: { SKEP_HOME: home },
      stdout: {
        write: (s: string) => {
          out += s;
        },
      },
      stderr: {
        write: (s: string) => {
          err += s;
        },
      },
      output: () => {
        throw new Error("uninitialized output");
      },
    };
    expect(await runCli(["session", "report", "O-session-1", "--json"], ctx)).toBe(0);
    expect(JSON.parse(out)[0].state.items[0].verdict).toBe("lost");
    expect(err).toBe("");
    out = "";
    expect(await runCli(["session", "report", "--last", "1"], ctx)).toBe(0);
    expect(out).toContain("# Skep orchestration report");
    expect(await runCli(["session", "report", "O-1", "--last", "1"], ctx)).not.toBe(0);
  });
});
