import { describe, expect, it } from "vitest";
import { matchGlob, matchAnyGlob } from "../glob.js";

describe("matchGlob", () => {
  it("matches literal filenames", () => {
    expect(matchGlob("INDEX.md", "INDEX.md")).toBe(true);
    expect(matchGlob("README.md", "INDEX.md")).toBe(false);
  });

  it("matches single * within a segment", () => {
    expect(matchGlob("foo.md", "*.md")).toBe(true);
    expect(matchGlob("foo.txt", "*.md")).toBe(false);
    expect(matchGlob("notes/foo.md", "*.md")).toBe(false); // * does not cross /
  });

  it("matches ** across path segments", () => {
    expect(matchGlob("notes/foo.md", "notes/**")).toBe(true);
    expect(matchGlob("notes/nested/deep.md", "notes/**")).toBe(true);
    expect(matchGlob("notes/", "notes/**")).toBe(true);
    expect(matchGlob("other/foo.md", "notes/**")).toBe(false);
  });

  it("**/ collapses zero or more path segments", () => {
    expect(matchGlob("INDEX.md", "**/INDEX.md")).toBe(true);
    expect(matchGlob("a/INDEX.md", "**/INDEX.md")).toBe(true);
    expect(matchGlob("a/b/c/INDEX.md", "**/INDEX.md")).toBe(true);
    expect(matchGlob("INDEX.txt", "**/INDEX.md")).toBe(false);
  });

  it("? matches exactly one non-slash char", () => {
    expect(matchGlob("foo.md", "fo?.md")).toBe(true);
    expect(matchGlob("foo.md", "f??.md")).toBe(true);
    expect(matchGlob("fo.md", "fo?.md")).toBe(false);
    expect(matchGlob("fo/o.md", "fo?o.md")).toBe(false);
  });

  it("character classes work", () => {
    expect(matchGlob("a.md", "[ab].md")).toBe(true);
    expect(matchGlob("b.md", "[ab].md")).toBe(true);
    expect(matchGlob("c.md", "[ab].md")).toBe(false);
  });

  it("normalizes leading ./ and backslashes", () => {
    expect(matchGlob("./INDEX.md", "INDEX.md")).toBe(true);
    expect(matchGlob("notes\\foo.md", "notes/foo.md")).toBe(true);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(matchGlob("a.b+c.md", "a.b+c.md")).toBe(true);
    expect(matchGlob("axb+c.md", "a.b+c.md")).toBe(false); // . is literal, not regex any-char
  });
});

describe("matchAnyGlob", () => {
  it("returns true when any pattern matches", () => {
    expect(matchAnyGlob("INDEX.md", ["README.md", "INDEX.md"])).toBe(true);
    expect(matchAnyGlob("notes/x.md", ["INDEX.md", "notes/**"])).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    expect(matchAnyGlob("foo.txt", ["INDEX.md", "*.md"])).toBe(false);
  });

  it("returns false on empty pattern list", () => {
    expect(matchAnyGlob("INDEX.md", [])).toBe(false);
  });
});
