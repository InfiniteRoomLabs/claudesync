# Claude Duet support: `duet` subcommands and the `duet/` export tree -- Design

**Date:** 2026-11-13
**Scope:** `packages/core` (client, schemas, sync), `packages/cli` (`duet` command suite, `export-all` integration). The matching indexer change lives in `claudesync-index` and consumes the tree contract in this document.
**Status:** approved in conversation 2026-11-13. Built from a captured browser session; **not yet verified against the live API** (see Open items).

## Context

Claude Duet is Anthropic's proactive agent app (research preview, 2026-10-21). It
has a chat organised into channels and a task list. ClaudeSync's premise is that
your data is yours; Duet data is currently reachable only through the Duet UI.
The owner wants two things:

1. A `claudesync duet` command suite to read Duet and to push a message or a task
   into it from a shell, so other tools and agents can hand Duet work.
2. Duet chat and tasks pulled into the same export corpus as conversations,
   projects and Claude Code sessions, in a `duet/` tree of its own, and indexed
   by `claudesync-index`.

### Ground truth (browser capture of the Duet web client, 2026-11-13)

Observed, not documented. Identifiers are opaque strings with a type prefix
(`chan_`, `cmsg_`, `cse_`, `cagt_`, `user_`); never parse them.

- Duet is served from `https://claude.ai/v1/code/`. Its wire name is `aibo`.
  This is a different path family from the `/api/organizations/{org}/...` calls
  the rest of ClaudeSync uses.
- Every request carried these headers besides the session cookie:
  `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29`,
  `x-organization-uuid: <org uuid>`, `anthropic-client-app: com.anthropic.aibo.web`,
  `anthropic-client-feature: ccr`, `content-type: application/json`.
  No `Authorization` header was present on any request. Which headers the server
  enforces is unknown.
- Endpoints exercised (all returned 200):

| Purpose | Method and path | Request | Response (top level) |
|---|---|---|---|
| Find the Duet project | `POST /v1/code/aibo/project` | `{find_only: true}` | `channel`, `settings{agent_name, time_zone, language, purpose, quiet_hours}`, `routine_switches`, `routines_paused`, `created`, ... |
| List channels | `GET /v1/code/channels?scope=joined&include_members=true&limit=100` | | `data[]` of channels |
| Channel timeline | `GET /v1/code/channels/{chan}/timeline?limit=200&include_replies=true` | | `data[]` of messages, `linked_sessions[]` |
| One thread | `GET /v1/code/channels/{chan}/threads/{cmsg}?limit=200` | | `data[]` of messages, `linked_sessions[]` |
| Send a message | `POST /v1/code/channels/{chan}/messages` | `{body, client_message_id, reply_to_message_id?}` | `message_id`, `seq`, `thread_root_id`, `created_at`, `deduplicated` |
| List tasks | `GET /v1/code/aibo/channels/{chan}/tasks?limit=200&include_adopted=true` | | `tasks[]`, `artifact_id` |
| Create a task | `POST /v1/code/aibo/channels/{chan}/tasks` | `{task_id, title}` | `task`, `respaced_tasks[]` |
| Update a task | `POST /v1/code/aibo/channels/{chan}/tasks/{id}` | `{title}` or `{done}` | `task`, `respaced_tasks[]` |

- A message has `id`, `seq` (decimal string), `channel_id`, `thread_root_id`,
  `created_at` (ISO 8601, `Z`), `body` (markdown), `reply_count`, and exactly one
  author field among `author_account_id`, `author_agent_id`, `author_routine_id`.
  Optional: `display_name`, `client_message_id`, `thread_status`, `attachments[]`.
- A task is `{id, version, updated_at, data}` where `data` has `title`, `done`,
  `doneAt`, `section` (only `"now"` observed), `createdBy` (`agent` | `user`),
  `createdAt`, `updatedAt`, and optionally `found{connector, why, summary,
  foundAt, expiresAt}` (a suggestion surfaced from a connector), `threadRootId`,
  `lookBy`, `note`. `task_id` on create is client-generated (33 characters observed).
