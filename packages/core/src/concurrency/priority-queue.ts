interface Entry<T> {
  item: T;
  priority: number;
  seq: number;
}

/**
 * Stable min-priority queue: lower `priority` numbers come out first, ties
 * broken by insertion order (FIFO). `pop` accepts an optional eligibility
 * predicate so callers can skip items that are temporarily not runnable (e.g.
 * a per-project concurrency cap) without removing them from the queue.
 *
 * O(n) pop by linear scan. The work sets here are hundreds to low thousands of
 * items, so a heap is not worth the complexity (and a heap cannot cheaply honor
 * an arbitrary eligibility predicate anyway).
 */
export class MinPriorityQueue<T> {
  private entries: Entry<T>[] = [];
  private seqCounter = 0;

  push(item: T, priority: number): void {
    this.entries.push({ item, priority, seq: this.seqCounter++ });
  }

  /**
   * Remove and return the highest-priority item satisfying `isEligible`.
   * Returns undefined when the queue is empty or nothing eligible remains.
   */
  pop(isEligible?: (item: T) => boolean): T | undefined {
    let bestIdx = -1;
    let best: Entry<T> | undefined;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (isEligible && !isEligible(e.item)) continue;
      if (
        !best ||
        e.priority < best.priority ||
        (e.priority === best.priority && e.seq < best.seq)
      ) {
        best = e;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) return undefined;
    this.entries.splice(bestIdx, 1);
    return best!.item;
  }

  get size(): number {
    return this.entries.length;
  }
}
