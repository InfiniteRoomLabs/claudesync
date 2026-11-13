import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeSyncError, RateLimitError } from "@core/client/errors.js";
import {
  runDuetSync,
  runDuetSyncGuarded,
  type DuetProgressEvent,
  type DuetSource,
} from "@core/duet/sync.js";
import { readSyncState } from "@core/sync/state.js";
import type {
  DuetChannel,
  DuetMessage,
  DuetProject,
  DuetTask,
} from "@core/duet/types.js";

/** Id of the project's own channel in every fixture. */
const CHAN = "chan_TESTchannel0000000000000";
/** Id of a second channel used by the multi-channel tests. */
const CHAN2 = "chan_TESTsecond00000000000000";
/** Directory name of the day directory for `CHAN` ("Home") on a given date. */
const day = (date: string, slug = "home-000000") => `${date}-${slug}`;

/** Per-test output root, recreated for each test. */
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "duet-sync-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Build a synthetic message authored by the account. */
function msg(
  id: string,
  seq: number,
  created_at: string,
  extra: Record<string, unknown> = {}
): DuetMessage {
  return {
    id,
    seq: String(seq),
    channel_id: CHAN,
    thread_root_id: id,
    created_at,
    body: `Review the quarterly notes (${id})`,
    reply_count: 0,
    author_account_id: "user_TESTaccount0000000000000",
    ...extra,
  } as DuetMessage;
}

/** Build a synthetic task. */
function task(id: string, data: Record<string, unknown> = {}): DuetTask {
  return { id, data: { title: `Task ${id}`, done: false, ...data } } as DuetTask;
}

/** Knobs for {@link makeSource}. */
interface SourceSpec {
  project?: DuetProject | null;
  channels?: DuetChannel[];
  timelines?: Record<string, DuetMessage[] | Error>;
  threads?: Record<string, DuetMessage[] | Error>;
  tasks?: DuetTask[] | Error;
}

/** Fake {@link DuetSource} whose methods are spies, so tests can count calls. */
function makeSource(spec: SourceSpec = {}): DuetSource & {
  getTimeline: ReturnType<typeof vi.fn>;
  getThread: ReturnType<typeof vi.fn>;
  listTasks: ReturnType<typeof vi.fn>;
} {
  const project: DuetProject | null =
    spec.project === undefined
      ? {
          channel: { id: CHAN, name: "Home" },
          settings: { agent_name: "Duet", time_zone: "UTC", purpose: "Help" },
          routines_paused: false,
        }
      : spec.project;
  const answer = <T,>(v: T | Error | undefined, fallback: T): Promise<T> =>
    v instanceof Error ? Promise.reject(v) : Promise.resolve(v ?? fallback);
  return {
    findProject: vi.fn(async () => project),
    listChannels: vi.fn(async () => spec.channels ?? [{ id: CHAN, name: "Home" }]),
    getTimeline: vi.fn(async (channelId: string) => ({
      data: await answer(spec.timelines?.[channelId], [] as DuetMessage[]),
    })),
    getThread: vi.fn(async (_channelId: string, rootId: string) => ({
      data: await answer(spec.threads?.[rootId], [] as DuetMessage[]),
    })),
    listTasks: vi.fn(async () => ({ tasks: await answer(spec.tasks, [] as DuetTask[]) })),
  } as never;
}

/** Path of a file inside the Duet tree. */
const duetPath = (...parts: string[]) => path.join(root, "duet", ...parts);

/** Read and parse a JSON file inside the Duet tree. */
const readJson = (...parts: string[]) =>
  JSON.parse(fs.readFileSync(duetPath(...parts), "utf-8")) as Record<string, unknown>;

/** Fixed clock factory so the sidecar timestamp is predictable. */
const clock = (iso: string) => () => new Date(iso);

