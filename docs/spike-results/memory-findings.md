# Project Memory -- Endpoint Discovery Spike Findings

**Date:** 2026-07-13
**Method:** Live network + in-page `fetch` probing of the claude.ai web app (logged-in session), via the claude-in-chrome extension. Read probes ran against a real project; all writes ran only against a throwaway project (`claudesync-memory-spike`) created for this spike with synthetic content. No memory or edit text is reproduced here -- only shapes, counts, and lengths.
**Feature availability:** The memory UI is present on **claude.ai web** (not desktop-only). No Electron fallback was needed. `?modal=memory` deep-links the Manage modal.

## Headline result: the design's push model was wrong

Two assumptions in `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md` are **falsified** by the API and must change:

1. **Edits are NOT per-entry records with stable server IDs.** They are a single ordered **array of plain strings** called `controls`, returned inside the memory GET. The "Manage edits (10)" count equals `controls.length`.
2. **There is no per-edit create/delete endpoint and no direct memory-doc write.** The only writable surface is a single **`PUT .../memory/controls`** that replaces the **whole** controls array. Add / delete / clear are all "compute the new array, PUT it." This collapses the design's per-file + compare-and-delete + resumable-saga machinery into one atomic whole-list replace.

Also material: the write is **synchronous and slow (~57 s)** because it regenerates the memory doc inline, and it **no-ops on a project with no existing memory**.

## Confirmed endpoints

All under `https://claude.ai`. Org and project UUIDs redacted to `<org>` / `<project>`. Method lists are from `Allow` response headers (405 on OPTIONS returns the allowed verb).

| Operation | Method + path | Notes |
|---|---|---|
| Read memory + edits | `GET /api/organizations/<org>/memory?project_uuid=<project>` | Returns `{ memory, controls, updated_at }`. **`Allow: GET` only** -- the memory doc has no write verb. |
| Write edits (add/delete/clear/regenerate) | `PUT /api/organizations/<org>/memory/controls?project_uuid=<project>` | Body `{ "controls": string[] }`. **`Allow: PUT` only.** Whole-array replace. ~57 s synchronous (regenerates memory). Returns `200` with body `null`. |
| Feature settings | `GET /api/organizations/<org>/memory/settings` | Account-scoped flags. `Allow: GET` only. |

### Not found (probed, 404)

`.../memory/regenerate`, `.../memory/refresh`, `.../memory/generate`, `.../projects/<project>/memory`, `.../memory/<project>`. There is **no standalone regenerate endpoint** -- regeneration is a side effect of the `PUT controls` write (and of the nightly job). There is **no direct memory-doc edit endpoint** -- the pencil icon opens the controls/edit flow, it does not PUT prose.

### Query-param quirk (important for correctness)

Only `?project_uuid=<project>` selects that project's memory. `?project_id=` and `?project=` are **silently ignored** and fall back to the account-level default memory (a different, smaller `controls` array). The bare `GET /api/organizations/<org>/memory` (no param) also returns the account-level default. **Always use `project_uuid`.**

## Response shapes (synthetic; real values redacted)

`GET .../memory?project_uuid=<project>`:

```json
{
  "memory": "string  // markdown, server-generated. Real sample was 16686 chars.",
  "controls": ["string", "..."],  // the edits list. Real sample: 10 entries, all strings, lengths 50-217 chars.
  "updated_at": "2026-07-12T07:38:26.626000+00:00"  // ISO 8601, may be null before first generation
}
```

Empty/never-generated project returns `{ "memory": "", "controls": null, "updated_at": null }`.

`GET .../memory/settings` (account-level flags; names are server codewords):

```json
{
  "enabled_saffron": true,
  "enabled_saffron_search": true,
  "enabled_melange": null,
  "memory_mode": null,
  "classic_mode_available": true,
  "melange_available": false
}
```

`PUT .../memory/controls` body:

```json
{ "controls": ["Gerald the penguin prefers rye flour.", "The bakery opens at 6am."] }
```

Response: `200`, body literal `null`. Latency observed: **56.7 s** (one call, real timing). No job id, no polling handle -- the call blocks until regeneration finishes.

