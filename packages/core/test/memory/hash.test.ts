import { describe, it, expect } from "vitest";
import { hashContent } from "@core/memory/hash.js";

describe("hashContent", () => {
  it("returns the known SHA-256 of the empty string", () => {
    expect(hashContent("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
  it("is deterministic and 64-char hex", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});
