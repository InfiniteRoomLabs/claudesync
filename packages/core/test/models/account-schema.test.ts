import { describe, expect, it } from "vitest";
import { AccountSchema } from "@core/models/schemas.js";

describe("AccountSchema", () => {
  it("parses a valid account with uuid and email", () => {
    const data = {
      uuid: "acct-uuid-123",
      email_address: "user@example.com",
    };
    const result = AccountSchema.parse(data);
    expect(result.uuid).toBe("acct-uuid-123");
    expect(result.email_address).toBe("user@example.com");
  });

  it("preserves unknown fields via passthrough", () => {
    const data = {
      uuid: "acct-uuid-456",
      email_address: "test@example.com",
      extra_field: "extra_value",
      another_unknown: 123,
    };
    const result = AccountSchema.parse(data);
    expect((result as Record<string, unknown>).extra_field).toBe("extra_value");
    expect((result as Record<string, unknown>).another_unknown).toBe(123);
  });

  it("rejects missing uuid", () => {
    const data = {
      email_address: "test@example.com",
    };
    expect(() => AccountSchema.parse(data)).toThrow();
  });
});
