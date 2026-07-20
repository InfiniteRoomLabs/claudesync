import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSyncClient } from "@core/client/client.js";
import { ClaudeSyncError, RateLimitError } from "@core/client/errors.js";
import type { AuthProvider } from "@core/auth/types.js";

/** Mock {@link AuthProvider} returning fixed synthetic headers for every call. */
function createMockAuth(): AuthProvider {
  return {
    getHeaders: async () => ({
      Cookie: "test-cookie",
      "User-Agent": "test-agent",
    }),
    getOrganizationId: async () => "org-123",
  };
}

/** Convenience constructor for a client with zero limiter delay in tests. */
function client(): ClaudeSyncClient {
  return new ClaudeSyncClient(createMockAuth(), { rateLimitDelayMs: 0 });
}

describe("renameConversation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the chat_conversations URL with the expected method, headers, and body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ uuid: "chat-456", name: "New Title", summary: "" }),
          { status: 202 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await client().renameConversation("org-123", "chat-456", "New Title");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://claude.ai/api/organizations/org-123/chat_conversations/chat-456"
    );
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json"
    );
    expect(init.body).toBe(JSON.stringify({ name: "New Title" }));
  });

  it("merges the lowercase content-type from the caller with the auth headers case-insensitively, without duplicating content-type", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ uuid: "chat-456", name: "New Title", summary: "" }),
          { status: 202 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await client().renameConversation("org-123", "chat-456", "New Title");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = new Headers(init.headers);

    // Exactly one content-type value, and it is not a comma-joined
    // duplicate of "application/json" from a case-insensitive collision
    // between the auth provider's "Content-Type" and the caller's
    // lowercase "content-type".
    const contentType = sentHeaders.get("content-type");
    expect(contentType).toBe("application/json");
    expect(contentType).not.toContain(",");

    // The auth-provided Cookie header must survive the merge -- the
    // caller's content-type must not wipe unrelated auth headers.
    expect(sentHeaders.get("cookie")).toBe("test-cookie");
  });

  it("resolves void on a 202 response with the updated conversation summary body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ uuid: "chat-456", name: "New Title" }),
            { status: 202 }
          )
      )
    );

    await expect(
      client().renameConversation("org-123", "chat-456", "New Title")
    ).resolves.toBeUndefined();
  });

  it("throws pre-fetch on an empty name and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().renameConversation("org-123", "chat-456", "")
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws pre-fetch on a whitespace-only name and never calls fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().renameConversation("org-123", "chat-456", "   ")
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a 429 to RateLimitError and does not retry", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { resets_at: 1234567890 } }),
          { status: 429 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().renameConversation("org-123", "chat-456", "New Title")
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 500 to ClaudeSyncError and does not retry", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("boom", { status: 500, statusText: "Internal Server Error" })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().renameConversation("org-123", "chat-456", "New Title")
    ).rejects.toBeInstanceOf(ClaudeSyncError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never embeds the attempted name in a thrown error message", async () => {
    const marker = "MARKER-SECRET-TITLE-vX9q";

    // Pre-fetch validation error (empty name) -- marker isn't the name here,
    // but the validation error must not echo whatever was passed either.
    await expect(
      client().renameConversation("org-123", "chat-456", "")
    ).rejects.not.toThrow(new RegExp(marker));

    // Server-side failure path: the marker IS the attempted name, and the
    // resulting error must not contain it.
    const fetchMock = vi.fn(
      async () =>
        new Response("boom", { status: 500, statusText: "Internal Server Error" })
    );
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await client().renameConversation("org-123", "chat-456", marker);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(marker);
  });
});
