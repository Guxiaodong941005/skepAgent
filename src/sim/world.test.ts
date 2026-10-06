import { describe, expect, it } from "vitest";
import { VirtualTime } from "./fake-clock.js";
import { Rng } from "./rng.js";
import { SimScheduler, SimSchedulerError } from "./world.js";

describe("discrete-event scheduler", () => {
  it("orders actions by virtual time, breaks ties reproducibly, and checks every step", async () => {
    async function run(seed: number) {
      const time = new VirtualTime();
      const scheduler = new SimScheduler(time, new Rng(seed));
      const order: string[] = [];
      let checks = 0;
      scheduler.onStep = async () => {
        checks++;
      };
      for (let i = 0; i < 8; i++)
        scheduler.schedule(10, `actor:${i}`, () => {
          order.push(`${i}`);
        });
      scheduler.schedule(5, "human", () => {
        order.push("human");
      });
      while (await scheduler.step()) {
        /* drain finite schedule */
      }
      expect(time.now).toBe(10);
      expect(checks).toBe(9);
      expect(scheduler.trace).toHaveLength(9);
      expect(order[0]).toBe("human");
      return order;
    }
    expect(await run(42)).toEqual(await run(42));
    expect(await run(42)).not.toEqual(await run(43));
  });

  it("interleaves a human action before an actor's delayed operation resumes", async () => {
    const time = new VirtualTime();
    const scheduler = new SimScheduler(time, new Rng(1));
    const clock = scheduler.clock();
    const order: string[] = [];
    scheduler.schedule(0, "actor", async () => {
      order.push("start");
      await clock.sleep(100);
      order.push("finish");
    });
    scheduler.schedule(50, "human", () => {
      order.push("human");
    });
    await scheduler.step();
    expect(order).toEqual(["start", "human", "finish"]);
    expect(time.now).toBe(100);
    expect(scheduler.trace.map((step) => step.label)).toEqual(["human", "timer", "actor"]);
  });

  it("skips suspended nodes until a scheduled resume, then postpones their timers", async () => {
    const time = new VirtualTime();
    const scheduler = new SimScheduler(time, new Rng(2));
    const clock = scheduler.clock({ skewMs: 10_000 });
    clock.suspend();
    let ticks = 0;
    scheduler.schedule(
      0,
      "tick",
      () => {
        ticks++;
      },
      () => !clock.suspended,
    );
    scheduler.schedule(100, "resume", () => {
      clock.resume();
    });
    expect(await scheduler.step()).toBe(true);
    expect(ticks).toBe(0);
    expect(clock.nowMs()).toBe(10_100);
    expect(clock.monotonicMs()).toBe(0);
    await scheduler.step();
    expect(ticks).toBe(1);
  });

  it("drives retries, zero-delay sleeps and aborted sleeps without real timers", async () => {
    const time = new VirtualTime();
    const scheduler = new SimScheduler(time, new Rng(3));
    const clock = scheduler.clock();
    const abort = new AbortController();
    abort.abort();
    await expect(scheduler.execute(() => clock.sleep(10, abort.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(
      await scheduler.execute(async () => {
        await clock.sleep(0);
        await clock.sleep(20);
        await clock.sleep(40);
        return "done";
      }),
    ).toBe("done");
    expect(time.now).toBe(60);
  });

  it("propagates action failures and rejects invalid schedules", async () => {
    const scheduler = new SimScheduler(new VirtualTime(), new Rng(4));
    expect(() => scheduler.schedule(-1, "past", () => {})).toThrow(SimSchedulerError);
    expect(() => scheduler.schedule(0, "", () => {})).toThrow(SimSchedulerError);
    await expect(
      scheduler.execute(() => {
        throw new SimSchedulerError("Actor failed");
      }),
    ).rejects.toThrow("Actor failed");
    expect(await scheduler.step()).toBe(false);
  });

  it("waits for a resumed actor's I/O before advancing another actor's overlapping sleep", async () => {
    const time = new VirtualTime();
    const scheduler = new SimScheduler(time, new Rng(5));
    const first = scheduler.clock();
    const second = scheduler.clock();
    const completions: string[] = [];
    scheduler.schedule(0, "first", async () => {
      await first.sleep(100);
      // Several host turns stand in for git I/O; virtual time must stay at this wake instant.
      for (let i = 0; i < 5; i++) await new Promise<void>((resolveIo) => setImmediate(resolveIo));
      completions.push(`first:${time.now}`);
    });
    scheduler.schedule(50, "second", async () => {
      await second.sleep(100);
      completions.push(`second:${time.now}`);
    });
    await scheduler.step();
    expect(completions).toEqual(["first:100", "second:150"]);
  });

  it("supports nested actor drivers without blocking on their awaiting ancestors", async () => {
    const time = new VirtualTime();
    const scheduler = new SimScheduler(time, new Rng(6));
    const clock = scheduler.clock();
    scheduler.schedule(0, "human", async () => {
      const result = await scheduler.execute(async () => {
        await clock.sleep(100);
        return "accepted";
      });
      expect(result).toBe("accepted");
    });
    expect(await scheduler.step()).toBe(true);
    expect(time.now).toBe(100);
  });

  it("honors seeded ties between an action and a clock timer at the same instant", async () => {
    async function run(seed: number) {
      const time = new VirtualTime();
      const scheduler = new SimScheduler(time, new Rng(seed));
      const clock = scheduler.clock();
      const order: string[] = [];
      scheduler.schedule(0, "sleep", async () => {
        await clock.sleep(10);
        order.push("timer");
      });
      scheduler.schedule(10, "actor", () => {
        order.push("actor");
      });
      await scheduler.step();
      while (await scheduler.step()) {
        /* drain finite schedule */
      }
      expect(time.now).toBe(10);
      return order.join(",");
    }
    const orders = new Set<string>();
    for (let seed = 0; seed < 10; seed++) {
      const order = await run(seed);
      expect(await run(seed)).toBe(order);
      orders.add(order);
    }
    expect(orders).toEqual(new Set(["actor,timer", "timer,actor"]));
  });
});
