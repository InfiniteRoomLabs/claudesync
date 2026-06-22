import { describe, it, expect } from "vitest";
import { resolveConcurrencyConfig } from "@core/config/index.js";

const noEnv = {} as NodeJS.ProcessEnv;

describe("resolveConcurrencyConfig", () => {
  it("returns built-in defaults with no sources", () => {
    const c = resolveConcurrencyConfig({}, noEnv, {});
    expect(c.pool).toEqual({ min: 1, max: 8, start: 2 });
    expect(c.ramp).toEqual({ increaseAfter: 5, decreaseFactor: 0.5 });
    expect(c.request).toEqual({ minGapMs: 150, maxRetries: 5 });
    expect(c.projectConcurrency).toBeUndefined();
  });

  it("applies config-file values", () => {
    const c = resolveConcurrencyConfig({}, noEnv, {
      pool: { max: 12 },
      request: { minGapMs: 50 },
    });
    expect(c.pool.max).toBe(12);
    expect(c.request.minGapMs).toBe(50);
  });

  it("env overrides file", () => {
    const c = resolveConcurrencyConfig(
      {},
      { CLAUDESYNC_WORKERS: "6" } as NodeJS.ProcessEnv,
      { pool: { max: 12 } }
    );
    expect(c.pool.max).toBe(6);
  });

  it("flag overrides env and file", () => {
    const c = resolveConcurrencyConfig(
      { workers: 3 },
      { CLAUDESYNC_WORKERS: "6" } as NodeJS.ProcessEnv,
      { pool: { max: 12 } }
    );
    expect(c.pool.max).toBe(3);
  });

  it("collapses to sequential when noParallel", () => {
    const c = resolveConcurrencyConfig(
      { noParallel: true, workers: 10 },
      noEnv,
      {}
    );
    expect(c.pool).toEqual({ min: 1, max: 1, start: 1 });
  });

  it("clamps so that 1 <= min <= start <= max", () => {
    const c = resolveConcurrencyConfig(
      { workers: 4, minWorkers: 10, startWorkers: 20 },
      noEnv,
      {}
    );
    expect(c.pool.max).toBe(4);
    expect(c.pool.min).toBe(4);
    expect(c.pool.start).toBe(4);
  });

  it("passes through the per-project cap from flags", () => {
    const c = resolveConcurrencyConfig({ projectWorkers: 2 }, noEnv, {});
    expect(c.projectConcurrency).toBe(2);
  });
});
