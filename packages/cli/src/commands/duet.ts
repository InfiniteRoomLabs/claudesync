import { Command } from "commander";
import path from "node:path";
import {
  DuetClient,
  authorLabel,
  compareSeq,
  isSuggestion,
  localDate,
  localTime,
  normalizeTimeZone,
  readTextCapped,
  runDuetSync,
  stripControlChars,
  type DuetMessage,
  type DuetProgressEvent,
  type DuetTask,
  type DuetTimelineResponse,
  type RunDuetSyncOutcome,
} from "@infinite-room-labs/claudesync-core";
import { createClient, outputJson, resolveOrgId } from "../utils.js";

/**
 * Largest message `duet send -` reads from stdin: 64 KiB. Far above any chat
 * message, and low enough that an accidental pipe of a large file fails fast
 * instead of being buffered and posted.
 */
const MAX_STDIN_BYTES = 64 * 1024;

/**
 * Print one line of human output. Every human-form line goes through here,
 * because most carry API-derived text (bodies, names, titles, suggestion
 * fields) whose control characters could drive the terminal.
 *
 * @param line - The line; control characters other than newline and tab are
 * removed before printing.
 */
function say(line = ""): void {
  console.log(stripControlChars(line));
}

/**
 * Explain why there is no Duet project, in the words every command uses. A 403
 * or 404 can mean the account has no Duet or that the request was refused (for
 * example over a header the server enforces), so both are named.
 *
 * @param refusedStatus - HTTP status of the refused lookup; undefined when the
 * server answered with a project that has no channel.
 * @returns A sentence fragment with no trailing punctuation.
 */
function noDuetReason(refusedStatus: number | undefined): string {
  return refusedStatus === undefined
    ? "no Duet project channel on this account"
    : `no Duet on this account, or the request was refused (HTTP ${refusedStatus})`;
}

/** Options shared by every `duet` subcommand that talks to the API. */
interface CommonOptions {
  /** Organization id; auto-detected from the session when omitted. */
  org?: string;
  /** Print raw JSON instead of the human-readable form. */
  json?: boolean;
  /** JMESPath expression applied to the JSON output; implies `json`. */
  query?: string;
}

/**
 * Add the shared `--org`, `--json` and `--query` options to a subcommand.
 *
 * @param cmd - The subcommand to extend.
 * @returns The same command, for chaining.
 */
function withCommon(cmd: Command): Command {
  return cmd
    .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
    .option("--json", "Output as JSON")
    .option(
      "--query <expression>",
      "JMESPath query to filter JSON output (implies --json)"
    );
}

/**
 * Build an authenticated {@link DuetClient} from the environment session.
 *
 * @param org - Optional organization id override.
 * @returns A Duet client over the shared, paced transport.
 */
async function connect(org?: string): Promise<DuetClient> {
  const { auth, client } = createClient();
  return new DuetClient(client, await resolveOrgId(auth, org));
}

/**
 * Connect, then resolve the channel a subcommand acts on.
 *
 * @param org - Optional organization id override.
 * @param channel - Channel name or id; omitted means the Duet project channel.
 * @returns The client and the resolved channel id.
 */
async function connectToChannel(
  org?: string,
  channel?: string
): Promise<{ duet: DuetClient; channelId: string }> {
  const duet = await connect(org);
  return { duet, channelId: await duet.resolveChannelId(channel) };
}

/**
 * Print JSON when the user asked for it, otherwise run the human renderer.
 *
 * @param options - The parsed common options.
 * @param data - The value to print as JSON.
 * @param human - Renders the same data for people.
 */
function emit(options: CommonOptions, data: unknown, human: () => void): void {
  if (options.json || options.query) {
    outputJson(data, options.query);
  } else {
    human();
  }
}

/**
 * Parse a positive integer option value.
 *
 * @param value - The raw option text.
 * @returns The parsed integer.
 * @throws {@link Error} when the text is not a positive integer.
 */
function parseLimit(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`expected a positive integer, got "${value}"`);
  }
  return n;
}

/**
 * Read all of standard input as UTF-8 text, up to {@link MAX_STDIN_BYTES}.
 *
 * @returns The full input.
 * @throws {@link Error} when stdin holds more than 64 KiB; nothing is sent.
 */
