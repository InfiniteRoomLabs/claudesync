import { describe, it, expect, vi } from "vitest";
import { AdaptiveController } from "@core/concurrency/controller.js";

function make(
  overrides: Partial<ConstructorParameters<typeof AdaptiveController>[0]> = {}
) {
  return new AdaptiveController({
    min: 1,
    max: 8,
    start: 2,
    increaseAfter: 3,
    decreaseFactor: 0.5,
    minGapMs: 0,
    ...overrides,
  });
}

describe("AdaptiveController", () => {
  it("clamps the start limit into [min, max]", () => {
    expect(make({ start: 100 }).limit).toBe(8);
    expect(make({ start: 0, min: 2 }).limit).toBe(2);
  });

  it("additively increases after N consecutive successes", () => {
    const c = make({ start: 2, increaseAfter: 3, max: 8 });
    c.onRequestSuccess();
    c.onRequestSuccess();
    expect(c.limit).toBe(2);
    c.onRequestSuccess();
    expect(c.limit).toBe(3);
  });

  it("caps the limit at max", () => {
    const c = make({ start: 7, max: 8, increaseAfter: 1 });
    c.onRequestSuccess();
    c.onRequestSuccess();
    expect(c.limit).toBe(8);
  });

  it("halves on throttle and floors at min", () => {
    const c = make({ start: 8, min: 2, decreaseFactor: 0.5 });
    c.onThrottle(0);
    expect(c.limit).toBe(4);
    c.onThrottle(0);
    expect(c.limit).toBe(2);
    c.onThrottle(0);
    expect(c.limit).toBe(2);
  });

  it("resets the success streak on throttle", () => {
    const c = make({ start: 4, increaseAfter: 3 });
    c.onRequestSuccess();
    c.onRequestSuccess();
    c.onThrottle(0);
    c.onRequestSuccess();
    c.onRequestSuccess();
    expect(c.limit).toBe(2);
  });

  it("pauses until the server resets_at", () => {
    const now = 1_000_000;
    const c = make({ clock: { now: () => now, sleep: async () => {} } });
    expect(c.isPaused(now)).toBe(false);
    c.onThrottle(now / 1000 + 30);
    expect(c.isPaused(now)).toBe(true);
    expect(c.isPaused(now + 31_000)).toBe(false);
  });

  it("halves only once per congestion window (concurrent 429 burst)", () => {
    const now = 5_000_000;
    const c = make({
      start: 8,
      min: 1,
      decreaseFactor: 0.5,
      clock: { now: () => now, sleep: async () => {} },
    });
    // A burst of 429s from the SAME window (all report a future resets_at).
    const resetsAt = now / 1000 + 30;
    c.onThrottle(resetsAt); // first reaction: 8 -> 4
    c.onThrottle(resetsAt); // same window: no further halving
    c.onThrottle(resetsAt);
    c.onThrottle(resetsAt);
    expect(c.limit).toBe(4);
    expect(c.isPaused(now)).toBe(true);
  });

  it("halves again once a new window opens after the previous cleared", () => {
    let t = 6_000_000;
    const c = make({
      start: 8,
      min: 1,
      decreaseFactor: 0.5,
      clock: { now: () => t, sleep: async () => {} },
    });
    c.onThrottle(t / 1000 + 10); // 8 -> 4, pause ~10s
    t += 11_000; // window elapses
    c.onThrottle(t / 1000 + 10); // new window: 4 -> 2
    expect(c.limit).toBe(2);
  });

  it("fires the onThrottle observer with the new limit and resume hint", () => {
    const now = 2_000_000;
    const obs = vi.fn();
    const c = make({
      start: 8,
      clock: { now: () => now, sleep: async () => {} },
      onThrottle: obs,
    });
    c.onThrottle(now / 1000 + 10);
    expect(obs).toHaveBeenCalledWith(4, 10);
  });

  it("acquireRequestSlot resolves immediately with zero gap and no pause", async () => {
    const c = make({ minGapMs: 0 });
    await expect(c.acquireRequestSlot()).resolves.toBeUndefined();
  });
});
