import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withProjectMemoryLock } from "@core/memory/lock.js";

let dir: string;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
function mkdir() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mem-lock-"));
  return dir;
}

const LOCK_FILENAME = ".claudesync-memory.lock";
const now = "2026-07-15T00:00:00.000Z";

describe("withProjectMemoryLock", () => {
  it("acquires the lock, runs fn, and releases it (lockfile gone after)", async () => {
    const d = mkdir();
    const lockPath = path.join(d, LOCK_FILENAME);
    let ranInside = false;
    const result = await withProjectMemoryLock(d, async () => {
      ranInside = true;
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    }, { now });
    expect(ranInside).toBe(true);
    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("throws naming the lockfile, pid, and acquired_at when already held", async () => {
    const d = mkdir();
    fs.mkdirSync(d, { recursive: true });
    const lockPath = path.join(d, LOCK_FILENAME);
    const heldAt = "2026-07-15T00:00:00.000Z";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquired_at: heldAt }), "utf-8");

    const laterNow = "2026-07-15T00:01:00.000Z"; // 1 minute later, well under TTL
    await expect(
      withProjectMemoryLock(d, async () => "should not run", { now: laterNow })
    ).rejects.toThrow(/999999/);
    await expect(
      withProjectMemoryLock(d, async () => "should not run", { now: laterNow })
    ).rejects.toThrow(new RegExp(heldAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    await expect(
      withProjectMemoryLock(d, async () => "should not run", { now: laterNow })
    ).rejects.toThrow(lockPath);

    // Lock file must remain untouched by the failed attempt.
    expect(fs.existsSync(lockPath)).toBe(true);
    const recorded = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
    expect(recorded.pid).toBe(999999);
  });

  it("takes over a stale lockfile (older than the TTL) and succeeds", async () => {
    const d = mkdir();
    fs.mkdirSync(d, { recursive: true });
    const lockPath = path.join(d, LOCK_FILENAME);
    const staleAt = "2026-07-15T00:00:00.000Z";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquired_at: staleAt }), "utf-8");

    const muchLaterNow = "2026-07-15T00:20:00.000Z"; // 20 minutes later, past default 10 min TTL
    const result = await withProjectMemoryLock(d, async () => "took over", { now: muchLaterNow });
    expect(result).toBe("took over");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("treats a corrupt lockfile as stale and takes it over", async () => {
    const d = mkdir();
    fs.mkdirSync(d, { recursive: true });
    const lockPath = path.join(d, LOCK_FILENAME);
    fs.writeFileSync(lockPath, "not json{{{", "utf-8");

    const result = await withProjectMemoryLock(d, async () => "took over", { now });
    expect(result).toBe("took over");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("releases the lock even when fn throws", async () => {
    const d = mkdir();
    const lockPath = path.join(d, LOCK_FILENAME);
    await expect(
      withProjectMemoryLock(d, async () => {
        throw new Error("boom");
      }, { now })
    ).rejects.toThrow("boom");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("creates dir owner-only (mode 0o700) if it does not already exist", async () => {
    const parent = mkdir();
    const target = path.join(parent, "nested", "memory");
    await withProjectMemoryLock(target, async () => undefined, { now });
    const stat = fs.statSync(target);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it("respects a custom staleTtlMs", async () => {
    const d = mkdir();
    fs.mkdirSync(d, { recursive: true });
    const lockPath = path.join(d, LOCK_FILENAME);
    const heldAt = "2026-07-15T00:00:00.000Z";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquired_at: heldAt }), "utf-8");

    // With a short TTL of 1000ms, 5 seconds later should be considered stale.
    const shortlyAfter = "2026-07-15T00:00:05.000Z";
    const result = await withProjectMemoryLock(d, async () => "took over", {
      now: shortlyAfter,
      staleTtlMs: 1000,
    });
    expect(result).toBe("took over");
  });

  it("throws the held-lock error (no infinite loop) if a second EEXIST occurs right after a stale takeover", async () => {
    const d = mkdir();
    fs.mkdirSync(d, { recursive: true });
    const lockPath = path.join(d, LOCK_FILENAME);
    const staleAt = "2026-07-15T00:00:00.000Z";
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquired_at: staleAt }), "utf-8");

    // Simulate a racing process that recreates the lockfile in the window
    // between our stale-takeover unlink and our retried create: force the
    // *second* real fs.openSync call (the retry) to also see EEXIST, and
    // confirm the lock module gives up after exactly that one retry rather
    // than looping.
    const realOpenSync = fs.openSync.bind(fs);
    let callCount = 0;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      callCount += 1;
      if (callCount === 2) {
        const err = Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
        throw err;
      }
      return realOpenSync(...args);
    });

    try {
      const muchLaterNow = "2026-07-15T00:20:00.000Z";
      await expect(
        withProjectMemoryLock(d, async () => "should not run", { now: muchLaterNow })
      ).rejects.toThrow(/already|in progress/i);
      expect(callCount).toBe(2);
    } finally {
      openSpy.mockRestore();
    }
  });
});