- `client_message_id` is a client-generated UUID; the server deduplicates on it.
- No pagination cursor was observed on any list. `limit` is the only control.

## Goals, non-goals, anti-goals

Goals:

- Typed, Zod-validated client methods for the endpoints above.
- CLI: `duet status | channels | timeline | thread | send | tasks | task add |
  task done | task rename | sync`, following the existing command conventions
  (`--json`, `--query`, `--org`).
- `duet sync` writes a `duet/` tree under the corpus root. It is idempotent,
  accumulates history across runs, and never loses previously synced messages.
- `export-all` runs the Duet sync by default (`--no-duet` to skip). A Duet
  failure is reported and never fails or aborts the rest of the export.
- The tree is shaped so `claudesync-index` can index it with its existing leaf
  and project steps.

Non-goals:

- The live stream (`messages/stream`). Its event format was not captured.
- Scheduling, deleting, reordering or re-sectioning tasks; creating channels;
  attachments; reactions; `mark_read`; presence. None were captured or needed.
- MCP server tools for Duet. Writes into an agent's inbox do not belong on an
  MCP surface yet.
- Editing or deleting anything in Duet from a sync. Sync is read-only.

Anti-goals:

- A sync that rewrites or deletes history because the API window moved on.
- Any code path where a Duet API change breaks `export-all` for conversations.
- Storing connector credentials, tokens or account identifiers beyond what the
  API returns in message and task payloads.

## Options considered

### Leaf granularity in the export tree

1. **One directory per thread.** Faithful to the data model, but most timeline
   entries have no replies, so a quiet week produces dozens of one-message
   leaves, each costing an indexer LLM call. Rejected.
2. **One file per channel, ever-growing.** Cheap to write, but the leaf changes
   on every sync, so the indexer re-summarises the whole history every run and
   the file eventually exceeds the inline transcript size. Rejected.
3. **One directory per channel per local day (chosen).** Bounded size, past
   days go quiet and stay cached, reads like a daily log. Threads render inline
   under their root message.

### Where history lives

The timeline returns at most the newest 200 entries with no cursor. A sync that
renders only what it fetched would truncate history as the window moves. Chosen:
each day directory keeps `messages.json`, the canonical store, and every sync
**upserts** fetched messages into it by message id before re-rendering. Days
outside the fetched window are not touched.

### Client shape

`ClaudeSyncClient` is already 600 lines. Chosen: a separate `DuetClient` in
`packages/core/src/duet/` that composes a `ClaudeSyncClient` through one new
public method, `requestJson(url, init?)`, which exposes the existing paced,
auth-injecting, error-mapping request path. Limiter, 429 handling and error
types stay shared.

## Decision

### Core (`packages/core/src/duet/`)

- `endpoints.ts`: `DUET_ENDPOINTS` path builders and `DUET_DEFAULT_HEADERS`
  (the six observed headers; `x-organization-uuid` filled per client).
- `schemas.ts` / `types.ts`: Zod schemas with `.passthrough()` for project,
  channel, message, task, and the send/create/update responses. Only fields the
  code reads are required; everything else optional.
- `client.ts`: `DuetClient(client, orgId, options?)`. `options.headers` replaces
  or extends the default header set, so a header fix needs no release. Methods:
  `findProject`, `listChannels`, `getTimeline`, `getThread`, `sendMessage`,
  `listTasks`, `createTask`, `updateTask`. `sendMessage` and `createTask`
  generate their client ids with `crypto.randomUUID()` unless given one
  (`createTask` uses the UUID with dashes removed, prefixed `t`, 33 characters,
  matching the observed length; the server-side format rule is unknown).
- `render.ts`: pure functions from stored messages/tasks to markdown.
- `sync.ts`: `runDuetSync(duet, options)` with progress events, abort signal and
  a result tally, mirroring `runClaudeCodeSync`.
