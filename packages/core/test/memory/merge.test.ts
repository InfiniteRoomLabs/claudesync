import { describe, it, expect } from "vitest";
import { hashContent } from "@core/memory/hash.js";
import {
  mergeProjectMemoryControls,
  assertNoDelimiterEntries,
} from "@core/memory/merge.js";

describe("mergeProjectMemoryControls", () => {
  it("keeps an entry unchanged on both sides", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([hashContent(e)], [e], [e]);
    expect(result.controls).toEqual([e]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
    expect(result.deduplicated).toBe(0);
  });

  it("keeps a local add with nothing in base or remote", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([], [e], []);
    expect(result.controls).toEqual([e]);
    expect(result.localAdds).toBe(1);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
    expect(result.deduplicated).toBe(0);
  });

  it("drops an entry the local side deleted (delete wins over remote keep)", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([hashContent(e)], [], [e]);
    expect(result.controls).toEqual([]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(1);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
    expect(result.deduplicated).toBe(0);
  });

  it("keeps a remote add with nothing in base or local", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([], [], [e]);
    expect(result.controls).toEqual([e]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(1);
    expect(result.remoteDeletes).toBe(0);
    expect(result.deduplicated).toBe(0);
  });

  it("drops an entry the remote side deleted (delete wins over stale local keep)", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([hashContent(e)], [e], []);
    expect(result.controls).toEqual([]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(1);
    expect(result.deduplicated).toBe(0);
  });

  it("collapses both-add-same-text to a single entry", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([], [e], [e]);
    expect(result.controls).toEqual([e]);
    expect(result.remoteAdds).toBe(1);
    expect(result.localAdds).toBe(0);
    expect(result.deduplicated).toBe(1);
  });

  it("drops an entry deleted on both sides", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([hashContent(e)], [], []);
    expect(result.controls).toEqual([]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
    expect(result.deduplicated).toBe(0);
  });

  it("treats a local modification as delete-old plus add-new", () => {
    const oldEntry = "entry-old";
    const newEntry = "entry-new";
    const result = mergeProjectMemoryControls(
      [hashContent(oldEntry)],
      [newEntry],
      [oldEntry],
    );
    expect(result.controls).toEqual([newEntry]);
    expect(result.localAdds).toBe(1);
    expect(result.localDeletes).toBe(1);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
  });

  it("retains remote order for entries kept from base, even if local reordered them", () => {
    const a = "entry-a";
    const b = "entry-b";
    const result = mergeProjectMemoryControls(
      [hashContent(a), hashContent(b)],
      [a, b],
      [b, a],
    );
    expect(result.controls).toEqual([b, a]);
  });

  it("appends local adds in local order, after remote survivors", () => {
    const a = "entry-a";
    const x = "entry-x";
    const y = "entry-y";
    const result = mergeProjectMemoryControls(
      [hashContent(a)],
      [a, y, x],
      [a],
    );
    expect(result.controls).toEqual([a, y, x]);
    expect(result.localAdds).toBe(2);
  });

  it("collapses duplicate entries within a single input and counts them as deduplicated", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([], [e, e], []);
    expect(result.controls).toEqual([e]);
    expect(result.localAdds).toBe(1);
    expect(result.deduplicated).toBe(1);
  });

  it("collapses duplicate remote entries and counts them as deduplicated", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([], [], [e, e]);
    expect(result.controls).toEqual([e]);
    expect(result.remoteAdds).toBe(1);
    expect(result.deduplicated).toBe(1);
  });

  it("normalizes whitespace/newline differences to the same entry", () => {
    const canonical = "entry-a";
    const localRaw = "  entry-a  \n\n";
    const remoteRaw = "entry-a\r\n";
    const result = mergeProjectMemoryControls(
      [hashContent(canonical)],
      [localRaw],
      [remoteRaw],
    );
    expect(result.controls).toEqual([canonical]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
  });

  it("returns an empty merge for all-empty inputs", () => {
    const result = mergeProjectMemoryControls([], [], []);
    expect(result.controls).toEqual([]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
    expect(result.deduplicated).toBe(0);
  });

  it("keeps a remote add that survives an unrelated local clear", () => {
    const stale = "entry-stale";
    const fresh = "entry-fresh";
    const result = mergeProjectMemoryControls(
      [hashContent(stale)],
      [],
      [fresh],
    );
    expect(result.controls).toEqual([fresh]);
    expect(result.remoteAdds).toBe(1);
    expect(result.localDeletes).toBe(0);
  });

  it("is deterministic across repeated calls with identical inputs", () => {
    const a = "entry-a";
    const b = "entry-b";
    const c = "entry-c";
    const baseHashes = [hashContent(a)];
    const local = [a, c];
    const remote = [b, a];
    const first = mergeProjectMemoryControls(baseHashes, local, remote);
    const second = mergeProjectMemoryControls(baseHashes, local, remote);
    expect(second).toEqual(first);
  });

  it("counts localDeletes once per distinct base entry, not per duplicate occurrence in remote", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([hashContent(e)], [], [e, e]);
    expect(result.controls).toEqual([]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(1);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(0);
    expect(result.deduplicated).toBe(0);
  });

  it("counts remoteDeletes once per distinct base entry, not per duplicate occurrence in local", () => {
    const e = "entry-a";
    const result = mergeProjectMemoryControls([hashContent(e)], [e, e], []);
    expect(result.controls).toEqual([]);
    expect(result.localAdds).toBe(0);
    expect(result.localDeletes).toBe(0);
    expect(result.remoteAdds).toBe(0);
    expect(result.remoteDeletes).toBe(1);
    expect(result.deduplicated).toBe(0);
  });
});

describe("assertNoDelimiterEntries", () => {
  it("does not throw when no entry contains a bare delimiter line", () => {
    expect(() =>
      assertNoDelimiterEntries(["entry-a", "entry-b\nsecond line"]),
    ).not.toThrow();
  });

  it("throws when an entry contains a line exactly equal to the delimiter", () => {
    expect(() =>
      assertNoDelimiterEntries(["entry-a", "entry-b\n---\nentry-c"]),
    ).toThrow();
  });

  it("does not echo the offending entry text in the thrown error message", () => {
    const secretLookingEntry = "entry-with-secret-marker\n---\nmore-text";
    try {
      assertNoDelimiterEntries([secretLookingEntry]);
      throw new Error("expected assertNoDelimiterEntries to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("entry-with-secret-marker");
      expect(message).not.toContain("more-text");
    }
  });
});
