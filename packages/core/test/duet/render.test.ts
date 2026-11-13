import { describe, expect, it } from "vitest";
import {
  authorLabel,
  channelSlug,
  compareSeq,
  dayDirName,
  isSuggestion,
  localDate,
  localTime,
  normalizeTimeZone,
  renderDayLog,
  renderDayReadme,
  renderTasks,
} from "@core/duet/render.js";
import type { DuetMessage, DuetStoredTask } from "@core/duet/types.js";

/** Build a synthetic message with sensible defaults. */
function msg(over: Partial<DuetMessage> & { id: string }): DuetMessage {
  return {
    seq: "1",
    created_at: "2026-11-02T15:00:00Z",
    body: "Review the quarterly notes",
    thread_root_id: over.id,
    ...over,
  } as DuetMessage;
}

/** Build a synthetic stored task. */
function stored(
  id: string,
  data: Record<string, unknown>,
  present = true
): DuetStoredTask {
  return {
    task: { id, data: { title: "T", ...data } },
    first_seen_at: "2026-11-02T10:00:00Z",
    last_seen_at: "2026-11-02T10:00:00Z",
    present,
  } as DuetStoredTask;
}

describe("time zones and days", () => {
  it("localDate buckets across a UTC-to-zone boundary", () => {
    // 02:30 UTC on the 3rd is still the 2nd in Chicago (CST, UTC-6 in November).
    expect(localDate("2026-11-03T02:30:00Z", "America/Chicago")).toBe("2026-11-02");
    expect(localDate("2026-11-03T02:30:00Z", "UTC")).toBe("2026-11-03");
    // 20:00 UTC on the 2nd is already the 3rd in Tokyo.
    expect(localDate("2026-11-02T20:00:00Z", "Asia/Tokyo")).toBe("2026-11-03");
  });

  it("invalid or missing zone falls back to UTC", () => {
    expect(normalizeTimeZone(undefined)).toBe("UTC");
    expect(normalizeTimeZone(null)).toBe("UTC");
    expect(normalizeTimeZone("")).toBe("UTC");
    expect(normalizeTimeZone("Not/AZone")).toBe("UTC");
    expect(normalizeTimeZone("America/Chicago")).toBe("America/Chicago");
    expect(localDate("2026-11-03T02:30:00Z", "Not/AZone")).toBe("2026-11-03");
    expect(localDate("2026-11-03T02:30:00Z", undefined)).toBe("2026-11-03");
  });

  it("localTime formats HH:MM in the zone, with midnight as 00", () => {
    expect(localTime("2026-11-03T02:30:00Z", "America/Chicago")).toBe("20:30");
    expect(localTime("2026-11-03T00:05:00Z", "UTC")).toBe("00:05");
  });

  it("does not throw on an unparseable timestamp", () => {
    expect(localDate("2026-11-03 garbage", "UTC")).toBe("2026-11-03");
    expect(localDate("garbage", "UTC")).toBe("unknown-date");
    expect(localTime("garbage", "UTC")).toBe("00:00");
  });
});

describe("naming", () => {
  it("channelSlug appends the last 6 id chars and survives empty names", () => {
    expect(channelSlug("Home", "chan_TESTchannel0000000000000")).toBe("home-000000");
    expect(channelSlug(null, "chan_TESTchannel0000000000000")).toBe("channel-000000");
    expect(channelSlug("Q&A / Notes!", "chan_abcdef")).toBe("q-a-notes-abcdef");
    // Two channels with the same name cannot collide.
    expect(channelSlug("Home", "chan_aaaaaa")).not.toBe(channelSlug("Home", "chan_bbbbbb"));
    // Unsafe characters in the id tail are neutralized.
    expect(channelSlug("Home", "chan_ab/..c")).toMatch(/^home-[A-Za-z0-9_-]{6}$/);
  });

  it("dayDirName joins the date and the slug", () => {
    expect(dayDirName("2026-11-02", "home-000000")).toBe("2026-11-02-home-000000");
  });

  it("compareSeq orders numerically, not lexically", () => {
    expect(compareSeq("9", "10")).toBeLessThan(0);
    expect(compareSeq("10", "9")).toBeGreaterThan(0);
    expect(compareSeq(5, "5")).toBe(0);
    expect(compareSeq("0007", "7")).toBe(0);
    expect(compareSeq("123456789012345678901", "123456789012345678902")).toBeLessThan(0);
    expect(["10", "9", "100", "1"].sort(compareSeq)).toEqual(["1", "9", "10", "100"]);
  });

  it("authorLabel uses display_name, then account, agent, routine, else Unknown", () => {
    expect(authorLabel(msg({ id: "a", display_name: "Sam" }), "Duet")).toBe("Sam");
    expect(authorLabel(msg({ id: "a", author_account_id: "user_x" }), "Duet")).toBe("You");
    expect(authorLabel(msg({ id: "a", author_agent_id: "cagt_x" }), "Duet")).toBe("Duet");
    expect(authorLabel(msg({ id: "a", author_routine_id: "r_x" }), "Duet")).toBe("Routine");
    expect(authorLabel(msg({ id: "a" }), "Duet")).toBe("Unknown");
  });
});