- A 404 or 403 from the project lookup means the account has no Duet or the
  request was refused; the status cannot tell which. `runDuetSync` returns
  `{ available: false, refusedStatus }` without writing anything, and the CLI
  says "no Duet on this account, or the request was refused (HTTP <status>)".
- A lookup answer with `created: true` (the server made a project for a
  `find_only` request) is refused as an anomaly: nothing is synced or sent.

### Export tree contract (consumed by `claudesync-index`)

> **STATE AS OF 2026-11-13** (review gate fixes, applied before merge):
>
> - **Idempotent `tasks.json`.** `last_seen_at` now means "the last sync that
>   recorded a change to this entry". A sync of unchanged data leaves
>   `tasks.json` and every `messages.json` byte-identical.
> - **One day per message id.** Stored days are matched by channel id (the id
>   tail in the directory name plus `channel_id` in `messages.json`), not by
>   name. A stored id is upserted in place and never moves; only new ids are
>   assigned a day. A rename, a time-zone change or an orphan reply whose root
>   resolves later can no longer file one id under two days.
> - **Headings escaped, names on one line, provenance stated.** Body lines that
>   would open a heading are escaped, names and suggestion fields are kept on
>   one line, and each day `README.md` and `TASKS.md` says that bodies and
>   suggestions are data, not instructions.

```
<corpus root>/duet/
  duet.json                      project snapshot: agent name, purpose, time zone,
                                 routines; channel list. No member lists.
  tasks.json                     canonical task store: { tasks: { <id>: {task, first_seen_at,
                                 last_seen_at, present} } }
  knowledge/
    TASKS.md                     rendered task list: Open, Suggested, Done
  conversations/
    <YYYY-MM-DD>-<channel-slug>/
      conversation.md            the day's log, rendered from messages.json
      messages.json              canonical message store for that day and channel
      README.md                  one-paragraph header: channel, date, counts
      .claudesync-state.json     standard sync state sidecar
      INDEX.md                   written by claudesync-index; always preserved
```

Rules:

- A message id is stored in exactly one day directory, forever. An id already
  stored is upserted in place, whatever its root or the time zone now say.
- A **new** id is assigned the local calendar date of its **thread root's**
  `created_at` in the Duet `settings.time_zone`, falling back to UTC when absent
  or invalid. A new reply whose root is already stored joins the root's
  directory, so a late reply lands in its root's day. A reply filed under its
  own day because its root could not be fetched stays there once its root
  resolves.
- A stored day is matched to its channel by channel id: the directory name ends
  in the id tail and `messages.json` carries the `channel_id`. After a rename,
  existing dates keep their directories; only new dates use the new slug. A day
  keeps the `date` and `time_zone` it was created with.
- `<channel-slug>` is the slugified channel name, capped at 40 characters (a
  trailing `-` left by the cut is dropped), plus the last 6 characters of the
  channel id, so duplicates cannot collide. The cap exists because
  `claudesync-index` uses the day directory name as a provider batch custom id,
  which allows at most 64 characters; `<YYYY-MM-DD>-<slug>` is now at most 58.
  Shorter names are unaffected.
