# Project Memory Sync -- Design

**Date:** 2026-07-13 (Phase 2 push sections updated 2026-07-15 post-implementation)
**Status:** Phase 1 (pull) and Phase 2 (push) implemented and shipped; see section 9 for phase-by-phase status
**Method:** Two independent plans (Claude Fable 5 + Codex GPT-5 on the same inputs), reconciled, cross-reviewed by Codex, then **corrected against the Phase-0 endpoint spike** (`docs/spike-results/memory-findings.md`). The spike falsified the pre-spike push model; sections 4 and 6 are rewritten to match the real API. Convergent decisions elsewhere are unchanged. Sections 6, 8, and 9 carry a second round of corrections from 2026-07-15 live-API smoke testing during Phase 2 implementation (`controls: null` semantics, principal-derivation scope, no journal) -- superseded pre-implementation language is struck through and kept for history rather than deleted.

> **Spike correction (read first):** Edits are not per-entry records with stable IDs. They are a single ordered **array of strings** (`controls`) returned inside the memory GET. The only write is `PUT .../memory/controls` replacing the **whole** array, which regenerates the memory doc **synchronously (~57 s)**. The memory doc itself is **GET-only** (no write endpoint exists). This collapses the per-file / compare-and-delete / resumable-saga machinery into one atomic whole-list replace and **kills Phase 3** (direct memory replacement). Details: `docs/spike-results/memory-findings.md`.
>
> **Smoke correction (2026-07-15, read second):** the spike's read of `controls: null` as "memory never generated" was itself wrong. `controls: null` can coexist with a fully generated memory doc (zero edit instructions); only `memory === ""` is a reliable never-generated signal. See section 6.

## 1. Feature under sync

Claude Desktop (2026-07) exposes per-project **memory**:

- A private markdown memory doc. UI copy: "Claude regenerates project memory every evening from your past chats in this project. Only you can see this memory, and it is not shared with other project users."
- **Edits**: discrete natural-language instructions the user submits (prompt box in the Manage modal). Listed under "Manage edits (N)"; each entry individually deletable; "Clear edits" wipes all.
- **Regenerate** on demand.
- A pencil icon on the Memory card may allow direct text editing (unconfirmed).

No memory endpoints are known today (`endpoints.ts` has none; the PRD predates the feature).

## 2. Core model decision

**The memory doc is server/model-authoritative; the edits list is user-authoritative.** This asymmetry drives everything:

- **Pull**: memory doc + edits -> local files. Server wins for memory content; ClaudeSync never textually merges generated memory (nightly regeneration can reorganize it wholesale, making line merges misleading).
- **Push**: only the edits list (the `controls` array). `MEMORY.md` text is never pushed -- it is GET-only server-side (spike-confirmed, no write endpoint exists). Writing edits regenerates the doc as a synchronous side effect (~57 s), so there is no separate "regenerate" action to push.
- Memory is **per-user within a project** (private "Only you" semantics), so sync state is keyed by a principal fingerprint as well as project UUID.

## 3. Phase 0 (DONE): endpoint discovery spike

**Executed 2026-07-13.** Full results: `docs/spike-results/memory-findings.md`. Confirmed API:

| Operation | Method + path (`?project_uuid=<project>`) |
|---|---|
| Read memory + edits | `GET /api/organizations/<org>/memory` -> `{ memory, controls, updated_at }` |
| Write edits (add/delete/clear) | `PUT /api/organizations/<org>/memory/controls` body `{ controls: string[] }`, ~57 s sync, regenerates the doc |
| Feature flags | `GET /api/organizations/<org>/memory/settings` |

Exit-criteria outcomes:

