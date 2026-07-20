# Conversation Rename Endpoint -- Spike Findings

Run 2026-07-20 against the live claude.ai web API (browser capture via the Chrome extension, then SDK-header reproduction). Structural findings only; test names were synthetic; the blessed target conversation was rolled back to unnamed.

## The write

- **Endpoint:** `PUT /api/organizations/<org_uuid>/chat_conversations/<conversation_uuid>`
- **Body:** `{"name": "<string>"}` -- partial-update semantics; only the sent field changes.
- **Response:** HTTP **202** with the updated conversation summary JSON (`uuid`, `name`, `summary`, ...). Not 200; not null.
- **Headers:** requires the SDK's full header set (`Cookie`, `User-Agent`, `Accept`, `Content-Type`). A minimal hand-rolled cookie+UA fetch got 403 `permission_error: Invalid authorization`; duplicated content-type headers got 400 `Input should be a valid dictionary`. The SDK's existing auth header path works as-is.
- The browser UI rename uses this exact request (observed via network capture, then reproduced byte-equivalently).

## Verified behaviors

| Probe | Result |
|---|---|
| Rename applies | 202; name visible in list + detail immediately |
| Same-value re-assignment | 202, idempotent, no error |
| 150-char name | accepted and stored verbatim (no server-side truncation observed at this length; our 60-grapheme cap is a product choice, not a server limit) |
| Emoji/Unicode name | accepted and stored verbatim |
| **Rollback `{"name": ""}`** | 202; conversation returns to unnamed in list + detail. **Reversibility proven.** |
| `updated_at` | **bumps on every rename** (including rollback). Consequence: each renamed conversation is refetched once by the next sync (skip-same misses). A batch rename of N conversations costs N refetches on the following sync -- document in the CLI. |
| Project conversations | eligible -- the probe target belonged to a project and renamed normally |

## Unnamed definition

In the conversations list payload, unnamed means `name === ""` (empty string; the field is always present). Selection predicate: `!name || name.trim() === ""` is safe.

## Server-side auto-titling (bonus finding)

Opening an unnamed conversation in the claude.ai UI SOMETIMES triggers server-side title generation (observed once: a conversation gained a generated name within seconds of being opened, with `updated_at` NOT bumped by that generation; a second unnamed conversation opened for 10+ seconds did not title). Unreliable and undocumented -- the client-side heuristic feature remains justified. Do not build on auto-titling.

## Residue

The blessed target (`57df4700-...`) ended the spike with `name: ""` (unnamed, as it started) and a bumped `updated_at`. A second unnamed conversation was opened read-only in the browser but retained `name: ""`.
