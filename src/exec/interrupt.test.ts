import { describe, expect, it, vi } from "vitest";
import type { ProcessExit, ProcessHandle } from "../runtime/types.js";
import { FakeClock, VirtualTime } from "../sim/fake-clock.js";
import type { Clock } from "../util/clock.js";
import { runInterruptLadder } from "./interrupt.js";

function processHandle() {
  let finish: (exit: ProcessExit) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const completion = new Promise<ProcessExit>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const signalGroup = vi.fn<ProcessHandle["signalGroup"]>();
  const h: ProcessHandle = {
    pid: 42,
    pgid: 42,
    startToken: "1234",
    wait: vi.fn(() => completion),
    signalGroup,
  };
  const vt = new VirtualTime();
  const clock = new FakeClock(vt);
  return { h, signalGroup, finish, fail, vt, clock };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("runInterruptLadder", () => {
  it("is assignable to the adapter's two-argument InterruptLadder contract", () => {
    const ladder: (
      h: ProcessHandle,
      clock: Clock,
    ) => Promise<"completed" | "interrupted" | "killed"> = runInterruptLadder;
    expect(ladder).toBe(runInterruptLadder);
  });

  it("returns completed without signals or timers for an already-exited process", async () => {
    const { h, signalGroup, finish, clock, vt } = processHandle();
    finish({ code: 0, signal: null });

    expect(await runInterruptLadder(h, clock)).toBe("completed");
    expect(signalGroup).not.toHaveBeenCalled();
    expect(vt.now).toBe(0);
    expect(vt.nextTimerAt()).toBeNull();
    expect(h.wait).toHaveBeenCalledTimes(1);
  });

  it("returns interrupted on SIGINT completion and cancels the grace timer", async () => {
    const { h, signalGroup, finish, clock, vt } = processHandle();
    const result = runInterruptLadder(h, clock);
    await nextTurn();
    expect(signalGroup.mock.calls).toEqual([["SIGINT"]]);
    expect(vt.nextTimerAt()).toBe(120_000);

    await vt.advance(5_000);
    finish({ code: 0, signal: null });
    expect(await result).toBe("interrupted");
    expect(vt.nextTimerAt()).toBeNull();
    await vt.advance(200_000);
    expect(signalGroup.mock.calls).toEqual([["SIGINT"]]);
  });

  it.each([
    { code: null, signal: "SIGTERM" },
    { code: 0, signal: null },
  ] satisfies ProcessExit[])(
    "returns killed after SIGTERM was needed, even with exit %j",
    async (exit) => {
      const { h, signalGroup, finish, clock, vt } = processHandle();
      const result = runInterruptLadder(h, clock);
      await nextTurn();
      await vt.advance(119_999);
      expect(signalGroup.mock.calls).toEqual([["SIGINT"]]);
      await vt.advance(1);
      expect(signalGroup.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
      expect(vt.nextTimerAt()).toBe(150_000);

      await vt.advance(29_999);
      finish(exit);
      expect(await result).toBe("killed");
      expect(signalGroup.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
      expect(vt.nextTimerAt()).toBeNull();
    },
  );

  it("escalates SIGINT → SIGTERM → SIGKILL and waits for the confirmed exit", async () => {
    const { h, signalGroup, finish, clock, vt } = processHandle();
    let settled = false;
    const result = runInterruptLadder(h, clock).then((outcome) => {
      settled = true;
      return outcome;
    });
    await nextTurn();
    await vt.advance(120_000);
    await vt.advance(29_999);
    expect(signalGroup.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
    await vt.advance(1);
    expect(signalGroup.mock.calls).toEqual([["SIGINT"], ["SIGTERM"], ["SIGKILL"]]);
    expect(settled).toBe(false);
    expect(vt.nextTimerAt()).toBeNull();

    finish({ code: null, signal: "SIGKILL" });
    expect(await result).toBe("killed");
    expect(h.wait).toHaveBeenCalledTimes(1);
  });

  it("honours custom delays, including a zero-duration grace", async () => {
    const { h, signalGroup, finish, clock, vt } = processHandle();
    const result = runInterruptLadder(h, clock, { graceMs: 0, termMs: 25 });
    await nextTurn();
    await vt.advance(0);
    expect(signalGroup.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);
    await vt.advance(24);
    expect(signalGroup).toHaveBeenCalledTimes(2);
    await vt.advance(1);
    expect(signalGroup).toHaveBeenLastCalledWith("SIGKILL");
    finish({ code: null, signal: "SIGKILL" });
    expect(await result).toBe("killed");
  });

  it("pauses the grace interval while the injected monotonic clock is suspended", async () => {
    const { h, signalGroup, finish, clock, vt } = processHandle();
    const result = runInterruptLadder(h, clock, { graceMs: 100, termMs: 30 });
    await nextTurn();
    await vt.advance(40);
    clock.suspend();
    await vt.advance(3_600_000);
    expect(signalGroup.mock.calls).toEqual([["SIGINT"]]);
    clock.resume();
    await vt.advance(59);
    expect(signalGroup).toHaveBeenCalledTimes(1);
    await vt.advance(1);
    expect(signalGroup).toHaveBeenLastCalledWith("SIGTERM");
    finish({ code: null, signal: "SIGTERM" });
    expect(await result).toBe("killed");
    expect(vt.nextTimerAt()).toBeNull();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid delay %s before signalling",
    async (delay) => {
      const { h, signalGroup, clock, vt } = processHandle();
      await expect(runInterruptLadder(h, clock, { graceMs: delay })).rejects.toThrow(RangeError);
      await expect(runInterruptLadder(h, clock, { termMs: delay })).rejects.toThrow(RangeError);
      expect(signalGroup).not.toHaveBeenCalled();
      expect(h.wait).not.toHaveBeenCalled();
      expect(vt.nextTimerAt()).toBeNull();
    },
  );

  it("propagates a failed wait and cancels any pending sleep", async () => {
    const { h, fail, clock, vt } = processHandle();
    const result = runInterruptLadder(h, clock);
    const assertion = expect(result).rejects.toThrow("Cannot observe process exit");
    await vt.advance(0);
    fail(new Error("Cannot observe process exit"));
    await assertion;
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("propagates signal errors without leaving a timer behind", async () => {
    const { h, signalGroup, clock, vt } = processHandle();
    signalGroup.mockImplementation(() => {
      throw new Error("Cannot signal process group");
    });
    await expect(runInterruptLadder(h, clock)).rejects.toThrow("Cannot signal process group");
    expect(vt.nextTimerAt()).toBeNull();
  });
});