- **Read schema:** met -- `{ memory: string, controls: string[], updated_at: string|null }`. Edits ARE `controls`.
- **Stable edit IDs:** none exist -- edits are positional strings in a whole-list array. Delete = PUT the array without the entry (no per-ID op, so the "disable deletion" fallback does not apply).
- **Regenerate signal:** the `PUT controls` call blocks ~57 s and returns `200` when regeneration finishes; there is no async job and no standalone regenerate endpoint.
- **Concurrency:** `updated_at` only (no ETag); server-side stale-write rejection unconfirmed -> merge-before-PUT is mandatory (section 6).
- **Immediate vs nightly:** edits apply immediately via the inline regeneration (on a project that already has memory).
- **Direct edit (pencil):** no direct doc-write endpoint exists; `/memory` is GET-only. **Phase 3 is removed.**
- **Query param:** only `project_uuid` selects the project; `project_id`/`project` silently fall back to account-level memory. Always use `project_uuid`.
- **Empty project:** `PUT controls` no-ops (200/null, nothing persisted) until the project has a generated memory; open question whether such writes are dropped or queued.

## 4. Local representation

Inside the existing project export tree:

```
<project-dir>/
  knowledge/
  conversations/
  memory/
    MEMORY.md                        # rendered memory doc; server-authoritative, GET-only, managed
    edits.md                         # the controls array, one entry per block; user-editable push source
    .claudesync-memory-state.json    # sidecar: merge base (hashes only)
```

- **A single `edits.md`, not per-edit files.** The spike killed the per-file rationale: `controls` has no server IDs and no per-entry endpoint -- the merge unit is the whole ordered array, and the server applies it atomically in one PUT. One file matches that exactly. Entries are separated by a line containing only `---` (a control may itself be multi-line prose). Human ergonomics also come from `claudesync projects memory edits list`.
- No `outbox/` or `drafts/` dirs -- those existed to stage a multi-op saga that no longer exists. New instructions are just new blocks appended to `edits.md`; a push reconciles the whole file against remote in one call.
- Content canonicalization before hashing/writing: UTF-8, strip BOM, CRLF/CR -> LF, exactly one trailing newline; per-entry, trim and drop empty blocks.
- **Superseded (Phase 2 build):** the line below describing a txn journal was written pre-implementation and does not match what shipped. There is no journal for project memory push. Crash-safety comes from the opening `GET` in `applyProjectMemoryPush` being re-run: a crash at any point before a successful `PUT` just re-plans from scratch next run; a crash after a successful `PUT` (with or without a completed verify) is caught because the next run's opening `GET` already reflects the applied write, so the merge against it comes back a no-op. See section 6's rewritten "Atomicity, idempotency, audit" for the actual mechanism. Kept below verbatim as history, not as current behavior: ~~The txn journal lives outside `memory/` (project level, per idea-099 txn core) so it survives subtree swaps.~~

### Sidecar schema (memory-scoped)

`memory/.claudesync-memory-state.json`, strict Zod, `schema_version: 1`:

| Field | Purpose |
|---|---|
| `project_uuid` | Owning project (the `project_uuid` query value). |
| `principal_fingerprint` | sha256 of the account identifier. Mismatch = hard error (fail closed); prevents one account clobbering another's private memory in a shared project dir. |
| `memory.{content_sha256, remote_updated_at}` | Merge base for `MEMORY.md` (GET-only, so this is just change detection). |
| `controls_base: string[]` hashes, i.e. `edits[]: {content_sha256, position}` | Ordered per-entry hash of the last-synced controls array. Base for the section-6 three-way merge. |
| `remote_snapshot_sha256` | Hash of `{memory hash + ordered control hashes}`, timestamps excluded. Drives the true no-op check. |
| `last_successful_txn_id`, `last_pull_at`, `last_push_at` | Audit linkage. |

Sidecar holds hashes and metadata only -- **never memory or instruction text**. Written only after the local materialization or remote op fully succeeds. Gitignored (as are journal files); `MEMORY.md` and `edits.md` are tracked in git-format exports.

## 5. Pull behavior

Order: project lock -> read/validate state -> single `GET memory` (returns doc + `controls` together) -> canonicalize + hash -> merge decision -> stage `MEMORY.md` + `edits.md` -> atomic swap -> changelog entry -> git commit (if applicable) -> write sidecar -> journal commit -> unlock.

### Hash-based merge (two managed entities: `MEMORY.md` and `edits.md`; B = base hash from sidecar, L = local, R = remote)

| Condition | Result |
|---|---|
| L == B and R == B | No-op |
| L == B and R != B | Pull remote |
| L != B and R == B | Local change pending; pull aborts without overwriting |
| L == R | Converged; refresh state only |
| L != B, R != B, L != R | Conflict; write nothing, report |
| No base, no local | Initial pull |
| No base, local differs from remote | Conflict; adopt neither silently |

