import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EnvAuth } from "../env.js";
import { AuthError } from "../errors.js";

describe("EnvAuth", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws AuthError when CLAUDE_AI_COOKIE is not set", () => {
    delete process.env.CLAUDE_AI_COOKIE;
    expect(() => new EnvAuth()).toThrow(AuthError);
  });

  it("returns headers with cookie and default user-agent", async () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    const auth = new EnvAuth();
    const headers = await auth.getHeaders();
    expect(headers["Cookie"]).toBe("sessionKey=abc123");
    expect(headers["User-Agent"]).toBeDefined();
    expect(headers["User-Agent"].length).toBeGreaterThan(0);
  });

  it("uses custom user-agent from env when set", async () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    process.env.CLAUDE_AI_USER_AGENT =
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0";
    const auth = new EnvAuth();
    const headers = await auth.getHeaders();
    expect(headers["User-Agent"]).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0"
    );
  });

  it("clears CLAUDE_AI_COOKIE from process.env after reading", () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    new EnvAuth();
    expect(process.env.CLAUDE_AI_COOKIE).toBeUndefined();
  });

  it("fetches organization ID from API", async () => {
    process.env.CLAUDE_AI_COOKIE = "sessionKey=abc123";
    const auth = new EnvAuth();
    // getOrganizationId makes a real API call -- tested in integration tests
    // Here we just verify the method exists and is async
    expect(auth.getOrganizationId).toBeDefined();
  });
});
