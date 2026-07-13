import { describe, it, expect } from "vitest";
import { canonicalize, serializeEdits, parseEdits } from "@core/memory/edits.js";

describe("canonicalize", () => {
  it("strips BOM, normalizes newlines, ends with exactly one newline", () => {
    expect(canonicalize("\uFEFFa\r\nb\r\n\n\n")).toBe("a\nb\n");
    expect(canonicalize("no newline")).toBe("no newline\n");
    expect(canonicalize("")).toBe("");
  });
});

describe("serializeEdits / parseEdits round-trip", () => {
  it("round-trips single-line entries", () => {
    const c = ["Prefer rye flour.", "Open at 6am."];
    expect(parseEdits(serializeEdits(c))).toEqual(c);
  });
  it("round-trips a multi-line entry", () => {
    const c = ["Line one\nline two of the same instruction.", "Second."];
    expect(parseEdits(serializeEdits(c))).toEqual(c);
  });
  it("empty array serializes to empty string and parses back to []", () => {
    expect(serializeEdits([])).toBe("");
    expect(parseEdits("")).toEqual([]);
  });
  it("parse drops blank blocks and trims", () => {
    expect(parseEdits("  a  \n---\n\n---\nb\n")).toEqual(["a", "b"]);
  });
});