`MEMORY.md` is GET-only server-side, so a local edit to it can never be pushed -- the "local change pending" / conflict rows for `MEMORY.md` mean "you edited a read-only mirror"; pull reports it and `--force` re-pulls. For `edits.md`, "local change pending" is a real pending push (section 6 reconciles it).

### Idempotency and regen churn

- True no-op when `remote_snapshot_sha256` matches state and local managed hashes still match state. Timestamp-only changes refresh the sidecar but produce **no file write, no changelog entry, no git commit**.
- Nightly regeneration that changes content is real change: materialize once, at most one git commit per pull ("Sync project memory"). No semantic/model-based diff suppression.
- Changelog lines are content-free: "Project memory changed on claude.ai", "2 memory edit instructions added", never excerpts or instruction text.

### Integration with project export

- `assembleProjectBundle` gains optional memory input; memory rides the leading project commit under `memory/`.
- **Export default: opt-in** (`--include-memory` on `projects export` / `export-all`). Rationale: default-on would silently add highly sensitive, git-history-retained data to existing automated exports and configured remotes after an upgrade. Your-data-is-yours supports availability, not surprise disclosure. The dedicated `memory pull` command is always explicit and needs no flag.
- `writeProjectBundle` / `replaceWithPreserve` must share the same project-level lock and explicitly preserve a locally-modified `memory/edits.md` (pending push) and the journal; the memory sidecar is rewritten intentionally, not dropped incidentally.
- Long-export race: `GET memory` at project **finalization** (after conversation fan-out); if `updated_at` advanced since the run started, refetch once. Never write an hours-old memory snapshot over a newer local pull.

## 6. Push behavior

**Status: implemented (Phase 2, 2026-07-15).** This section is rewritten post-implementation to match what shipped; where it disagrees with the pre-implementation language further down (superseded and struck through, not deleted), the implemented behavior wins.

The spike reduced push to a **single operation**: reconcile `edits.md` against remote `controls` and `PUT` the merged array. Add, delete, and clear are just different local `edits.md` states feeding the same one PUT. There is no multi-op saga, no per-entry endpoint, no idempotency key, no "regenerate" op (the PUT regenerates inline), and -- corrected post-implementation -- **no journal** (see the superseded note at the end of section 4 and "Atomicity, idempotency, audit" below).

### The one hazard: never blind-PUT

`PUT controls` replaces the **whole** array. If ClaudeSync PUTs the local list without first merging in remote changes, it silently deletes edits another client added. So every push refetches and three-way merges before the PUT.

### Corrected API fact: `controls: null` does not mean "never generated" (2026-07-15 smoke correction)

The spike's original read of `controls: null` as "this project has never had memory generated" was **wrong**, discovered by live-API smoke testing after the plan was written. The corrected semantics, which the shipped code implements:

- **`memory === ""`** is the only reliable never-generated signal. A project in this state has no memory doc and no edit list; there is nothing to merge against, so push refuses immediately (`action: "no-memory"`, no network write).
- **`controls === null` can coexist with a fully generated memory doc.** A project with generated memory and zero edit instructions also reports `controls: null` -- this is a legitimate "no edits yet" state, not a never-generated state. Treating it as `"no-memory"` would have made a project's *first* edit unpushable forever (a real bug caught by the smoke test, not a hypothetical).
- **Consequence:** whenever `remote.memory !== ""`, `remote.controls` is normalized to `[]` before merging, regardless of whether it was `null` or an empty array. The three-way merge and PUT proceed normally against that empty base -- **push attempts the PUT for a generated-memory project with null controls**, so a first-edit push is not silently dropped.
- **If the server does not actually persist that first-edit PUT** (an open question the spike could not resolve, since no endpoint confirms initialization support per-project), the post-PUT verification GET (below) catches it: a verify response with `controls === null` after a `200` PUT throws rather than reporting success, and local `edits.md` / `controls_base` are left untouched so the pending edit is never silently lost.

### Push algorithm

