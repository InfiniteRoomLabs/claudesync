import { describe, expect, it } from "vitest";
import {
  DuetChannelSchema,
  DuetChannelsResponseSchema,
  DuetMessageSchema,
  DuetProjectSchema,
  DuetSendResponseSchema,
  DuetTaskSchema,
  DuetTaskWriteResponseSchema,
  DuetTasksResponseSchema,
  DuetTimelineResponseSchema,
} from "@core/duet/schemas.js";

/** Synthetic message shaped like the capture, plus an unknown extra field. */
const message = {
  id: "cmsg_TESTmessage000000000000001",
  seq: "17",
  channel_id: "chan_TESTchannel0000000000000",
  thread_root_id: "cmsg_TESTmessage000000000000001",
  created_at: "2026-11-02T10:00:00Z",
  body: "Review the quarterly notes",
  reply_count: 0,
  author_account_id: "user_TESTaccount0000000000000",
  brand_new_field: { nested: true },
};

/** Synthetic task shaped like the capture, plus unknown extras at both levels. */
const task = {
  id: "t0123456789abcdef0123456789abcdef",
  version: 3,
  updated_at: "2026-11-02T10:05:00Z",
  data: {
    title: "Draft the agenda",
    done: false,
    section: "now",
    createdBy: "agent",
    found: { connector: "calendar", why: "Meeting soon", summary: "Agenda" },
    future_field: 1,
  },
  top_level_extra: "kept",
};

describe("Duet schemas", () => {
  it("accept unknown extra fields and keep them", () => {
    const parsedMessage = DuetMessageSchema.parse(message);
    expect((parsedMessage as Record<string, unknown>).brand_new_field).toEqual({
      nested: true,
    });

    const parsedTask = DuetTaskSchema.parse(task);
    expect((parsedTask as Record<string, unknown>).top_level_extra).toBe("kept");
    expect((parsedTask.data as Record<string, unknown>).future_field).toBe(1);

    const channel = DuetChannelSchema.parse({
      id: "chan_TESTchannel0000000000000",
      name: "Home",
      members: [{ id: "user_x" }],
      shiny: 1,
    });
    expect((channel as Record<string, unknown>).shiny).toBe(1);

    const project = DuetProjectSchema.parse({
      channel: { id: "chan_TESTchannel0000000000000" },
      settings: { agent_name: "Duet", time_zone: "UTC", unknown_setting: 1 },
      routine_switches: { a: true },
      routines_paused: false,
      created: false,
      extra: 1,
    });
    expect(project.settings?.agent_name).toBe("Duet");

    expect(
      DuetChannelsResponseSchema.parse({ data: [{ id: "chan_x" }], more: 1 }).data
    ).toHaveLength(1);
    expect(
      DuetTimelineResponseSchema.parse({
        data: [message],
        linked_sessions: [{ id: "cse_x" }],
      }).data
    ).toHaveLength(1);
    expect(
      DuetSendResponseSchema.parse({
        message_id: "cmsg_x",
        seq: "18",
        thread_root_id: "cmsg_x",
        created_at: "2026-11-02T10:00:00Z",
        deduplicated: false,
        more: 1,
      }).message_id
    ).toBe("cmsg_x");
    expect(
      DuetTasksResponseSchema.parse({ tasks: [task], artifact_id: "a" }).tasks
    ).toHaveLength(1);
    expect(
      DuetTaskWriteResponseSchema.parse({ task, respaced_tasks: [task], x: 1 })
        .respaced_tasks
    ).toHaveLength(1);
  });

  it("require only the fields the code reads on a message", () => {
    expect(() => DuetMessageSchema.parse({ ...message, id: undefined })).toThrow();
    // A null or missing body is accepted and rendered as empty.
    expect(DuetMessageSchema.parse({ ...message, body: undefined }).body).toBeUndefined();
    expect(DuetMessageSchema.parse({ ...message, body: null }).body).toBeNull();
    expect(() => DuetMessageSchema.parse({ ...message, body: 5 })).toThrow();
    expect(() =>
      DuetMessageSchema.parse({ ...message, created_at: undefined })
    ).toThrow();
    // Everything else is optional.
    const minimal = DuetMessageSchema.parse({
      id: "cmsg_x",
      seq: "1",
      created_at: "2026-11-02T10:00:00Z",
      body: "hi",
    });
    expect(minimal.thread_root_id).toBeUndefined();
  });

  it("require id and data.title on a task", () => {
    expect(() => DuetTaskSchema.parse({ ...task, id: undefined })).toThrow();
    expect(() => DuetTaskSchema.parse({ id: "x", data: {} })).toThrow();
    expect(DuetTaskSchema.parse({ id: "x", data: { title: "T" } }).data.done).toBeUndefined();
  });

  it("accept seq as a string or a number", () => {
    expect(DuetMessageSchema.parse({ ...message, seq: 5 }).seq).toBe(5);
    expect(DuetMessageSchema.parse({ ...message, seq: "5" }).seq).toBe("5");
  });

  it("allow a project response with no channel", () => {
    expect(DuetProjectSchema.parse({ created: false }).channel).toBeUndefined();
  });
});
