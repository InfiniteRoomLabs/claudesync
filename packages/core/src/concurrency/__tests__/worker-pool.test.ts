import { describe, it, expect } from "vitest";
import { WorkerPool, type PoolTask } from "../worker-pool.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

describe("WorkerPool", () => {
  it("runs all tasks and drains", async () => {
    let remaining = 10;
    let ran = 0;
    const pool = new WorkerPool({
      limit: () => 3,
      pull: (): PoolTask | undefined => {
        if (remaining <= 0) return undefined;
        remaining -= 1;
        return async () => {
          await tick();
          ran += 1;
        };
      },
      isDone: () => remaining === 0,
    });
    await pool.run();
    expect(ran).toBe(10);
  });

  it("never exceeds the concurrency limit", async () => {
    let remaining = 20;
    let active = 0;
    let peak = 0;
    const pool = new WorkerPool({
      limit: () => 4,
      pull: (): PoolTask | undefined => {
        if (remaining <= 0) return undefined;
        remaining -= 1;
        return async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
        };
      },
      isDone: () => remaining === 0,
    });
    await pool.run();
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("respects a dynamic limit that changes mid-run", async () => {
    let remaining = 30;
    let active = 0;
    let peak = 0;
    let limit = 1;
    const pool = new WorkerPool({
      limit: () => limit,
      pull: (): PoolTask | undefined => {
        if (remaining <= 0) return undefined;
        remaining -= 1;
        return async () => {
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
        };
      },
      isDone: () => remaining === 0,
    });
    setTimeout(() => {
      limit = 5;
    }, 5);
    await pool.run();
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it("waits for gated work then completes (idle poll)", async () => {
    let gateOpen = false;
    let done = false;
    let ran = false;
    const pool = new WorkerPool({
      limit: () => 2,
      pull: (): PoolTask | undefined => {
        if (done) return undefined;
        if (!gateOpen) return undefined;
        done = true;
        return async () => {
          ran = true;
        };
      },
      isDone: () => done,
      idleDelayMs: 2,
    });
    setTimeout(() => {
      gateOpen = true;
    }, 10);
    await pool.run();
    expect(ran).toBe(true);
  });

  it("stops launching new tasks on abort", async () => {
    const ac = new AbortController();
    let started = 0;
    let remaining = 100;
    const pool = new WorkerPool({
      limit: () => 2,
      pull: (): PoolTask | undefined => {
        if (remaining <= 0) return undefined;
        remaining -= 1;
        return async () => {
          started += 1;
          await tick();
        };
      },
      isDone: () => remaining === 0,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 5);
    await pool.run();
    expect(started).toBeLessThan(100);
  });
});
