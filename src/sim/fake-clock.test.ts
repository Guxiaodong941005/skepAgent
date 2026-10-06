import { describe, expect, it } from "vitest";
import { FakeClock, VirtualTime } from "./fake-clock.js";

describe("FakeClock", () => {
  it("resolves sleeps in due order and fires continuations inside the same advance", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    const order: number[] = [];

    const track = (ms: number) => {
      void clock.sleep(ms).then(() => order.push(ms));
    };
    track(30);
    track(10);
    track(20);

    await vt.advance(30);

    expect(order).toEqual([10, 20, 30]);
    expect(vt.now).toBe(30);
    expect(clock.monotonicMs()).toBe(30);
  });

  it("runs a sleep scheduled by a timer continuation when it is already due", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    const order: string[] = [];

    void clock.sleep(10).then(() => {
      order.push("outer");
      void clock.sleep(0).then(() => order.push("inner"));
    });

    await vt.advance(10);

    expect(order).toEqual(["outer", "inner"]);
  });

  it("breaks ties by creation order", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    const order: string[] = [];

    void clock.sleep(5).then(() => order.push("first"));
    void clock.sleep(5).then(() => order.push("second"));

    await vt.advance(5);

    expect(order).toEqual(["first", "second"]);
  });

  it("freezes monotonic time across a suspend while wall time keeps moving", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt, { wallStartMs: 1_000 });

    await vt.advance(500);
    clock.suspend();
    expect(clock.suspended).toBe(true);

    await vt.advance(3_600_000);
    expect(clock.monotonicMs()).toBe(500);
    expect(clock.nowMs()).toBe(1_000 + 500 + 3_600_000);

    clock.resume();
    expect(clock.suspended).toBe(false);
    expect(clock.monotonicMs()).toBe(500);
    expect(clock.nowMs()).toBe(1_000 + 500 + 3_600_000);

    await vt.advance(250);
    expect(clock.monotonicMs()).toBe(750);
  });

  it("holds a pending sleep until resume plus its remaining monotonic time", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    let fired = false;
    void clock.sleep(1000).then(() => {
      fired = true;
    });

    await vt.advance(400);
    clock.suspend();
    await vt.advance(3_600_000);
    expect(fired).toBe(false);

    clock.resume();
    await vt.advance(599);
    expect(fired).toBe(false);

    await vt.advance(1);
    expect(fired).toBe(true);
    expect(clock.monotonicMs()).toBe(1000);
  });

  it("fires a timer that becomes due exactly at the end of an advance", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    let fired = false;
    void clock.sleep(1000).then(() => {
      fired = true;
    });

    await vt.advance(1000);

    expect(fired).toBe(true);
    expect(clock.monotonicMs()).toBe(1000);
  });

  it("does not let a sleep started during suspension fire before resume", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    clock.suspend();

    let fired = false;
    void clock.sleep(1000).then(() => {
      fired = true;
    });

    await vt.advance(10_000);
    expect(fired).toBe(false);

    clock.resume();
    await vt.advance(999);
    expect(fired).toBe(false);
    await vt.advance(1);
    expect(fired).toBe(true);
  });

  it("changes only wall time when the skew changes", () => {
    const vt = new VirtualTime(1_000);
    const clock = new FakeClock(vt);

    const beforeMono = clock.monotonicMs();
    const beforeWall = clock.nowMs();
    clock.setSkew(250);

    expect(clock.monotonicMs()).toBe(beforeMono);
    expect(clock.nowMs()).toBe(beforeWall + 250);
  });

  it("rejects an aborted sleep with AbortError and never fires it", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    const controller = new AbortController();

    let fired = false;
    const pending = clock.sleep(1000, controller.signal).then(
      () => {
        fired = true;
      },
      (err: unknown) => err,
    );

    await vt.advance(500);
    controller.abort();
    const error = await pending;

    expect(fired).toBe(false);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");

    await vt.advance(10_000);
    expect(fired).toBe(false);
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("rejects a sleep whose signal is already aborted", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    const controller = new AbortController();
    controller.abort();

    await expect(clock.sleep(1000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(vt.nextTimerAt()).toBeNull();
  });

  it("does not run a timer while its clock is suspended", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    let fired = false;
    void clock.sleep(1000).then(() => {
      fired = true;
    });
    clock.suspend();

    const before = vt.now;
    expect(await vt.runNext()).toBe(false);

    expect(fired).toBe(false);
    expect(vt.now).toBe(before);
    expect(clock.monotonicMs()).toBe(0);
    expect(clock.suspended).toBe(true);
  });

  it("ignores suspended clocks when reporting the next timer", async () => {
    const vt = new VirtualTime();
    const asleep = new FakeClock(vt);
    void asleep.sleep(1000);
    asleep.suspend();

    expect(vt.nextTimerAt()).toBeNull();
    await vt.advance(500);
    expect(vt.nextTimerAt()).toBeNull();

    const awake = new FakeClock(vt);
    void awake.sleep(300);
    expect(vt.nextTimerAt()).toBe(vt.now + 300);
  });

  it("runs the awake clock's timer before a suspended one's", async () => {
    const vt = new VirtualTime();
    const asleep = new FakeClock(vt);
    const awake = new FakeClock(vt);
    const order: string[] = [];

    void asleep.sleep(100).then(() => order.push("asleep"));
    asleep.suspend();
    void awake.sleep(500).then(() => order.push("awake"));

    expect(await vt.runNext()).toBe(true);
    expect(order).toEqual(["awake"]);
    expect(vt.now).toBe(500);
    expect(asleep.monotonicMs()).toBe(0);

    expect(await vt.runNext()).toBe(false);

    asleep.resume();
    expect(vt.nextTimerAt()).toBe(vt.now + 100);
    expect(await vt.runNext()).toBe(true);
    expect(order).toEqual(["awake", "asleep"]);
    expect(asleep.monotonicMs()).toBe(100);
  });

  it("reports the next timer and fires one at a time", async () => {
    const vt = new VirtualTime();
    const clock = new FakeClock(vt);
    expect(vt.nextTimerAt()).toBeNull();

    const order: number[] = [];
    void clock.sleep(20).then(() => order.push(20));
    void clock.sleep(5).then(() => order.push(5));
    expect(vt.nextTimerAt()).toBe(5);

    expect(await vt.runNext()).toBe(true);
    expect(order).toEqual([5]);
    expect(vt.now).toBe(5);

    expect(await vt.runNext()).toBe(true);
    expect(order).toEqual([5, 20]);
    expect(await vt.runNext()).toBe(false);
  });

  it("keeps two clocks on one base independent, including per-clock suspend", async () => {
    const vt = new VirtualTime();
    const awake = new FakeClock(vt);
    const asleep = new FakeClock(vt, { skewMs: 5 });
    const order: string[] = [];

    void awake.sleep(10).then(() => order.push("awake"));
    void asleep.sleep(10).then(() => order.push("asleep"));
    asleep.suspend();

    await vt.advance(10);
    expect(order).toEqual(["awake"]);
    expect(asleep.monotonicMs()).toBe(0);
    expect(asleep.nowMs()).toBe(15);

    asleep.resume();
    await vt.advance(10);
    expect(order).toEqual(["awake", "asleep"]);
  });
});
