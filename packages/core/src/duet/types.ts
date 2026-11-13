import type { z } from "zod";
import type {
  DuetChannelSchema,
  DuetChannelsResponseSchema,
  DuetDayStoreSchema,
  DuetMessageSchema,
  DuetProjectSchema,
  DuetSendResponseSchema,
  DuetSettingsSchema,
  DuetStoredTaskSchema,
  DuetTaskDataSchema,
  DuetTaskSchema,
  DuetTaskStoreSchema,
  DuetTasksResponseSchema,
  DuetTaskWriteResponseSchema,
  DuetTimelineResponseSchema,
} from "./schemas.js";

/** A Duet channel. Inferred from {@link DuetChannelSchema}. */
export type DuetChannel = z.infer<typeof DuetChannelSchema>;
/** Duet project settings. Inferred from {@link DuetSettingsSchema}. */
export type DuetSettings = z.infer<typeof DuetSettingsSchema>;
/** The Duet project. Inferred from {@link DuetProjectSchema}. */
export type DuetProject = z.infer<typeof DuetProjectSchema>;
/** A chat message. Inferred from {@link DuetMessageSchema}. */
export type DuetMessage = z.infer<typeof DuetMessageSchema>;
/** Channel list response. Inferred from {@link DuetChannelsResponseSchema}. */
export type DuetChannelsResponse = z.infer<typeof DuetChannelsResponseSchema>;
/** Timeline or thread response. Inferred from {@link DuetTimelineResponseSchema}. */
export type DuetTimelineResponse = z.infer<typeof DuetTimelineResponseSchema>;
/** Send-message response. Inferred from {@link DuetSendResponseSchema}. */
export type DuetSendResponse = z.infer<typeof DuetSendResponseSchema>;
/** A task payload. Inferred from {@link DuetTaskDataSchema}. */
export type DuetTaskData = z.infer<typeof DuetTaskDataSchema>;
/** A task. Inferred from {@link DuetTaskSchema}. */
export type DuetTask = z.infer<typeof DuetTaskSchema>;
/** List-tasks response. Inferred from {@link DuetTasksResponseSchema}. */
export type DuetTasksResponse = z.infer<typeof DuetTasksResponseSchema>;
/** Create or update task response. Inferred from {@link DuetTaskWriteResponseSchema}. */
export type DuetTaskWriteResponse = z.infer<typeof DuetTaskWriteResponseSchema>;

/**
 * Body of a task update. Exactly one of the two fields is sent, matching what
 * the Duet UI sends: a rename or a completion toggle.
 */
export type DuetTaskPatch =
  | {
      /** New title. */
      title: string;
      /** Not allowed alongside `title`. */
      done?: never;
    }
  | {
      /** New completion state. */
      done: boolean;
      /** Not allowed alongside `done`. */
      title?: never;
    };

/** A day's canonical message store. Inferred from {@link DuetDayStoreSchema}. */
export type DuetDayStore = z.infer<typeof DuetDayStoreSchema>;
/** One entry of the canonical task store. Inferred from {@link DuetStoredTaskSchema}. */
export type DuetStoredTask = z.infer<typeof DuetStoredTaskSchema>;
/** The canonical task store. Inferred from {@link DuetTaskStoreSchema}. */
export type DuetTaskStore = z.infer<typeof DuetTaskStoreSchema>;
