import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSyncClient } from "@core/client/client.js";
import { ClaudeSyncError } from "@core/client/errors.js";
import { DuetClient } from "@core/duet/client.js";
import type { AuthProvider } from "@core/auth/types.js";

/** Channel id used across fixtures. */
const CHAN = "chan_TESTchannel0000000000000";

/** Mock {@link AuthProvider} with a fixed synthetic cookie. */
function createMockAuth(): AuthProvider {
  return {
    getHeaders: async () => ({
      Cookie: "test-cookie",
      "User-Agent": "test-agent",
      "Content-Type": "text/plain",
    }),
    getOrganizationId: async () => "org-123",
  };
}

/** Build a {@link DuetClient} over a real client with zero pacing delay. */
function duet(options?: ConstructorParameters<typeof DuetClient>[2]): DuetClient {
  return new DuetClient(
    new ClaudeSyncClient(createMockAuth(), { rateLimitDelayMs: 0 }),
    "org-123",
    options
  );
}

/** Stub `fetch` to answer every call with the given JSON body and status. */
function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () => new Response(JSON.stringify(body), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Pull the URL and init of the n-th stubbed fetch call. */
function call(fetchMock: ReturnType<typeof vi.fn>, n = 0): [string, RequestInit] {
  return fetchMock.mock.calls[n] as unknown as [string, RequestInit];
}

/** Minimal valid task response used by the write tests. */
const taskWrite = {
  task: { id: "t1", data: { title: "Review the quarterly notes" } },
  respaced_tasks: [],
};

describe("DuetClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("injects duet headers and keeps the session cookie", async () => {
    const fetchMock = stubFetch({ data: [] });
    await duet().listChannels();

    const headers = new Headers(call(fetchMock)[1].headers);
    expect(headers.get("x-organization-uuid")).toBe("org-123");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-beta")).toBe("ccr-byoc-2025-07-29");
    expect(headers.get("anthropic-client-app")).toBe("com.anthropic.aibo.web");
    expect(headers.get("anthropic-client-feature")).toBe("ccr");
    // The duet content-type wins over the auth provider's, with no comma-join.
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("cookie")).toBe("test-cookie");
    expect(headers.get("authorization")).toBeNull();
  });

  it("options.headers replaces and extends the defaults", async () => {
    const fetchMock = stubFetch({ data: [] });
    await duet({
      headers: { "anthropic-beta": "newer-beta", "x-added": "1", "anthropic-client-feature": null },
    }).listChannels();

    const headers = new Headers(call(fetchMock)[1].headers);
    expect(headers.get("anthropic-beta")).toBe("newer-beta");
    expect(headers.get("x-added")).toBe("1");
    expect(headers.get("anthropic-client-feature")).toBeNull();
    expect(headers.get("x-organization-uuid")).toBe("org-123");
  });

  it("findProject posts find_only and parses the project", async () => {
    const fetchMock = stubFetch({
      channel: { id: CHAN, name: "Home" },
      settings: { agent_name: "Duet", time_zone: "America/Chicago" },
      created: false,
    });
    const project = await duet().findProject();

    const [url, init] = call(fetchMock);
    expect(url).toBe("https://claude.ai/v1/code/aibo/project");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ find_only: true }));
    expect(project?.channel?.id).toBe(CHAN);
    expect(project?.settings?.time_zone).toBe("America/Chicago");
  });

  it.each([404, 403])("findProject returns null on %i", async (status) => {
    stubFetch({ error: "no" }, status);
    expect(await duet().findProject()).toBeNull();
  });

  it("findProject rethrows other errors", async () => {
    stubFetch({ error: "boom" }, 500);
    const err = await duet()
      .findProject()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeSyncError);
    expect((err as ClaudeSyncError).statusCode).toBe(500);
  });

  it("listChannels requests joined channels and returns the data array", async () => {
    const fetchMock = stubFetch({ data: [{ id: CHAN, name: "Home" }] });
    const channels = await duet().listChannels();

    expect(call(fetchMock)[0]).toBe(
      "https://claude.ai/v1/code/channels?scope=joined&include_members=true&limit=100"
    );
    expect(call(fetchMock)[1].method ?? "GET").toBe("GET");
    expect(channels).toEqual([{ id: CHAN, name: "Home" }]);
  });

  it("getTimeline requests the timeline with the given limit", async () => {
    const fetchMock = stubFetch({ data: [], linked_sessions: [] });
    await duet().getTimeline(CHAN, { limit: 50 });
    expect(call(fetchMock)[0]).toBe(
      `https://claude.ai/v1/code/channels/${CHAN}/timeline?limit=50&include_replies=true`
    );
  });

  it("getThread requests one thread", async () => {
    const fetchMock = stubFetch({ data: [] });
    await duet().getThread(CHAN, "cmsg_TESTmessage000000000000001");
    expect(call(fetchMock)[0]).toBe(
      `https://claude.ai/v1/code/channels/${CHAN}/threads/cmsg_TESTmessage000000000000001?limit=200`
    );
  });

  it("sendMessage posts body and a generated client_message_id", async () => {
    const fetchMock = stubFetch({ message_id: "cmsg_new", deduplicated: false });
    const res = await duet().sendMessage(CHAN, { body: "Review the quarterly notes" });

    const [url, init] = call(fetchMock);
    expect(url).toBe(`https://claude.ai/v1/code/channels/${CHAN}/messages`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.body).toBe("Review the quarterly notes");
    expect(sent.client_message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect("reply_to_message_id" in sent).toBe(false);
    expect(res.message_id).toBe("cmsg_new");
  });

  it("sendMessage honors an explicit client id and reply_to", async () => {
    const fetchMock = stubFetch({ message_id: "cmsg_new" });
    await duet().sendMessage(CHAN, {
      body: "Thanks",
      clientMessageId: "11111111-2222-3333-4444-555555555555",
      replyToMessageId: "cmsg_root",
    });
    const sent = JSON.parse(call(fetchMock)[1].body as string) as Record<string, unknown>;
    expect(sent).toEqual({
      body: "Thanks",
      client_message_id: "11111111-2222-3333-4444-555555555555",
      reply_to_message_id: "cmsg_root",
    });
  });

  it("sendMessage rejects blank text before any request", async () => {
    const fetchMock = stubFetch({ message_id: "x" });
    await expect(duet().sendMessage(CHAN, { body: "   " })).rejects.toThrow(/non-empty/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("listTasks requests the task list with adopted tasks included", async () => {
    const fetchMock = stubFetch({ tasks: [], artifact_id: "a" });
    const res = await duet().listTasks(CHAN);
    expect(call(fetchMock)[0]).toBe(
      `https://claude.ai/v1/code/aibo/channels/${CHAN}/tasks?limit=200&include_adopted=true`
    );
    expect(res.tasks).toEqual([]);
  });

  it("createTask generates a 33 character id and posts task_id and title", async () => {
    const fetchMock = stubFetch(taskWrite);
    await duet().createTask(CHAN, "Review the quarterly notes");

    const [url, init] = call(fetchMock);
    expect(url).toBe(`https://claude.ai/v1/code/aibo/channels/${CHAN}/tasks`);
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string) as { task_id: string; title: string };
    expect(sent.title).toBe("Review the quarterly notes");
    expect(sent.task_id).toHaveLength(33);
    expect(sent.task_id).toMatch(/^t[0-9a-f]{32}$/);
  });

  it("createTask honors an explicit task id", async () => {
    const fetchMock = stubFetch(taskWrite);
    await duet().createTask(CHAN, "Title", { taskId: "tfixed" });
    const sent = JSON.parse(call(fetchMock)[1].body as string) as { task_id: string };
    expect(sent.task_id).toBe("tfixed");
  });

  it("updateTask sends only title or only done", async () => {
    const fetchMock = stubFetch(taskWrite);
    await duet().updateTask(CHAN, "t1", { title: "Renamed" });
    await duet().updateTask(CHAN, "t1", { done: true });

    expect(call(fetchMock, 0)[0]).toBe(
      `https://claude.ai/v1/code/aibo/channels/${CHAN}/tasks/t1`
    );
    expect(call(fetchMock, 0)[1].method).toBe("POST");
    expect(call(fetchMock, 0)[1].body).toBe(JSON.stringify({ title: "Renamed" }));
    expect(call(fetchMock, 1)[1].body).toBe(JSON.stringify({ done: true }));
  });

  describe("resolveChannelId", () => {
    it("defaults to the project's own channel", async () => {
      stubFetch({ channel: { id: CHAN } });
      expect(await duet().resolveChannelId()).toBe(CHAN);
    });

    it("throws when there is no Duet project", async () => {
      stubFetch({}, 404);
      await expect(duet().resolveChannelId()).rejects.toThrow(/no Duet/i);
    });

    it("passes a chan_ id straight through without a request", async () => {
      const fetchMock = stubFetch({ data: [] });
      expect(await duet().resolveChannelId("chan_other")).toBe("chan_other");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("resolves a channel name case-insensitively", async () => {
      stubFetch({ data: [{ id: CHAN, name: "Home" }, { id: "chan_b", name: "Work" }] });
      expect(await duet().resolveChannelId("work")).toBe("chan_b");
    });

    it("rejects an unknown name and lists the known ones", async () => {
      stubFetch({ data: [{ id: CHAN, name: "Home" }] });
      await expect(duet().resolveChannelId("nope")).rejects.toThrow(/Home/);
    });

    it("rejects an ambiguous name", async () => {
      stubFetch({ data: [{ id: "chan_a", name: "Home" }, { id: "chan_b", name: "home" }] });
      await expect(duet().resolveChannelId("home")).rejects.toThrow(/ambiguous/i);
    });
  });
});