async function readStdin(): Promise<string> {
  try {
    return await readTextCapped(process.stdin, MAX_STDIN_BYTES);
  } catch {
    throw new Error(
      `stdin is larger than 64 KiB (${MAX_STDIN_BYTES} bytes); a Duet message read from stdin is capped there. Nothing was sent.`
    );
  }
}

/**
 * Look up the agent name and time zone used to render messages for people.
 *
 * @param duet - The Duet client.
 * @returns The configured values, or neutral defaults when there is no project.
 */
async function displayContext(
  duet: DuetClient
): Promise<{ agentName: string; timeZone: string }> {
  const project = await duet.findProject();
  return {
    agentName: project?.settings?.agent_name || "Duet",
    timeZone: normalizeTimeZone(project?.settings?.time_zone),
  };
}

/**
 * Print messages oldest first, with a local timestamp and author per message.
 *
 * @param messages - Messages in any order.
 * @param context - Agent name and time zone from {@link displayContext}.
 */
function printMessages(
  messages: readonly DuetMessage[],
  context: { agentName: string; timeZone: string }
): void {
  if (messages.length === 0) {
    say("No messages.");
    return;
  }
  for (const m of [...messages].sort((a, b) => compareSeq(a.seq, b.seq))) {
    const when = `${localDate(m.created_at, context.timeZone)} ${localTime(m.created_at, context.timeZone)}`;
    const root = m.thread_root_id && m.thread_root_id !== m.id ? `  (reply to ${m.thread_root_id})` : "";
    say(`[${when}] ${authorLabel(m, context.agentName)}  ${m.id}${root}`);
    for (const line of (m.body ?? "").split("\n")) {
      say(`  ${line}`);
    }
    say();
  }
}

/**
 * Print a timeline or thread response: JSON when asked for, otherwise the
 * human form. Only the human form needs the agent name and time zone, so only
 * it costs the extra project lookup.
 *
 * @param options - The parsed common options.
 * @param duet - The Duet client, for {@link displayContext}.
 * @param response - The timeline or thread to print.
 */
async function emitMessages(
  options: CommonOptions,
  duet: DuetClient,
  response: DuetTimelineResponse
): Promise<void> {
  if (options.json || options.query) {
    outputJson(response, options.query);
    return;
  }
  printMessages(response.data, await displayContext(duet));
}

/**
 * Print tasks as a checklist with their ids.
 *
 * @param tasks - The tasks to show.
 */
function printTasks(tasks: readonly DuetTask[]): void {
  if (tasks.length === 0) {
    say("No tasks.");
    return;
  }
  for (const t of tasks) {
    const tag = isSuggestion(t) ? " (suggested)" : "";
    say(`[${t.data.done ? "x" : " "}] ${t.id}  ${t.data.title}${tag}`);
    if (t.data.found?.why) {
      say(`      why: ${t.data.found.why}`);
    }
  }
}

/**
 * Print one progress event from {@link runDuetSync}. Failures go to stderr as a
 * single `Duet note:` line, so they read as notes and never as fatal errors.
 *
 * @param e - The event.
 */
export function printDuetProgress(e: DuetProgressEvent): void {
  switch (e.type) {
    case "start":
      say(`  Duet: ${e.channels} channel(s)`);
      break;
    case "channel-done":
      say(`[duet] ${e.channel}: ${e.written} day(s) written, ${e.unchanged} unchanged`);
      break;
    case "tasks-done":
      say(`[duet] tasks: ${e.tasks}`);
      break;
    case "error":
      console.error(
        stripControlChars(`  Duet note: ${e.scope}: ${e.message.replace(/\s+/g, " ")}`)
      );
      break;
  }
}

/**
 * Describe a guarded Duet sync outcome as one line for the end of an export.
 *
 * @param outcome - The outcome of `runDuetSyncGuarded`.
 * @returns A single printable line, with no newline and no control characters.
 */
export function describeDuetOutcome(outcome: RunDuetSyncOutcome): string {
  switch (outcome.status) {
    case "unavailable":
      return `Duet: ${noDuetReason(outcome.result.refusedStatus)}, skipped.`;
    case "failed":
      return stripControlChars(`Duet: skipped (${outcome.message.replace(/\s+/g, " ")}).`);
    case "synced": {
      const r = outcome.result;
      return (
        `Duet: ${r.channels} channel(s), ${r.daysWritten} day(s) written, ` +
        `${r.daysUnchanged} unchanged, ${r.tasks} task(s)` +
        (r.errors > 0 ? `, ${r.errors} note(s) above` : "")
      );
    }
  }
}

