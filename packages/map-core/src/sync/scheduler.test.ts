import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameScheduler, createManualScheduler } from "./scheduler";

describe("createFrameScheduler (rAF yok → zamanlayıcı)", () => {
  let clock: number;
  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
  });
  afterEach(() => vi.useRealTimers());

  const advance = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  it("ilk görev hemen (bir sonraki tick'te) çalışır", () => {
    const scheduler = createFrameScheduler({ maxApplyHz: 10, now: () => clock });
    const task = vi.fn();
    scheduler.schedule(task);
    expect(task).not.toHaveBeenCalled();
    advance(0);
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("saniyede en fazla maxApplyHz: sonraki görev aralık dolana kadar bekler", () => {
    const scheduler = createFrameScheduler({ maxApplyHz: 10, now: () => clock }); // 100 ms
    const first = vi.fn();
    const second = vi.fn();
    scheduler.schedule(first);
    advance(0);
    scheduler.schedule(second);
    advance(50);
    expect(second).not.toHaveBeenCalled();
    advance(50);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("iptal edilen görev çalışmaz", () => {
    const scheduler = createFrameScheduler({ now: () => clock });
    const task = vi.fn();
    const cancel = scheduler.schedule(task);
    cancel();
    advance(1000);
    expect(task).not.toHaveBeenCalled();
  });
});

describe("createManualScheduler", () => {
  it("görev yalnız run() ile çalışır; iptal edilebilir", () => {
    const scheduler = createManualScheduler();
    const task = vi.fn();
    const cancel = scheduler.schedule(task);
    expect(scheduler.pending).toBe(true);
    cancel();
    expect(scheduler.pending).toBe(false);
    scheduler.run();
    expect(task).not.toHaveBeenCalled();

    scheduler.schedule(task);
    scheduler.run();
    expect(task).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
  });
});
