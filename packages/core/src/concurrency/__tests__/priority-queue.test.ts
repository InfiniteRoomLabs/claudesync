import { describe, it, expect } from "vitest";
import { MinPriorityQueue } from "../priority-queue.js";

describe("MinPriorityQueue", () => {
  it("pops lower priority numbers first", () => {
    const q = new MinPriorityQueue<string>();
    q.push("b", 2);
    q.push("a", 0);
    q.push("c", 1);
    expect(q.pop()).toBe("a");
    expect(q.pop()).toBe("c");
    expect(q.pop()).toBe("b");
    expect(q.pop()).toBeUndefined();
  });

  it("is stable (FIFO) within the same priority", () => {
    const q = new MinPriorityQueue<string>();
    q.push("first", 1);
    q.push("second", 1);
    q.push("third", 1);
    expect(q.pop()).toBe("first");
    expect(q.pop()).toBe("second");
    expect(q.pop()).toBe("third");
  });

  it("tracks size", () => {
    const q = new MinPriorityQueue<number>();
    expect(q.size).toBe(0);
    q.push(1, 0);
    q.push(2, 0);
    expect(q.size).toBe(2);
    q.pop();
    expect(q.size).toBe(1);
  });

  it("skips ineligible items and leaves them in the queue", () => {
    const q = new MinPriorityQueue<{ id: string; ready: boolean }>();
    const a = { id: "a", ready: false };
    const b = { id: "b", ready: true };
    q.push(a, 0);
    q.push(b, 1);
    expect(q.pop((x) => x.ready)).toBe(b);
    expect(q.size).toBe(1);
    a.ready = true;
    expect(q.pop((x) => x.ready)).toBe(a);
  });

  it("returns undefined when nothing is eligible", () => {
    const q = new MinPriorityQueue<number>();
    q.push(1, 0);
    expect(q.pop(() => false)).toBeUndefined();
    expect(q.size).toBe(1);
  });
});
