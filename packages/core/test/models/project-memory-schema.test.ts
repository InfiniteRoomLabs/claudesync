import { describe, it, expect } from "vitest";
import { ProjectMemorySchema } from "@core/models/schemas.js";

describe("ProjectMemorySchema", () => {
  it("parses a generated memory response", () => {
    const r = ProjectMemorySchema.parse({
      memory: "**Purpose**\n\nSynthetic memory.",
      controls: ["Prefer rye flour.", "Open at 6am."],
      updated_at: "2026-07-12T07:38:26.626000+00:00",
    });
    expect(r.controls).toEqual(["Prefer rye flour.", "Open at 6am."]);
  });

  it("parses an ungenerated project (null controls, empty memory)", () => {
    const r = ProjectMemorySchema.parse({ memory: "", controls: null, updated_at: null });
    expect(r.controls).toBeNull();
    expect(r.memory).toBe("");
  });

  it("passes through unknown fields (forward compat)", () => {
    const r = ProjectMemorySchema.parse({
      memory: "x", controls: [], updated_at: null, future_field: 1,
    }) as Record<string, unknown>;
    expect(r.future_field).toBe(1);
  });
});
