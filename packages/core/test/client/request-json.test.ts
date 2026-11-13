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
      "Content-Type": "application/json",
    }),
    getOrganizationId: async () => "org-123",
  };
}

/** Client with zero limiter delay so tests do not wait. */
function client(): ClaudeSyncClient {
  return new ClaudeSyncClient(createMockAuth(), { rateLimitDelayMs: 0 });
}

describe("requestJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns parsed JSON through the paced request path", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, n: 2 }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const data = await client().requestJson("https://claude.ai/v1/code/x");

    expect(data).toEqual({ ok: true, n: 2 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://claude.ai/v1/code/x");
    expect(new Headers(init.headers).get("cookie")).toBe("test-cookie");
  });

  it("layers caller headers over auth headers case-insensitively", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client().requestJson("https://claude.ai/v1/code/x", {
      headers: { "content-type": "application/json", "x-extra": "1" },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new Headers(init.headers);
    expect(sent.get("content-type")).toBe("application/json");
    expect(sent.get("x-extra")).toBe("1");
    expect(sent.get("cookie")).toBe("test-cookie");
  });

  it("passes method and body through", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await client().requestJson("https://claude.ai/v1/code/x", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"a":1}');
  });

  it("maps 429 to RateLimitError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { resets_at: 1 } }), { status: 429 })
      )
    );
    await expect(client().requestJson("https://claude.ai/v1/code/x")).rejects.toBeInstanceOf(
      RateLimitError
    );
  });

  it("maps non-2xx to ClaudeSyncError with the status code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 }))
    );
    const err = await client()
      .requestJson("https://claude.ai/v1/code/x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeSyncError);
    expect((err as ClaudeSyncError).statusCode).toBe(404);
  });

  it("returns null for an empty body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    expect(await client().requestJson("https://claude.ai/v1/code/x")).toBeNull();
  });

  it.each([
    ["a foreign origin", "https://evil.example/x"],
    ["a look-alike subdomain", "https://claude.ai.evil.example/x"],
    ["userinfo that moves the host", "https://claude.ai@evil.example/x"],
    ["plain http", "http://claude.ai/x"],
    ["a relative string", "/v1/code/x"],
  ])("refuses %s before taking a limiter slot or calling fetch", async (_label, url) => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const limiter = {
      acquireRequestSlot: vi.fn(async () => {}),
      onRequestSuccess: vi.fn(),
      onThrottle: vi.fn(),
    };
    const guarded = new ClaudeSyncClient(createMockAuth(), { limiter });

    const err = await guarded.requestJson(url).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ClaudeSyncError);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(limiter.acquireRequestSlot).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
