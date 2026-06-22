import { describe, it, expect } from "vitest";
import { disambiguateSlugs } from "@core/util/naming.js";

describe("disambiguateSlugs", () => {
  it("leaves unique slugs bare", () => {
    const m = disambiguateSlugs([
      { name: "Alpha", uuid: "11111111-aaaa-bbbb-cccc-000000000001" },
      { name: "Beta", uuid: "22222222-aaaa-bbbb-cccc-000000000002" },
    ]);
    expect(m.get("11111111-aaaa-bbbb-cccc-000000000001")).toBe("alpha");
    expect(m.get("22222222-aaaa-bbbb-cccc-000000000002")).toBe("beta");
  });

  it("suffixes EVERY member of a colliding group with its uuid head", () => {
    const m = disambiguateSlugs([
      { name: "Casual greeting", uuid: "099ff180-09ad-4ccb-8dd3-2e343de804e7" },
      { name: "Casual greeting", uuid: "b63a8aa4-1b21-4a28-9b25-bdf7a6d6402a" },
    ]);
    expect(m.get("099ff180-09ad-4ccb-8dd3-2e343de804e7")).toBe("casual-greeting-099ff180");
    expect(m.get("b63a8aa4-1b21-4a28-9b25-bdf7a6d6402a")).toBe("casual-greeting-b63a8aa4");
    // The whole point: distinct uuids never share a slug.
    expect(new Set(m.values()).size).toBe(2);
  });

  it("is order-independent (no 'primary keeps bare' ambiguity)", () => {
    const a = [
      { name: "Dup", uuid: "aaaaaaaa-0000-0000-0000-000000000001" },
      { name: "Dup", uuid: "bbbbbbbb-0000-0000-0000-000000000002" },
    ];
    const forward = disambiguateSlugs(a);
    const reversed = disambiguateSlugs([...a].reverse());
    expect(forward).toEqual(reversed);
  });

  it("keeps empty-named entities unique via the unnamed- fallback", () => {
    const m = disambiguateSlugs([
      { name: "", uuid: "aaaaaaaa-0000-0000-0000-000000000001" },
      { name: null, uuid: "bbbbbbbb-0000-0000-0000-000000000002" },
    ]);
    expect(m.get("aaaaaaaa-0000-0000-0000-000000000001")).toBe(
      "unnamed-aaaaaaaa-0000-0000-0000-000000000001"
    );
    expect(new Set(m.values()).size).toBe(2);
  });
});
