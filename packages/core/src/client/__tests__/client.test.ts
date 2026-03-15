import { describe, expect, it, vi } from "vitest";
import { ClaudeSyncClient } from "../client.js";
import type { AuthProvider } from "../../auth/types.js";

// Mock AuthProvider that returns fixed headers
function createMockAuth(): AuthProvider {
  return {
    getHeaders: async () => ({
      Cookie: "test-cookie",
      "User-Agent": "test-agent",
    }),
    getOrganizationId: async () => "org-123",
  };
}

describe("ClaudeSyncClient", () => {
  it("constructs with an auth provider", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(client).toBeDefined();
  });

  it("constructs with custom rate limit delay", () => {
    const client = new ClaudeSyncClient(createMockAuth(), {
      rateLimitDelayMs: 500,
    });
    expect(client).toBeDefined();
  });

  it("exposes listOrganizations method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listOrganizations).toBe("function");
  });

  it("exposes listConversations as async iterable", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listConversations).toBe("function");
  });

  it("exposes listConversationsAll convenience method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listConversationsAll).toBe("function");
  });

  it("exposes getConversation method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.getConversation).toBe("function");
  });

  it("exposes searchConversations method", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.searchConversations).toBe("function");
  });

  it("exposes artifact methods", () => {
    const client = new ClaudeSyncClient(createMockAuth());
    expect(typeof client.listArtifacts).toBe("function");
    expect(typeof client.downloadArtifact).toBe("function");
  });
});