/** `duet status`: show whether the account has Duet and how it is configured. */
const statusCommand = withCommon(
  new Command("status").description("Show the Duet project: agent, channel, time zone, routines")
).action(async (options: CommonOptions) => {
  const duet = await connect(options.org);
  const lookup = await duet.lookupProject();
  const project = lookup.project;
  emit(options, project, () => {
    if (!project) {
      say(`Duet: ${noDuetReason(lookup.status)}.`);
      return;
    }
    const s = project.settings;
    say(`Agent:      ${s?.agent_name ?? "(unnamed)"}`);
    say(`Channel:    ${project.channel?.id ?? "(none)"}`);
    say(`Time zone:  ${s?.time_zone ?? "(unset, UTC assumed)"}`);
    say(`Language:   ${s?.language ?? "(unset)"}`);
    say(`Purpose:    ${s?.purpose ?? "(unset)"}`);
    say(`Routines:   ${project.routines_paused ? "paused" : "running"}`);
  });
  if (!project) process.exitCode = 1;
});

/** `duet channels`: list the joined channels. */
const channelsCommand = withCommon(
  new Command("channels").description("List the Duet channels you have joined")
).action(async (options: CommonOptions) => {
  const duet = await connect(options.org);
  const channels = await duet.listChannels();
  emit(options, channels, () => {
    if (channels.length === 0) {
      say("No channels.");
    }
    for (const c of channels) {
      say(`${c.id}  ${c.name ?? "(unnamed)"}`);
    }
  });
});

/** `duet timeline`: show the newest messages of a channel. */
const timelineCommand = withCommon(
  new Command("timeline")
    .description("Show the newest messages of a channel, replies included")
    .option("--channel <name|id>", "Channel name or id (default: the Duet project channel)")
    .option("--limit <n>", "Maximum entries to fetch (default 200)", parseLimit)
).action(async (options: CommonOptions & { channel?: string; limit?: number }) => {
  const { duet, channelId } = await connectToChannel(options.org, options.channel);
  await emitMessages(options, duet, await duet.getTimeline(channelId, { limit: options.limit }));
});

/** `duet thread`: show one thread. */
const threadCommand = withCommon(
  new Command("thread")
    .description("Show one thread: the root message and its replies")
    .argument("<message-id>", "Thread root message id")
    .option("--channel <name|id>", "Channel name or id (default: the Duet project channel)")
).action(
  async (messageId: string, options: CommonOptions & { channel?: string }) => {
    const { duet, channelId } = await connectToChannel(options.org, options.channel);
    await emitMessages(options, duet, await duet.getThread(channelId, messageId));
  }
);

/** `duet send`: post a message, optionally as a reply. */
const sendCommand = withCommon(
  new Command("send")
    .description("Send a message to a channel (use - to read the text from stdin)")
    .argument("<text>", "Message text, or - to read it from stdin")
    .option("--channel <name|id>", "Channel name or id (default: the Duet project channel)")
    .option("--reply-to <message-id>", "Reply to this message instead of posting top-level")
).action(
  async (
    text: string,
    options: CommonOptions & { channel?: string; replyTo?: string }
  ) => {
    // One trailing newline is the shell's, not the author's, so drop it.
    const body = text === "-" ? (await readStdin()).replace(/\r?\n$/, "") : text;
    const { duet, channelId } = await connectToChannel(options.org, options.channel);
    const sent = await duet.sendMessage(channelId, {
      body,
      replyToMessageId: options.replyTo,
    });
    emit(options, sent, () => {
      say(`Sent ${sent.message_id}${sent.deduplicated ? " (deduplicated)" : ""}`);
    });
  }
);

/** `duet tasks`: list tasks of the project channel. */
const tasksCommand = withCommon(
  new Command("tasks")
    .description("List Duet tasks (open tasks by default)")
    .option("--all", "Show every task: open, suggested and done")
    .option("--suggested", "Show only suggestions the agent surfaced")
).action(
  async (options: CommonOptions & { all?: boolean; suggested?: boolean }) => {
    const { duet, channelId } = await connectToChannel(options.org);
    const { tasks } = await duet.listTasks(channelId);
    const shown = tasks.filter((t) => {
      if (options.all) return true;
      if (options.suggested) return isSuggestion(t);
      return !t.data.done && !isSuggestion(t);
    });
    emit(options, shown, () => printTasks(shown));
  }
);