describe("runDuetSync", () => {
  it("no-Duet account writes nothing", async () => {
    const source = makeSource({ project: null });
    const result = await runDuetSync(source, { outputRoot: root });

    expect(result.available).toBe(false);
    expect(fs.existsSync(duetPath())).toBe(false);
    expect(source.getTimeline).not.toHaveBeenCalled();
  });

  it("a project with no channel is treated as unavailable", async () => {
    const source = makeSource({ project: { settings: { agent_name: "Duet" } } });
    const result = await runDuetSync(source, { outputRoot: root });
    expect(result.available).toBe(false);
    expect(fs.existsSync(duetPath())).toBe(false);
  });

  it("writes the documented tree", async () => {
    const source = makeSource({
      timelines: { [CHAN]: [msg("cmsg_1", 1, "2026-11-02T15:00:00Z")] },
      tasks: [task("t1", { createdAt: "2026-11-01T00:00:00Z" })],
    });
    const result = await runDuetSync(source, { outputRoot: root, now: clock("2026-11-13T00:00:00Z") });

    expect(result).toMatchObject({
      available: true,
      channels: 1,
      daysWritten: 1,
      daysUnchanged: 0,
      messages: 1,
      tasks: 1,
      errors: 0,
    });
    const dir = day("2026-11-02");
    for (const file of [
      "duet.json",
      "tasks.json",
      path.join("knowledge", "TASKS.md"),
      path.join("conversations", dir, "conversation.md"),
      path.join("conversations", dir, "messages.json"),
      path.join("conversations", dir, "README.md"),
      path.join("conversations", dir, ".claudesync-state.json"),
    ]) {
      expect(fs.existsSync(duetPath(file)), file).toBe(true);
    }

    const store = readJson("conversations", dir, "messages.json");
    expect(store).toMatchObject({ channel_id: CHAN, date: "2026-11-02", time_zone: "UTC" });
    expect(readJson("duet.json")).toMatchObject({
      agent_name: "Duet",
      purpose: "Help",
      time_zone: "UTC",
      project_channel_id: CHAN,
      channels: [{ id: CHAN, name: "Home" }],
    });
    const log = fs.readFileSync(duetPath("conversations", dir, "conversation.md"), "utf-8");
    expect(log).toContain("# Duet -- Home -- 2026-11-02");
    expect(log).toContain("## 15:00 You");
    expect(fs.readFileSync(duetPath("knowledge", "TASKS.md"), "utf-8")).toContain("Task t1");

    // The sidecar is a valid, standard sync state.
    const state = readSyncState(duetPath("conversations", dir));
    expect(state?.conversation_uuid).toBe(`${CHAN}:2026-11-02`);
    expect(state?.current_leaf_message_uuid).toBe("cmsg_1");
    expect(state?.last_sync_at).toBe("2026-11-13T00:00:00.000Z");
  });

  it("buckets by the thread root's local day across a zone boundary", async () => {
    const timelines = {
      [CHAN]: [
        // 02:30 UTC on the 3rd is 20:30 on the 2nd in Chicago; 08:00 UTC is 02:00 on the 3rd.
        msg("cmsg_a", 1, "2026-11-03T02:30:00Z"),
        msg("cmsg_b", 2, "2026-11-03T08:00:00Z"),
      ],
    };
    const chicago = makeSource({
      project: { channel: { id: CHAN, name: "Home" }, settings: { time_zone: "America/Chicago" } },
      timelines,
    });
    await runDuetSync(chicago, { outputRoot: root });
    expect(fs.readdirSync(duetPath("conversations")).sort()).toEqual([
      day("2026-11-02"),
      day("2026-11-03"),
    ]);
    const log = fs.readFileSync(duetPath("conversations", day("2026-11-02"), "conversation.md"), "utf-8");
    expect(log).toContain("## 20:30 You");

    // An invalid zone falls back to UTC: both messages land on the 3rd.
    fs.rmSync(duetPath(), { recursive: true });
    const bad = makeSource({
      project: { channel: { id: CHAN, name: "Home" }, settings: { time_zone: "Not/AZone" } },
      timelines,
    });
    await runDuetSync(bad, { outputRoot: root });
    expect(fs.readdirSync(duetPath("conversations"))).toEqual([day("2026-11-03")]);
  });

  it("a late reply lands in its root's day", async () => {
    const source = makeSource({
      timelines: {
        [CHAN]: [
          msg("cmsg_root", 1, "2026-11-02T15:00:00Z", { reply_count: 1 }),
          msg("cmsg_reply", 2, "2026-11-04T09:00:00Z", { thread_root_id: "cmsg_root" }),
        ],
      },
    });
    await runDuetSync(source, { outputRoot: root });

    expect(fs.readdirSync(duetPath("conversations"))).toEqual([day("2026-11-02")]);
    const log = fs.readFileSync(duetPath("conversations", day("2026-11-02"), "conversation.md"), "utf-8");
    expect(log).toContain("### 09:00 You");
    expect(source.getThread).not.toHaveBeenCalled();
  });

  it("upsert keeps messages that left the window and the fetched copy replaces the stored one", async () => {
    await runDuetSync(
      makeSource({
        timelines: {
          [CHAN]: [
            msg("cmsg_old", 1, "2026-11-02T09:00:00Z"),
            msg("cmsg_keep", 2, "2026-11-02T10:00:00Z", { body: "first version" }),
          ],
        },
      }),
      { outputRoot: root }
    );
    // The window moved on: cmsg_old is gone from the API, cmsg_keep was edited.
    await runDuetSync(
      makeSource({
        timelines: {
          [CHAN]: [msg("cmsg_keep", 2, "2026-11-02T10:00:00Z", { body: "second version" })],
        },
      }),
      { outputRoot: root }
    );

    const store = readJson("conversations", day("2026-11-02"), "messages.json") as {
      messages: DuetMessage[];
    };
    expect(store.messages.map((m) => m.id)).toEqual(["cmsg_old", "cmsg_keep"]);
    expect(store.messages[1].body).toBe("second version");
    const log = fs.readFileSync(duetPath("conversations", day("2026-11-02"), "conversation.md"), "utf-8");
    expect(log).toContain("cmsg_old");
  });

  it("sorts stored messages by numeric seq", async () => {
    await runDuetSync(
      makeSource({
        timelines: {
          [CHAN]: [
            msg("cmsg_ten", 10, "2026-11-02T10:00:00Z"),
            msg("cmsg_nine", 9, "2026-11-02T09:00:00Z"),
          ],
        },
      }),
      { outputRoot: root }
    );
    const store = readJson("conversations", day("2026-11-02"), "messages.json") as {
      messages: DuetMessage[];
    };
    expect(store.messages.map((m) => m.id)).toEqual(["cmsg_nine", "cmsg_ten"]);
  });

  it("a second run rewrites nothing", async () => {
    const spec: SourceSpec = {
      timelines: { [CHAN]: [msg("cmsg_1", 1, "2026-11-02T15:00:00Z")] },
      tasks: [task("t1")],
    };
    await runDuetSync(makeSource(spec), { outputRoot: root, now: clock("2026-11-13T00:00:00Z") });

    const dir = duetPath("conversations", day("2026-11-02"));
    const before = {
      mtime: fs.statSync(path.join(dir, "conversation.md")).mtimeMs,
      state: fs.readFileSync(path.join(dir, ".claudesync-state.json"), "utf-8"),
      tasksMd: fs.statSync(duetPath("knowledge", "TASKS.md")).mtimeMs,
      duetJson: fs.statSync(duetPath("duet.json")).mtimeMs,
    };

    const second = await runDuetSync(makeSource(spec), {
      outputRoot: root,
      now: clock("2026-11-14T00:00:00Z"),
    });

    expect(second.daysWritten).toBe(0);
    expect(second.daysUnchanged).toBe(1);
    expect(fs.statSync(path.join(dir, "conversation.md")).mtimeMs).toBe(before.mtime);
    // A rewrite would have stamped the new clock into the sidecar.
    expect(fs.readFileSync(path.join(dir, ".claudesync-state.json"), "utf-8")).toBe(before.state);
    expect(fs.statSync(duetPath("knowledge", "TASKS.md")).mtimeMs).toBe(before.tasksMd);
    expect(fs.statSync(duetPath("duet.json")).mtimeMs).toBe(before.duetJson);
  });

  it("INDEX.md survives a day rewrite", async () => {
    await runDuetSync(
      makeSource({ timelines: { [CHAN]: [msg("cmsg_1", 1, "2026-11-02T15:00:00Z")] } }),
      { outputRoot: root }
    );
    const dir = duetPath("conversations", day("2026-11-02"));
    fs.writeFileSync(path.join(dir, "INDEX.md"), "indexer summary", "utf-8");

    const second = await runDuetSync(
      makeSource({
        timelines: {
          [CHAN]: [
            msg("cmsg_1", 1, "2026-11-02T15:00:00Z"),
            msg("cmsg_2", 2, "2026-11-02T16:00:00Z"),
          ],
        },
      }),
      { outputRoot: root }
    );

    expect(second.daysWritten).toBe(1);
    expect(fs.readFileSync(path.join(dir, "INDEX.md"), "utf-8")).toBe("indexer summary");
    expect(fs.readFileSync(path.join(dir, "conversation.md"), "utf-8")).toContain("cmsg_2");
  });

  it("fetches the thread when reply_count exceeds the replies present", async () => {
    const root1 = msg("cmsg_root", 1, "2026-11-02T09:00:00Z", { reply_count: 2 });
    const source = makeSource({
      timelines: {
        [CHAN]: [root1, msg("cmsg_r1", 2, "2026-11-02T09:05:00Z", { thread_root_id: "cmsg_root" })],
      },
      threads: {
        cmsg_root: [
          root1,
          msg("cmsg_r1", 2, "2026-11-02T09:05:00Z", { thread_root_id: "cmsg_root" }),
          msg("cmsg_r2", 3, "2026-11-02T09:10:00Z", { thread_root_id: "cmsg_root" }),
        ],
      },
    });
    await runDuetSync(source, { outputRoot: root });

    expect(source.getThread).toHaveBeenCalledTimes(1);
    expect(source.getThread.mock.calls[0][1]).toBe("cmsg_root");
    const store = readJson("conversations", day("2026-11-02"), "messages.json") as {
      messages: DuetMessage[];
    };
    expect(store.messages.map((m) => m.id)).toEqual(["cmsg_root", "cmsg_r1", "cmsg_r2"]);
  });

  it("counts replies stored by an earlier sync as present", async () => {
    await runDuetSync(
      makeSource({
        timelines: {
          [CHAN]: [
            msg("cmsg_root", 1, "2026-11-02T09:00:00Z", { reply_count: 1 }),
            msg("cmsg_r1", 2, "2026-11-02T09:05:00Z", { thread_root_id: "cmsg_root" }),
          ],
        },
      }),
      { outputRoot: root }
    );
    // The reply has left the window but the root is still in it.
    const source = makeSource({
      timelines: { [CHAN]: [msg("cmsg_root", 1, "2026-11-02T09:00:00Z", { reply_count: 1 })] },
    });
    await runDuetSync(source, { outputRoot: root });
    expect(source.getThread).not.toHaveBeenCalled();
  });

  it("fetches the thread for an orphaned reply and files it under the root's day", async () => {
    const source = makeSource({
      timelines: {
        [CHAN]: [msg("cmsg_r1", 5, "2026-11-04T09:00:00Z", { thread_root_id: "cmsg_old_root" })],
      },
      threads: {
        cmsg_old_root: [
          msg("cmsg_old_root", 1, "2026-11-01T09:00:00Z", { reply_count: 1 }),
          msg("cmsg_r1", 5, "2026-11-04T09:00:00Z", { thread_root_id: "cmsg_old_root" }),
        ],
      },
    });
    await runDuetSync(source, { outputRoot: root });

    expect(source.getThread).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(duetPath("conversations"))).toEqual([day("2026-11-01")]);
    const log = fs.readFileSync(duetPath("conversations", day("2026-11-01"), "conversation.md"), "utf-8");
    expect(log).toContain("### 09:00 You");
  });

  it("still stores an orphaned reply when its thread cannot be fetched", async () => {
    const events: DuetProgressEvent[] = [];
    const source = makeSource({
      timelines: {
        [CHAN]: [msg("cmsg_r1", 5, "2026-11-04T09:00:00Z", { thread_root_id: "cmsg_old_root" })],
      },
      threads: { cmsg_old_root: new ClaudeSyncError("boom", 500) },
    });
    const result = await runDuetSync(source, { outputRoot: root, onProgress: (e) => events.push(e) });

    expect(result.errors).toBe(1);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(fs.readdirSync(duetPath("conversations"))).toEqual([day("2026-11-04")]);
  });

  it("flips the present flag to false when a task disappears and keeps its history", async () => {
    await runDuetSync(makeSource({ tasks: [task("t1"), task("t2")] }), {
      outputRoot: root,
      now: clock("2026-11-13T00:00:00Z"),
    });
    await runDuetSync(makeSource({ tasks: [task("t1")] }), {
      outputRoot: root,
      now: clock("2026-11-14T00:00:00Z"),
    });

    const store = readJson("tasks.json") as {
      tasks: Record<string, { present: boolean; first_seen_at: string; last_seen_at: string }>;
    };
    expect(store.tasks.t1).toMatchObject({
      present: true,
      first_seen_at: "2026-11-13T00:00:00.000Z",
      last_seen_at: "2026-11-14T00:00:00.000Z",
    });
    expect(store.tasks.t2).toMatchObject({
      present: false,
      last_seen_at: "2026-11-13T00:00:00.000Z",
    });
    expect(fs.readFileSync(duetPath("knowledge", "TASKS.md"), "utf-8")).toContain(
      "Task t2 _(not in the latest sync)_"
    );
  });

  it("one failing channel does not stop the others", async () => {
    const events: DuetProgressEvent[] = [];
    const source = makeSource({
      channels: [
        { id: CHAN, name: "Home" },
        { id: CHAN2, name: "Work" },
      ],
      timelines: {
        [CHAN]: new ClaudeSyncError("boom", 500),
        [CHAN2]: [msg("cmsg_w", 1, "2026-11-02T10:00:00Z", { channel_id: CHAN2 })],
      },
      tasks: [task("t1")],
    });
    const result = await runDuetSync(source, { outputRoot: root, onProgress: (e) => events.push(e) });

    expect(result.errors).toBe(1);
    expect(result.daysWritten).toBe(1);
    expect(fs.readdirSync(duetPath("conversations"))).toEqual([day("2026-11-02", "work-000000")]);
    expect(fs.existsSync(duetPath("knowledge", "TASKS.md"))).toBe(true);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("adds the project channel when the joined list omits it", async () => {
    const source = makeSource({
      channels: [],
      timelines: { [CHAN]: [msg("cmsg_1", 1, "2026-11-02T10:00:00Z")] },
    });
    await runDuetSync(source, { outputRoot: root });
    expect(fs.readdirSync(duetPath("conversations"))).toEqual([day("2026-11-02")]);
  });

  it("a corrupt stored day fails that channel and leaves the file untouched", async () => {
    const dir = duetPath("conversations", day("2026-11-02"));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "messages.json"), "{not json", "utf-8");

    const result = await runDuetSync(
      makeSource({ timelines: { [CHAN]: [msg("cmsg_1", 1, "2026-11-02T10:00:00Z")] } }),
      { outputRoot: root }
    );

    expect(result.errors).toBe(1);
    expect(fs.readFileSync(path.join(dir, "messages.json"), "utf-8")).toBe("{not json");
  });

  it("an abort signal returns the partial tally", async () => {
    const controller = new AbortController();
    const source = makeSource({
      channels: [
        { id: CHAN, name: "Home" },
        { id: CHAN2, name: "Work" },
      ],
      timelines: {
        [CHAN]: [msg("cmsg_h", 1, "2026-11-02T10:00:00Z")],
        [CHAN2]: [msg("cmsg_w", 1, "2026-11-02T10:00:00Z", { channel_id: CHAN2 })],
      },
    });
    const result = await runDuetSync(source, {
      outputRoot: root,
      signal: controller.signal,
      onProgress: (e) => {
        if (e.type === "channel-done") controller.abort();
      },
    });

    expect(result.daysWritten).toBe(1);
    expect(source.getTimeline).toHaveBeenCalledTimes(1);
    expect(source.listTasks).not.toHaveBeenCalled();
    expect(fs.readdirSync(duetPath("conversations"))).toEqual([day("2026-11-02")]);
  });

  it("duet.json holds no member lists", async () => {
    const source = makeSource({
      channels: [
        { id: CHAN, name: "Home", members: [{ id: "user_SECRETmember000000000000" }] } as DuetChannel,
      ],
    });
    await runDuetSync(source, { outputRoot: root });
    const text = fs.readFileSync(duetPath("duet.json"), "utf-8");
    expect(text).not.toContain("members");
    expect(text).not.toContain("SECRETmember");
  });

  it("honors extra preserve globs", async () => {
    const spec: SourceSpec = { timelines: { [CHAN]: [msg("cmsg_1", 1, "2026-11-02T15:00:00Z")] } };
    await runDuetSync(makeSource(spec), { outputRoot: root });
    const dir = duetPath("conversations", day("2026-11-02"));
    fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(dir, "notes", "mine.md"), "keep me", "utf-8");

    spec.timelines = {
      [CHAN]: [msg("cmsg_1", 1, "2026-11-02T15:00:00Z"), msg("cmsg_2", 2, "2026-11-02T16:00:00Z")],
    };
    await runDuetSync(makeSource(spec), { outputRoot: root, preserve: ["notes/**"] });
    expect(fs.readFileSync(path.join(dir, "notes", "mine.md"), "utf-8")).toBe("keep me");
  });
});