1. Acquire the per-project advisory lock (see "Advisory lock" below); validate the sidecar exists and its `project_uuid` matches; **verify principal fingerprint** against `computePrincipalFingerprint(accountId)` (mismatch = hard error, `--adopt-legacy-principal` is the sanctioned migration -- see section 8).
2. `GET memory` -> current remote `memory`, `controls` (R), and `updated_at`. Always fresh; the sidecar is never trusted as a stand-in for current remote state.
3. If `remote.memory === ""` -> plan is `"no-memory"`; return without reading `edits.md` or writing anything. Otherwise normalize `R` to `[]` if `null` (see the correction above) and proceed.
4. Validate no local control entry contains a line equal to the `edits.md` delimiter (`---`) -- such an entry could never round-trip through `edits.md` on a later pull, so it is refused before merging, not silently mangled.
5. Three-way merge the control arrays: base `B` (sidecar `controls_base`), local `L` (`edits.md` parsed on `---`, or an explicit override for `edits clear`), remote `R` (normalized).
   - Entry in L not in B -> **local add**, keep.
   - Entry in B not in L -> **local delete**, drop.
   - Entry in R not in B (and not a local delete of that same text) -> **remote add**, keep.
   - Entry in B not in R -> **remote delete**, drop.
   - Same text added both sides -> dedupe to one (controls are plain strings; exact-text equality is the identity).
   - Order: preserve R's order for surviving remote entries, append local adds after. Deterministic.
6. If the merged array (normalized) **equals** the normalized `R` -> `action: "no-op"`; no remote write. Local files are still converged to the fetched remote (a no-op write, may be byte-identical) so the sidecar and `MEMORY.md`/`edits.md` reflect the fresh `GET` even when nothing needed pushing.
7. Else `action: "put"` -> **`PUT controls` (merged array)** with a **>=90 s timeout** (the call blocks ~57 s regenerating). This call is never retried by design: a timeout or any other error propagates unmodified, because the write may already have applied server-side and a blind retry could double-apply or stack two ~57 s regenerations.
8. On a successful `PUT` (`200`), re-`GET memory` to verify -- the **hybrid post-PUT verification**:
   - If the verify response's `controls === null`, the write did not visibly take effect (server lost it, or does not support initializing the edit list via this API for this project). This **throws** rather than reporting success; nothing is materialized, so `edits.md` and the sidecar's `controls_base` are untouched and the pending local edit survives to the next push attempt.
   - If the verify response's controls (normalized) **exactly equal** the merged array that was sent, the write is confirmed: materialize the full snapshot (`MEMORY.md`, `edits.md`, and the sidecar including `controls_base` and `last_push_at`), `action: "written"`.
   - If the verify response's controls **differ** from what was sent (most likely a concurrent external write landed between this push's opening `GET` and its `PUT` -- see "residual GET->PUT race" below), only `MEMORY.md` and a narrow slice of the sidecar (`memory_content_sha256`, `remote_updated_at`, `remote_snapshot_sha256`) are updated by a dedicated partial writer. `edits.md` and `controls_base` are deliberately left untouched so the next push re-merges the local intent that did not make it to the server, instead of silently treating a dropped local add as an accepted deletion. `action: "verify-mismatch"` -- callers (CLI) surface this as a warning and a nonzero exit; nothing is silently lost, but the push did not fully land.
9. `clear` is the same path with local `edits.md` emptied (merged array `[]` only if no remote-add survives; a concurrent remote add still survives the merge).

### Advisory lock (~57 s window motivation)

The whole push body (steps 1-8) runs inside a per-project advisory lock on `<dir>/.claudesync-memory.lock` (`fs.openSync` create-exclusive, so two concurrent acquirers can never both believe they hold it). This exists specifically because the push body blocks for ~57 s on the `PUT` -- long enough that a user watching a CLI that "looks stuck" re-running the same push in a second terminal is a realistic self-race, not a theoretical one. The lock is advisory only (it does not coordinate with a process that ignores the lockfile) and has nothing to do with the removed journal; it is pure mutual exclusion around one directory's push. Stale takeover after 10 minutes (comfortably past the ~57 s write plus scheduling slack) so a crashed process never wedges the lock permanently.