/** `duet task add`: create a task. */
const taskAddCommand = withCommon(
  new Command("add").description("Create a task").argument("<title>", "Task title")
).action(async (title: string, options: CommonOptions) => {
  const { duet, channelId } = await connectToChannel(options.org);
  const written = await duet.createTask(channelId, title);
  emit(options, written, () => {
    say(`Created ${written.task.id}: ${written.task.data.title}`);
  });
});

/** `duet task done`: mark a task done, or reopen it with `--undo`. */
const taskDoneCommand = withCommon(
  new Command("done")
    .description("Mark a task done")
    .argument("<id>", "Task id")
    .option("--undo", "Reopen the task instead")
).action(async (id: string, options: CommonOptions & { undo?: boolean }) => {
  const { duet, channelId } = await connectToChannel(options.org);
  const written = await duet.updateTask(channelId, id, { done: !options.undo });
  emit(options, written, () => {
    say(`${options.undo ? "Reopened" : "Done"} ${written.task.id}: ${written.task.data.title}`);
  });
});

/** `duet task rename`: change a task's title. */
const taskRenameCommand = withCommon(
  new Command("rename")
    .description("Rename a task")
    .argument("<id>", "Task id")
    .argument("<title>", "New title")
).action(async (id: string, title: string, options: CommonOptions) => {
  const { duet, channelId } = await connectToChannel(options.org);
  const written = await duet.updateTask(channelId, id, { title });
  emit(options, written, () => {
    say(`Renamed ${written.task.id}: ${written.task.data.title}`);
  });
});

/** `duet task`: group of task-changing subcommands. */
const taskCommand = new Command("task")
  .description("Create or change Duet tasks")
  .addCommand(taskAddCommand)
  .addCommand(taskDoneCommand)
  .addCommand(taskRenameCommand);

/** `duet sync`: write the `duet/` tree under the corpus root. */
const syncCommand = new Command("sync")
  .description("Export Duet chat and tasks into <output>/duet/ as greppable markdown")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--output <path>", "Corpus root; content is written under <path>/duet/ (default: ./org-export)")
  .action(async (options: { org?: string; output?: string }) => {
    const duet = await connect(options.org);
    const outputRoot = path.resolve(options.output ?? "./org-export");

    const abortController = new AbortController();
    const onSigint = () => {
      console.error("\nInterrupted -- finishing the current channel, then stopping...");
      abortController.abort();
    };
    process.on("SIGINT", onSigint);
    try {
      const result = await runDuetSync(duet, {
        outputRoot,
        signal: abortController.signal,
        onProgress: printDuetProgress,
      });
      if (!result.available) {
        say(`Duet: ${noDuetReason(result.refusedStatus)}; nothing exported.`);
        process.exitCode = 1;
        return;
      }
      console.log(abortController.signal.aborted ? "\nDuet export stopped (interrupted)." : "\nDuet export complete!");
      console.log(`  Output: ${path.join(outputRoot, "duet")}`);
      console.log(`  Channels: ${result.channels}, messages fetched: ${result.messages}`);
      console.log(`  Days written: ${result.daysWritten}, unchanged: ${result.daysUnchanged}`);
      console.log(`  Tasks: ${result.tasks}`);
      if (result.invalid > 0) console.log(`  Malformed entries skipped: ${result.invalid}`);
      if (result.errors > 0) console.log(`  Errors: ${result.errors}`);
      if (abortController.signal.aborted) {
        process.exitCode = 130;
      } else if (result.errors > 0) {
        process.exitCode = 1;
      }
    } finally {
      process.off("SIGINT", onSigint);
    }
  });

/**
 * The `claudesync duet` command group: read Duet, send it a message or a task,
 * and export it. Built from a captured browser session; not yet verified
 * against the live API.
 */
export const duetCommand = new Command("duet")
  .description("Read and write Claude Duet (proactive agent) chat and tasks")
  .addCommand(statusCommand)
  .addCommand(channelsCommand)
  .addCommand(timelineCommand)
  .addCommand(threadCommand)
  .addCommand(sendCommand)
  .addCommand(tasksCommand)
  .addCommand(taskCommand)
  .addCommand(syncCommand);