describe("runDuetSyncGuarded", () => {
  it("reports a failure instead of throwing", async () => {
    const source = makeSource();
    source.findProject = vi.fn(async () => {
      throw new ClaudeSyncError("API request failed: 500 Server Error", 500);
    });
    const outcome = await runDuetSyncGuarded(source, { outputRoot: root });
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.message).toContain("500");
  });

  it("reports a rate limit as a failure too", async () => {
    const source = makeSource();
    source.findProject = vi.fn(async () => {
      throw new RateLimitError(Math.floor(Date.now() / 1000) + 60);
    });
    const outcome = await runDuetSyncGuarded(source, { outputRoot: root });
    expect(outcome.status).toBe("failed");
  });

  it("reports a non-Error throw as a failure", async () => {
    const source = makeSource();
    source.findProject = vi.fn(async () => {
      throw "plain string";
    });
    const outcome = await runDuetSyncGuarded(source, { outputRoot: root });
    expect(outcome).toEqual({ status: "failed", message: "plain string" });
  });

  it("reports an account with no Duet as unavailable", async () => {
    const outcome = await runDuetSyncGuarded(makeSource({ project: null }), { outputRoot: root });
    expect(outcome.status).toBe("unavailable");
    expect(fs.existsSync(duetPath())).toBe(false);
  });

  it("reports a clean run as synced with the tally", async () => {
    const outcome = await runDuetSyncGuarded(
      makeSource({ timelines: { [CHAN]: [msg("cmsg_1", 1, "2026-11-02T15:00:00Z")] } }),
      { outputRoot: root }
    );
    expect(outcome.status).toBe("synced");
    expect(outcome.status === "synced" && outcome.result.daysWritten).toBe(1);
  });
});