### Residual GET->PUT race (no server CAS)

The spike found `updated_at` but no ETag or other precondition header, and left open whether the server honors a stale-write precondition at all. The shipped implementation does **not** send one -- merge-before-PUT (steps 2-7) is the only guard, and there remains a residual window between step 2's `GET` and step 7's `PUT` landing where another client's write could slip in unseen. This is accepted, not eliminated: the hybrid post-PUT verification (step 8) catches the race *after the fact* -- the `"verify-mismatch"` outcome above is exactly what a caught race looks like -- but it does not prevent the PUT from momentarily overwriting the interloper's write before verify runs one more `GET`. If claude.ai ever exposes a working precondition, wiring it into step 7 would close this window instead of only detecting it.

### Atomicity, idempotency, audit -- corrected mechanism (supersedes idea-099 journal language below)

**What shipped has no journal.** The paragraph immediately below (kept for history, prefixed accordingly) describes a `journal begin` / `journal-commit` envelope planned pre-implementation; it was never built, because the spike's single-atomic-PUT model made it unnecessary. The actual mechanism:

- No lock-scoped journal, no op-kind records, no separate audit log for project memory push. The **sidecar itself, plus the idempotent opening `GET`, is the entire crash-safety story.**
- **Ambiguity is bounded** because there is one write. If the `PUT` times out at the client but the server applied it (plausible given ~57 s), the next run's opening `GET` shows the merged array already present -> the merge comes back a no-op (step 6) instead of attempting to resend it. No compensation, no uncertain-txn state machine, no orphan risk.
- A crash between a successful `PUT` and the sidecar write (whether during the verify `GET` or during materialization) replays identically: the next run's opening `GET` shows the applied state, the merge is a no-op, the sidecar advances. There is nothing to roll back and nothing left partially applied that the next run's `GET` does not already see.
- Cookie expiry mid-`PUT`: 401/403 aborts before or during; the write either didn't happen (retry) or did (next `GET` shows it). Reauth, re-verify principal fingerprint, re-run -- the merge makes re-running safe.
- Optimistic concurrency was never added (see "residual GET->PUT race" above) -- the spike's open question of whether the server honors a stale `updated_at` precondition was never resolved, and the merge-before-PUT plus hybrid verify is the guard that shipped instead.

<sub>**Superseded, kept for history -- do not implement:** ~~Envelope: `lock -> recover -> GET+merge/hash -> journal begin -> PUT -> verify/re-GET -> local commit -> state write -> journal commit`. Journal op kinds: `project-memory-pull`, `project-memory-controls-put`. Records carry hashes, status codes, error classes, `updated_at` before/after -- never content.~~</sub>

## 7. Surfaces

### SDK (`packages/core`)

Two confirmed endpoints -> two client methods. `ENDPOINTS.memory(orgId)` = `/api/organizations/<org>/memory`, `ENDPOINTS.memoryControls(orgId)` = `.../memory/controls`; both take a `project_uuid` query param.

```ts
// getProjectMemory always passes ?project_uuid; controls IS the edits list.
getProjectMemory(orgId, projectId): Promise<{ memory: string; controls: string[]; updatedAt: string | null }>
// The one write. Whole-array replace; ~57 s; caller must use a long timeout.
putProjectMemoryControls(orgId, projectId, controls: string[], opts?: { timeoutMs?: number }): Promise<void>
```

