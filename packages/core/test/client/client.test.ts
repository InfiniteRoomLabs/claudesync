import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSyncClient } from "@core/client/client.js";
import type { AuthProvider } from "@core/auth/types.js";

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

describe("downloadArtifact text/binary detection", () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockFetch(contentType: string, body: BodyInit): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(body, { headers: { "content-type": contentType } })
      )
    );
  }
  const client = () =>
    new ClaudeSyncClient(createMockAuth(), { rateLimitDelayMs: 0 });
  const artifact = (name: string) => `/mnt/user-data/outputs/${name}`;

  it("treats octet-stream .md (wiggle's content type for text) as text", async () => {
    // Regression: the wiggle download endpoint serves markdown as
    // application/octet-stream; a content-type prefix check alone returned bytes.
    mockFetch("application/octet-stream", "# Design\n\nbody");
    const r = await client().downloadArtifact("org", "conv", artifact("skill-sync-design.md"));
    expect(typeof r).toBe("string");
    expect(r).toContain("# Design");
  });

  it("treats text/* as text", async () => {
    mockFetch("text/markdown", "hello");
    expect(await client().downloadArtifact("org", "conv", artifact("x.md"))).toBe("hello");
  });

  it("treats application/json as text", async () => {
    mockFetch("application/json", '{"a":1}');
    expect(typeof (await client().downloadArtifact("org", "conv", artifact("d.json")))).toBe("string");
  });

  it("keeps real binary (image/png) as bytes", async () => {
    mockFetch("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
    expect(await client().downloadArtifact("org", "conv", artifact("pic.png"))).toBeInstanceOf(Uint8Array);
  });

  it("keeps non-UTF-8 octet-stream with unknown extension as bytes", async () => {
    mockFetch("application/octet-stream", new Uint8Array([0xff, 0xfe, 0xfd, 0x00]));
    expect(await client().downloadArtifact("org", "conv", artifact("blob.bin"))).toBeInstanceOf(Uint8Array);
  });
});
