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

describe("putProjectMemoryControls", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the encoded memory/controls URL with the expected body and headers", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(null), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await client().putProjectMemoryControls("org-123", "proj 456", [
      "entry-a",
      "entry-b",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://claude.ai/api/organizations/org-123/memory/controls?project_uuid=proj%20456"
    );
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(init.body).toBe(JSON.stringify({ controls: ["entry-a", "entry-b"] }));
  });

  it("resolves void on a 200 response with a null body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(null), { status: 200 }))
    );

    await expect(
      client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"])
    ).resolves.toBeUndefined();
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
      client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"])
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a 500 to ClaudeSyncError and does not retry", async () => {
    const fetchMock = vi.fn(
      async () => new Response("boom", { status: 500, statusText: "Internal Server Error" })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"])
    ).rejects.toBeInstanceOf(ClaudeSyncError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws an ambiguous-write error on abort/timeout without retrying", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"])
    ).rejects.toThrow(/may have.*applied|re-run push/is);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("defaults the abort timeout to 90000 ms", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(null), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"]);

    expect(timeoutSpy).toHaveBeenCalledWith(90_000);
  });

  it("honors a custom timeoutMs", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(null), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"], {
      timeoutMs: 5_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });

  it("rejects non-finite timeoutMs before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"], {
        timeoutMs: Infinity,
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-positive timeoutMs before fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client().putProjectMemoryControls("org-123", "proj-456", ["entry-a"], {
        timeoutMs: 0,
      })
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still allows a GET via request() to succeed after the requestResponse refactor", async () => {
    const org = {
      uuid: "org-1",
      name: "Test Org",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([org]), { status: 200 }))
    );

    const orgs = await client().listOrganizations();
    expect(orgs).toHaveLength(1);
  });
});