No memory-doc write method (GET-only). No per-edit or regenerate methods (they don't exist). Sync layer separates planning from applying -- **corrected names, as shipped**: `planProjectMemoryPush` (no network I/O; validates the sidecar, checks the `memory === ""` no-memory case, normalizes `controls: null` to `[]`, three-way merges, returns a plan with the merged array + `"put"`/`"no-op"`/`"no-memory"` action, hashes and counts only, no content) / `applyProjectMemoryPush` (owns the lock, the opening `GET`, the plan, the `PUT`, the hybrid post-PUT verification, and materialization -- the pre-implementation names `planProjectMemorySync` / `applyProjectMemorySync` / `syncProjectMemory` were never built). The write goes through the existing Node-24 client and shared limiter with an explicit >=90 s timeout (no curl fallback, no generic auto-retry).

### MCP server (stays stdio-only)

- Read tool, always on: `get_project_memory` (returns doc + controls).
- Write tool registered **only** when launched with `CLAUDESYNC_MCP_WRITE_SCOPE=project-memory` (scoped -- not a general write switch): `put_project_memory_controls`. One tool, because there is one write.
- The write tool requires the project UUID as an explicit confirmation field and the `updated_at` seen in a prior `get_project_memory` call as `expectedUpdatedAt` (stale-read guard: rejects if the live remote's `updated_at` has advanced past it). It performs the merge-before-PUT internally so an MCP client cannot blind-clobber, and applies the same corrected `no-memory` semantics as the CLI/core path (refuses only on `memory === ""`; a `null` controls array on generated memory is a normal first-edit case). It also applies the hybrid post-PUT verification (throws on a post-PUT `controls === null`; reports before/after `updated_at` on a verify mismatch rather than silently succeeding). Response returns before/after hashes and `updated_at`, never echoed content. It warns the call takes ~1 minute.
- Filesystem sync is not exposed as an MCP tool (MCP clients must not pick host output paths).

### CLI

```
claudesync projects memory show|pull|status|push <project-id> [--output <dir>]
claudesync projects memory edits list|clear <project-id>
```

`push` and `edits clear` print the merge plan (adds/deletes count, content-free) and default to dry-run; remote mutation needs `--apply` and warns "~1 minute"; `edits clear --apply` additionally needs `--confirm-project <project-id>`. No `regenerate` subcommand -- `push` (re-PUTting current controls) is the only way to force regeneration, and it says so. `status` reports clean / pending adds / pending deletes / conflict (both sides changed), content-free. `push` additionally accepts `--adopt-legacy-principal` (with the same `--confirm-project` requirement) to migrate a sidecar written under the Phase 1 org-keyed principal to the Phase 2 account-uuid principal -- see section 8.

## 8. Privacy controls (required, not optional)

Memory is the most sensitive data ClaudeSync touches (legal names, medical, employment detail).

- Broad export opt-in (section 5); warn when the target is a git repo, and again if it has configured remotes (history retains deleted memory).
- `memory/` dirs created owner-only; files `0600` where supported.
- Memory/instruction content never appears in progress output, errors, journals, changelogs, debug logs, telemetry, or crash reports; never sent to another model for diffing.
- Fixtures synthetic only; spike captures redacted before commit.
- Principal mismatch fails closed. Existing cookie hygiene (clear `CLAUDE_AI_COOKIE` after read) unchanged.
  - **Phase 1 limitation (superseded by Phase 2 -- kept for history):** ~~the principal fingerprint is currently derived from the organization id, not a per-user account id (the SDK's `AuthProvider` exposes only `getOrganizationId()`). For a single-member org this is 1:1 with the user, but two members of the same org would share a fingerprint, so the guard does not distinguish users within an org.~~
  - **Phase 2, as shipped:** a new `getAccount()` client method over `/api/account` returns the account uuid, and `computePrincipalFingerprint` is now keyed on that uuid instead of the org id. Distinguishes users within a shared org, closing the Phase 1 gap. **All three memory commands derive the principal identically** -- `pull`, `status`, and `push` all resolve `accountId` the same way (`createClient` + `resolveOrgId` + `client.getAccount().uuid`, see `resolveMemoryPrincipal` in the CLI) and stay interchangeable against the same local sidecar. This was itself a smoke-driven correction (2026-07-15): the original Phase 2 plan only updated `push`'s principal, which would have made a fresh `pull` (still org-keyed) immediately fail `push`'s account-keyed principal check -- requiring a migration on day one of a brand-new sync. Aligning all three read/write principal derivations eliminates that: a fresh `pull` -> `push` needs no migration.
  - **`--adopt-legacy-principal`** exists solely for sidecars that predate this alignment -- ones written by the already-merged Phase 1 pull code before this principal-derivation fix landed (still org-keyed on disk). It is not a general-purpose "trust me" override: it requires `--confirm-project <project-id>` matching the target project, reads the existing sidecar, and rewrites only its `principal_fingerprint` from the org-keyed value to the account-keyed value -- `memory.{content_sha256, remote_updated_at}` and `controls_base` are carried through unchanged, so it adopts identity without discarding merge history. Returns `"already-account-keyed"` (a no-op) if the sidecar already matches, so re-running it is safe.

## 9. Phasing

**Phase 2 (push) status: COMPLETE as of 2026-07-15**, cross-verified against the live API via smoke testing that corrected two API-fact errors in the original plan (`controls: null` semantics; principal-derivation scope) -- see the corrections folded into sections 6 and 8 above.

- **P0 -- Spike**: DONE (2026-07-13). `docs/spike-results/memory-findings.md`.
- **P1 -- Pull**: DONE. `getProjectMemory` + Zod schema, local layout (`MEMORY.md` + `edits.md`) + sidecar, hash merge, `memory pull`/`status`/`show`, read-only MCP tool, `--include-memory` export, changelog/git integration. Tests: nightly churn, no-op pulls, principal mismatch, dirty-local abort, crash recovery. Shipped value alone (read-only archive of memory).
- **P2 -- Push**: DONE. `putProjectMemoryControls` (>=90 s timeout, no retry), `getAccount` (account-uuid principal), three-way controls merge, merge-before-PUT, per-project advisory lock, hybrid post-PUT verification (not the originally-planned journal -- see section 6), `edits clear`, dry-run/`--apply`, `--adopt-legacy-principal`, gated MCP write tool. Tests: merge correctness (all six merge rows), never-blind-PUT, crash-replays-as-no-op via the opening-`GET` mechanism (no journal to replay from), cookie-expiry re-run safety, first-edit push on generated-memory-with-null-controls (the corrected case), verify-mismatch preserving pending local edits.
- **P3 -- REMOVED**: no direct memory-doc write endpoint exists; `MEMORY.md` is permanently server-owned.
- **P1.5 follow-up (not yet built):** a core `status.ts` rewrite for richer remote-vs-local status reporting. Deferred out of Phase 2 because `push` computes its own authoritative plan independently (via `planProjectMemoryPush`) and does not depend on a shared status module for correctness -- richer status is a UX improvement, not a push-correctness requirement. The CLI's current `status` command (`describeMemoryStatus` in `packages/cli/src/commands/projects.ts`) is a narrower, CLI-local implementation in the meantime.

## 10. Risks

- **API churn / rollout variance**: isolate memory schemas (`.passthrough()`) so failures never break conversation/project reads; treat unavailable memory (`memory/settings` flags off, or `{memory:"",controls:null}`) as a capability result, not an empty doc.
- **~57 s synchronous write**: long timeout + user warning; never wrap in generic retry (a retry could stack two 57 s regenerations). The merge makes a manual re-run safe. The per-project advisory lock (section 6) additionally prevents the user's own re-run from racing itself during that window.
- **Blind whole-array PUT clobbering another client**: THE correctness hazard -- always GET + three-way merge before PUT (section 6). Last-writer-wins is banned.
- **`controls: null` semantics (corrected 2026-07-15, superseded below):** ~~Empty-project write no-op: writes to a project with no generated memory silently don't persist (spike open question); `status`/`push` must detect `controls==null` remote and tell the user to chat first / wait for nightly generation rather than reporting success.~~ **As shipped:** `controls: null` is not itself an empty-project signal (see section 6) -- only `memory === ""` is, and push refuses immediately in that case with no network write. For a project with generated memory and `controls: null` (a legitimate zero-edits state), push now **attempts** the PUT rather than refusing; if the server silently fails to persist a first-edit write to such a project (still an open, unresolved question -- no endpoint confirms per-project initialization support), the post-PUT verification GET catches it: a `controls === null` verify response after a `200` throws instead of reporting success, and the pending local edit is preserved for the next attempt rather than lost.
- **Nightly regen racing pulls/exports**: `updated_at`-guarded refetch; single lock across memory sync and whole-project export.
- **Optimistic-concurrency unproven**: never implemented (see section 6's "residual GET->PUT race"); merge-before-PUT plus hybrid post-PUT verification is the guard that shipped, catching a lost race after the fact rather than preventing it.
- **Git retention of sensitive data**: opt-in export + remote warnings.