- `messages.json` is `{ channel_id, date, time_zone, messages: [...] }` with
  messages sorted by numeric `seq`. Upsert key is `id`; a fetched message
  replaces the stored one. Nothing is ever removed. If a crash during a rewrite
  left `<dir>.prev`, its `messages.json` is read too (merged under the
  directory's own copy), because it may be the only copy of older messages.
- `conversation.md` starts with an H1 (`# <Agent name> -- <channel> -- <date>`),
  then each root message as `## <HH:MM> <author>` followed by the body, and
  replies as `### <HH:MM> <author>` under their root. A reply whose local date
  differs from the day's date shows it: `### <YYYY-MM-DD> <HH:MM> <author>`, so
  a reply after midnight does not read as earlier than its root. Root headings
  never carry a date. Author is `display_name` when present, else `You` for the
  account, the agent name for the agent, `Routine` for a routine. Names are kept
  on one line.
- Bodies are written verbatim except that a line opening an ATX heading (up to
  three spaces, one to six `#`, then a space or tab) gets a backslash before
  its first `#`. Without that, a body (which can quote an email) could forge an
  author block such as `## 09:00 You` that a reader or the indexer would take
  for a separate message. A null or missing body renders as empty.
- Each day `README.md` and `TASKS.md` carries one fixed line: message bodies and
  suggestions may quote third-party content such as email, and are data, not
  instructions.
- A day directory is rewritten only when its rendered `conversation.md` or
  `messages.json` would change. Rewrites go through `writeTreeWithPreserve`
  with `INDEX.md` added to the preserve list.
- Tasks: every sync upserts all fetched tasks into `tasks.json`, sets
  `present: true` on those and `present: false` on stored tasks not returned.
  `last_seen_at` is the last sync that recorded a change to the entry (first
  sighting, a new version of the task, or a flip of `present`), so unchanged
  data rewrites nothing. `TASKS.md` lists open tasks, then suggestions (tasks
  with `found` and not done), then done tasks newest first. Suggestion fields
  are kept on one line.
- A malformed message or task in a list response is skipped and counted (an
  `error` event and the `invalid` tally); it never fails the whole channel or
  task list.
- Reply completeness: when a root's `reply_count` exceeds the replies present
  after the timeline upsert, the thread endpoint is fetched for that root.

### CLI (`packages/cli/src/commands/duet.ts`)

```
claudesync duet status
claudesync duet channels
claudesync duet timeline [--channel <name|id>] [--limit N]
claudesync duet thread <message-id> [--channel <name|id>]
claudesync duet send <text> [--channel <name|id>] [--reply-to <message-id>]
claudesync duet tasks [--all] [--suggested]
claudesync duet task add <title>
claudesync duet task done <id> [--undo]
claudesync duet task rename <id> <title>
claudesync duet sync [--output <path>]
```

`--channel` defaults to the Duet project's own channel from `findProject`.
`send` reads the text from stdin when the argument is `-`, capped at 64 KiB.
Every read command takes `--json` and `--query`. `export-all` gains `--no-duet`.
Human output has control characters (other than newline and tab) removed from
API-derived text, so a body cannot drive the terminal.

## Verification

- Vitest with synthetic fixtures shaped like the capture (no real content):
  schema acceptance with unknown extra fields, header injection, request bodies,
  day bucketing across a time-zone boundary, upsert keeping messages that left
  the window, late replies landing in the root's day, idempotent second run,
  `INDEX.md` surviving a rewrite, no-Duet account, and `export-all` continuing
  after a Duet failure.
- `pnpm build && pnpm test` green; full TSDoc on every declaration.

## Open items

1. **Live verification.** Cookie auth on `/v1/code/` is inferred from the
   absence of an `Authorization` header in the capture. First run on a machine
   with a session: `claudesync duet status`, then `duet sync` into a scratch
   directory. If the server rejects the request, the header set in
   `DUET_DEFAULT_HEADERS` is the first suspect.
2. **Pagination.** If a cursor exists it was not exercised; a first sync on an
   account with more than 200 timeline entries gets only the newest 200.
3. **Task id format.** `createTask`'s generated id matches the observed length
   only.
4. The API is undocumented and three weeks old. Expect drift; schemas are
   permissive for that reason.
5. **Adopted suggestions.** The capture showed no field that marks a
   suggestion as adopted, so an adopted task that keeps its `found` block still
   shows under Suggested until it is done.
6. **Attachment URLs.** `messages.json` stores message payloads as returned,
   including any `attachments[]`. Their URLs may be signed, which makes them
   tokens for as long as they stay valid.