## Write semantics (verified + open)

- **Whole-list replace.** `add` = GET controls, append, PUT. `delete` = GET controls, drop entry, PUT. `clear` = PUT `{ "controls": [] }`. No partial ops exist.
- **Synchronous ~57 s.** The client must allow a long timeout (>=90 s). The existing Node-24 `fetch` client has no such write today; whatever wraps this needs an explicit long timeout and a user-facing "this takes about a minute" warning.
- **No-op without existing memory.** PUT to the throwaway (no chats, empty memory) returned `200`/`null` but `controls` stayed `null` on read-back. Controls appear to require an already-generated memory doc (i.e. at least one chat + a generation). **Open:** whether controls set on an empty project are dropped, or queued for the next nightly generation -- could not distinguish today (nightly job hadn't run for the throwaway).
- **Concurrency:** no `ETag` seen. `updated_at` is the only version signal. **Open:** whether the server rejects a stale write -- untested (would require a real second-client race). Treat `updated_at` as an optimistic-concurrency hint: GET immediately before PUT, and merge remote+local controls before PUT so a blind whole-array replace never silently drops another client's edit.

## Design-spec exit criteria

| Criterion (spec section 3) | Outcome |
|---|---|
| Stable read schema for memory + edits | **Met.** `{ memory, controls, updated_at }`; edits = `controls` string array. |
| Stable identifiers for deletable edits | **N/A -- resolved differently.** No IDs exist; edits are positional in a whole-list array. Delete = PUT the array without the entry. The spec's "disable deletion if no stable IDs" rule does NOT apply, because delete is a whole-list replace, not a per-ID op. |
| Regeneration completion signal | **Met (and simplified).** No async job: `PUT controls` blocks ~57 s and returns `200` when done. Standalone regenerate does not exist. |
| Concurrency mechanism | **Partial.** `updated_at` only; no ETag. Server-side stale-write rejection unconfirmed. |
| Edits apply immediately vs next regen | **Met.** `PUT controls` regenerates the memory doc immediately (inline, ~57 s) -- on a project that already has memory. |
| Direct-edit (pencil) status | **Resolved: no direct doc write exists.** `/memory` is `GET`-only. Phase 3 (direct memory replacement) is **dead** -- there is no endpoint to build it on. |

## Consequences for the design (feeds the spec revision)

1. **Local representation:** a single `memory/edits.md` (one control per entry) replaces the `edits/<id>.md` per-file + `outbox/` + `drafts/` scheme. The merge unit is the whole ordered list; per-file only made sense with server IDs, which don't exist.
2. **Push = one atomic call.** GET current controls -> three-way merge (base / local / remote) -> PUT merged array. The resumable-saga / compensate-delete / idempotency-key apparatus is unnecessary: there is exactly one mutation per push, and the server applies it atomically. Journaling still wraps it for audit + crash safety, but there is no multi-op ordering problem.
3. **Never blind-PUT.** Because PUT replaces the whole array, a push MUST refetch and merge remote controls first, or it silently clobbers edits made from another client. This is the one real correctness hazard.
4. **Memory doc is GET-only, permanently.** Keep `MEMORY.md` server-authoritative and unwritable; drop Phase 3 entirely.
5. **Regenerate is not a separate action.** Editing controls IS the regenerate trigger. Expose a `regenerate` convenience only as "PUT the current controls back" (paying the ~57 s), and label the cost.
6. **Long-timeout write path.** Any writer (SDK, CLI, gated MCP) needs a >=90 s timeout and a warning.
7. **Feature gate:** check `memory/settings` (and treat unavailable memory as a capability result, not an empty doc).

## Spike artifacts / cleanup

- Throwaway project `claudesync-memory-spike` (`019f5ce8-...`) remains in the account, empty (no chats, no memory). It couldn't hold memory without seeded chats + a generation. **Safe to delete manually** whenever; left in place rather than hard-deleting from here.
- No writes touched any real project. Read probes on the real project were non-mutating GETs.
