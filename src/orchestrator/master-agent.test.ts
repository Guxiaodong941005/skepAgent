import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult } from "../util/exec.js";
import type { RandomSource } from "../util/random.js";
import {
  CliMasterAgent,
  MasterAgentError,
  masterArgv,
  parseMasterOutput,
  type RunCli,
} from "./master-agent.js";

/** Output shapes recorded from the real CLIs in the Phase 0 spike (trimmed). */
const CLAUDE_OK = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "PLUM",
  session_id: "3c355b39-9e8d-4bf7-b1d1-d5d4726b372e",
  duration_ms: 5386,
});
const CODEX_OK = [
  '{"type":"thread.started","thread_id":"01a13373-7e35-7fd0-a3c5-bb0847a483d6"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PLUM"}}',
  '{"type":"turn.completed","usage":{"input_tokens":20754,"output_tokens":34}}',
].join("\n");
const PI_OK = [
  '{"type":"session","version":3,"id":"fed42d83-8f2e-4448-9bdd-d73295ad72ea","cwd":"/tmp/x"}',
  '{"type":"agent_start"}',
  '{"type":"agent_end","messages":[{"role":"user","content":[{"type":"text","text":"q"}]},' +
    '{"role":"assistant","content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"PLUM"}]}]}',
  '{"type":"agent_settled"}',
].join("\n");

const fixedRandom: RandomSource = { bytes: (n) => new Uint8Array(n).fill(7) };
const UUID = "07070707-0707-4707-8707-070707070707";

function fakeRun(outputs: Partial<ExecResult>[]): RunCli & {
  calls: { file: string; args: string[]; opts: ExecOptions }[];
} {
  const calls: { file: string; args: string[]; opts: ExecOptions }[] = [];
  const run = async (file: string, args: string[], opts: ExecOptions): Promise<ExecResult> => {
    calls.push({ file, args, opts });
    const next = outputs.shift() ?? {};
    return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...next };
  };
  return Object.assign(run, { calls });
}

describe("masterArgv (spike §2 pins)", () => {
  it("claude: --session-id first, --resume after; read-only tools and plan mode", () => {
    expect(masterArgv("claude", "u-1", false)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--session-id",
      "u-1",
      "--permission-mode",
      "plan",
      "--tools",
      "Read,Grep,Glob",
    ]);
    expect(masterArgv("claude", "u-1", true)).toContain("--resume");
    expect(masterArgv("claude", "u-1", true)).not.toContain("--session-id");
  });

  it("codex: read-only sandbox, then exec resume with the config override", () => {
    expect(masterArgv("codex", null, false)).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "-",
    ]);
    expect(masterArgv("codex", "t-1", true)).toEqual([
      "exec",
      "resume",
      "--json",
      "-c",
      'sandbox_mode="read-only"',
      "--skip-git-repo-check",
      "t-1",
      "-",
    ]);
  });

  it("pi: the same argv every turn, read-only tools only", () => {
    const argv = ["-p", "--mode", "json", "--session-id", "u-1", "--tools", "read,grep,find,ls"];
    expect(masterArgv("pi", "u-1", false)).toEqual(argv);
    expect(masterArgv("pi", "u-1", true)).toEqual(argv);
  });
});

describe("parseMasterOutput", () => {
  it("reads the reply and the conversation id of each CLI", () => {
    expect(parseMasterOutput("claude", CLAUDE_OK)).toEqual({
      text: "PLUM",
      conversationId: "3c355b39-9e8d-4bf7-b1d1-d5d4726b372e",
    });
    expect(parseMasterOutput("codex", CODEX_OK)).toEqual({
      text: "PLUM",
      conversationId: "01a13373-7e35-7fd0-a3c5-bb0847a483d6",
    });
    expect(parseMasterOutput("pi", `warning: something\n${PI_OK}`)).toEqual({
      text: "PLUM",
      conversationId: "fed42d83-8f2e-4448-9bdd-d73295ad72ea",
    });
  });

  it("turns errors and missing replies into MasterAgentError", () => {
    expect(() =>
      parseMasterOutput(
        "claude",
        JSON.stringify({ type: "result", is_error: true, result: "quota", session_id: "x" }),
      ),
    ).toThrow(/claude reported an error.*quota/);
    expect(() => parseMasterOutput("claude", "not json")).toThrow(MasterAgentError);
    expect(() => parseMasterOutput("codex", '{"type":"turn.failed","error":"x"}')).toThrow(
      /codex failed/,
    );
    expect(() => parseMasterOutput("codex", '{"type":"thread.started","thread_id":"t"}')).toThrow(
      /no agent message/,
    );
    expect(() => parseMasterOutput("pi", '{"type":"session","id":"s"}')).toThrow(/no assistant/);
  });
});

describe("CliMasterAgent", () => {
  it("claude: chooses the id, resumes it, sends the prompt on stdin, counts context", async () => {
    const run = fakeRun([
      { stdout: CLAUDE_OK.replace(/3c35[^"]+/, UUID) },
      { stdout: CLAUDE_OK.replace(/3c35[^"]+/, UUID) },
    ]);
    const agent = new CliMasterAgent({
      cli: "claude",
      cwd: "/repo",
      env: { PATH: "/bin" },
      run,
      random: fixedRandom,
    });
    expect(agent.conversationId).toBeNull();
    await agent.turn({ prompt: "refine this" });
    expect(agent.conversationId).toBe(UUID);
    await agent.turn({ prompt: "now summarize" });
    expect(run.calls.map((call) => call.args.slice(3, 5))).toEqual([
      ["--session-id", UUID],
      ["--resume", UUID],
    ]);
    expect(run.calls[0]?.opts).toMatchObject({
      cwd: "/repo",
      input: "refine this",
      env: { PATH: "/bin" },
    });
    expect(agent.contextChars).toBe("refine this".length + "now summarize".length + 8);
    agent.reset();
    expect(agent.conversationId).toBeNull();
    expect(agent.contextChars).toBe(0);
  });

  it("codex: takes the thread id it announces and resumes with it", async () => {
    const run = fakeRun([{ stdout: CODEX_OK }, { stdout: CODEX_OK }]);
    const agent = new CliMasterAgent({
      cli: "codex",
      cwd: "/r",
      env: {},
      run,
      random: fixedRandom,
    });
    await agent.turn({ prompt: "a" });
    await agent.turn({ prompt: "b" });
    expect(run.calls[0]?.args).not.toContain("resume");
    expect(run.calls[1]?.args).toContain("01a13373-7e35-7fd0-a3c5-bb0847a483d6");
  });

  it("a failed first turn never reuses its id; a timeout names the limit", async () => {
    const run = fakeRun([
      { code: 1, stderr: "boom" },
      { timedOut: true, code: null, signal: "SIGTERM" },
    ]);
    let n = 0;
    const counting: RandomSource = { bytes: (size) => new Uint8Array(size).fill(++n) };
    const agent = new CliMasterAgent({ cli: "pi", cwd: "/r", env: {}, run, random: counting });
    await expect(agent.turn({ prompt: "a" })).rejects.toThrow(/master agent pi exited 1: boom/);
    await expect(agent.turn({ prompt: "a", timeoutMs: 2_000 })).rejects.toThrow(
      /timed out after 2s/,
    );
    const ids = run.calls.map((call) => call.args[4]);
    expect(new Set(ids).size).toBe(2);
    expect(agent.conversationId).toBeNull();
  });
});