describe("renderDayLog", () => {
  const base = {
    agentName: "Duet",
    channelName: "Home",
    date: "2026-11-02",
    timeZone: "UTC",
  };

  it("nests replies under roots with H2 and H3 and writes bodies verbatim", () => {
    const messages = [
      msg({ id: "r2", seq: "4", created_at: "2026-11-02T10:00:00Z", author_routine_id: "r", body: "Daily digest" }),
      msg({ id: "r1", seq: "1", created_at: "2026-11-02T09:00:00Z", author_account_id: "u", body: "Review the\n\n- quarterly notes **now**" }),
      msg({ id: "c2", seq: "3", thread_root_id: "r1", created_at: "2026-11-02T09:10:00Z", author_account_id: "u", body: "Thanks" }),
      msg({ id: "c1", seq: "2", thread_root_id: "r1", created_at: "2026-11-02T09:05:00Z", author_agent_id: "a", body: "On it." }),
    ];
    expect(renderDayLog({ ...base, messages })).toBe(
      [
        "# Duet -- Home -- 2026-11-02",
        "",
        "## 09:00 You",
        "",
        "Review the\n\n- quarterly notes **now**",
        "",
        "### 09:05 Duet",
        "",
        "On it.",
        "",
        "### 09:10 You",
        "",
        "Thanks",
        "",
        "## 10:00 Routine",
        "",
        "Daily digest",
        "",
      ].join("\n")
    );
  });

  it("renders times in the given zone", () => {
    const out = renderDayLog({
      ...base,
      timeZone: "America/Chicago",
      messages: [msg({ id: "r1", created_at: "2026-11-03T02:30:00Z", author_account_id: "u" })],
    });
    expect(out).toContain("## 20:30 You");
  });

  it("treats a reply whose root is absent as a root", () => {
    const out = renderDayLog({
      ...base,
      messages: [msg({ id: "c1", thread_root_id: "missing_root", author_agent_id: "a" })],
    });
    expect(out).toContain("## 15:00 Duet");
    expect(out).not.toContain("###");
  });

  it("never drops a message whose root is itself a reply", () => {
    const out = renderDayLog({
      ...base,
      messages: [
        msg({ id: "r1", seq: "1", body: "root body" }),
        msg({ id: "c1", seq: "2", thread_root_id: "r1", body: "reply body" }),
        msg({ id: "c2", seq: "3", thread_root_id: "c1", body: "nested body" }),
      ],
    });
    expect(out).toContain("root body");
    expect(out).toContain("reply body");
    expect(out).toContain("nested body");
  });

  it("renderDayReadme states channel, date, zone and counts", () => {
    const messages = [
      msg({ id: "r1", seq: "1" }),
      msg({ id: "c1", seq: "2", thread_root_id: "r1" }),
      msg({ id: "r2", seq: "3" }),
    ];
    const out = renderDayReadme({ ...base, messages });
    expect(out).toContain("Home");
    expect(out).toContain("2026-11-02");
    expect(out).toContain("UTC");
    expect(out).toContain("Messages: 3 (2 top-level, 1 reply)");
    expect(out).toContain("conversation.md");
  });
});

describe("tasks", () => {
  it("isSuggestion is true only for an undone task with a found block", () => {
    const t = (data: Record<string, unknown>) => stored("x", data).task;
    expect(isSuggestion(t({ found: { connector: "calendar" } }))).toBe(true);
    expect(isSuggestion(t({ found: { connector: "calendar" }, done: true }))).toBe(false);
    expect(isSuggestion(t({}))).toBe(false);
    expect(isSuggestion(t({ found: null }))).toBe(false);
  });

  it("renderTasks groups open, suggested and done, newest done first", () => {
    const out = renderTasks([
      stored("a", { title: "Open one", done: false, createdAt: "2026-11-01T00:00:00Z" }),
      stored("s", { title: "Suggested one", found: { connector: "calendar", why: "Meeting soon" } }),
      stored("d1", { title: "Done early", done: true, doneAt: "2026-11-01T12:00:00Z" }),
      stored("d2", { title: "Done late", done: true, doneAt: "2026-11-02T12:00:00Z" }),
    ]);
    const open = out.indexOf("## Open");
    const suggested = out.indexOf("## Suggested");
    const done = out.indexOf("## Done");
    expect(open).toBeGreaterThan(-1);
    expect(suggested).toBeGreaterThan(open);
    expect(done).toBeGreaterThan(suggested);
    expect(out).toContain("- [ ] Open one");
    expect(out).toContain("- [ ] Suggested one");
    expect(out).toContain("Meeting soon");
    expect(out).toContain("calendar");
    expect(out.indexOf("Done late")).toBeLessThan(out.indexOf("Done early"));
    expect(out).toContain("- [x] Done late");
  });

  it("renderTasks marks tasks absent from the last sync and shows empty sections", () => {
    const out = renderTasks([stored("a", { title: "Gone", done: false }, false)]);
    expect(out).toContain("Gone");
    expect(out).toContain("not in the latest sync");
    expect(out).toContain("_None._");
  });

  it("renderTasks is deterministic regardless of input order", () => {
    const a = stored("a", { title: "A", createdAt: "2026-11-01T00:00:00Z" });
    const b = stored("b", { title: "B", createdAt: "2026-11-02T00:00:00Z" });
    expect(renderTasks([a, b])).toBe(renderTasks([b, a]));
  });
});
