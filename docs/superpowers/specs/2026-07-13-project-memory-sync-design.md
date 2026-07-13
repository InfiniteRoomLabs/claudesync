# Project Memory Sync -- Design

**Date:** 2026-07-13
**Status:** Revised post-spike, pending approval
**Method:** Two independent plans (Claude Fable 5 + Codex GPT-5 on the same inputs), reconciled, cross-reviewed by Codex, then **corrected against the Phase-0 endpoint spike** (`docs/spike-results/memory-findings.md`). The spike falsified the pre-spike push model; sections 4 and 6 are rewritten to match the real API. Convergent decisions elsewhere are unchanged.

> **Spike correction (read first):** Edits are not per-entry records with stable IDs. They are a single ordered **array of strings** (`controls`) returned inside the memory GET. The only write is `PUT .../memory/controls` replacing the **whole** array, which regenerates the memory doc **synchronously (~57 s)**. The memory doc itself is **GET-only** (no write endpoint exists). This collapses the per-file / compare-and-delete / resumable-saga machinery into one atomic whole-list replace and **kills Phase 3** (direct memory replacement). Details: `docs/spike-results/memory-findings.md`.

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
- The **txn journal lives outside `memory/`** (project level, per idea-099 txn core) so it survives subtree swaps.

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

The spike reduced push to a **single operation**: reconcile `edits.md` against remote `controls` and `PUT` the merged array. Add, delete, and clear are just different local `edits.md` states feeding the same one PUT. There is no multi-op saga, no per-entry endpoint, no idempotency key, no "regenerate" op (the PUT regenerates inline).

### The one hazard: never blind-PUT

`PUT controls` replaces the **whole** array. If ClaudeSync PUTs the local list without first merging in remote changes, it silently deletes edits another client added. So every push refetches and three-way merges before the PUT.

### Push algorithm

1. Acquire project lock; validate state; **verify principal fingerprint** (mismatch = hard error).
2. `GET memory` -> current remote `controls` (R) and `updated_at`.
3. Three-way merge the control arrays: base `B` (sidecar `controls_base`), local `L` (`edits.md` parsed on `---`), remote `R`.
   - Entry in L not in B -> **local add**, keep.
   - Entry in B not in L -> **local delete**, drop.
   - Entry in R not in B (and not a local delete of that same text) -> **remote add**, keep.
   - Entry in B not in R -> **remote delete**, drop.
   - Same text added both sides -> dedupe to one (controls are plain strings; exact-text equality is the identity).
   - Order: preserve R's order for surviving remote entries, append local adds after. Deterministic.
4. If the merged array **equals R** -> no remote write needed (idempotent no-op); refresh sidecar only.
5. Else journal-begin, then **`PUT controls` (merged array)** with a **>=90 s timeout** (the call blocks ~57 s regenerating).
6. On `200`: re-`GET memory` to capture the regenerated doc + canonical controls -> materialize `MEMORY.md` + `edits.md` -> git commit -> journal-commit -> **write sidecar last**.
7. `clear` is the same path with local `edits.md` emptied (merged array `[]` only if no remote-add survives; a concurrent remote add still survives the merge unless `--force-clear` is given).

### Atomicity, idempotency, audit (idea 099)

- Envelope: `lock -> recover -> GET+merge/hash -> journal begin -> PUT -> verify/re-GET -> local commit -> state write -> journal commit`.
- Journal op kinds: `project-memory-pull`, `project-memory-controls-put`. Records carry hashes, status codes, error classes, `updated_at` before/after -- **never content**.
- **Ambiguity is bounded** because there is one write. If the PUT times out at the client but the server applied it (plausible given ~57 s), the next run's step-2 GET shows the merged array already present -> step-4 no-op. No compensation, no uncertain-txn state machine, no orphan risk. A crash between PUT-200 and sidecar-write replays as: re-GET shows applied state, merge is a no-op, sidecar advances.
- Cookie expiry mid-PUT: 401/403 aborts before or during; the write either didn't happen (retry) or did (next GET shows it). Reauth, re-verify principal fingerprint, re-run -- the merge makes re-running safe.
- Optimistic concurrency: send the `updated_at` seen in step 2 as a precondition **if** the spike's open question (does the server honor it?) resolves yes; until then the merge-before-PUT is the guard.

## 7. Surfaces

### SDK (`packages/core`)

Two confirmed endpoints -> two client methods. `ENDPOINTS.memory(orgId)` = `/api/organizations/<org>/memory`, `ENDPOINTS.memoryControls(orgId)` = `.../memory/controls`; both take a `project_uuid` query param.

```ts
// getProjectMemory always passes ?project_uuid; controls IS the edits list.
getProjectMemory(orgId, projectId): Promise<{ memory: string; controls: string[]; updatedAt: string | null }>
// The one write. Whole-array replace; ~57 s; caller must use a long timeout.
putProjectMemoryControls(orgId, projectId, controls: string[], opts?: { timeoutMs?: number }): Promise<void>
```

No memory-doc write method (GET-only). No per-edit or regenerate methods (they don't exist). Sync layer separates planning from applying: `planProjectMemorySync` (GET + three-way merge -> a plan with the merged array + a "no-op" flag, hashes only, no content) / `applyProjectMemorySync` (the PUT + re-GET + materialize) / `syncProjectMemory`. The write goes through the existing Node-24 client and shared limiter with an explicit >=90 s timeout (no curl fallback, no generic auto-retry).

### MCP server (stays stdio-only)

- Read tool, always on: `get_project_memory` (returns doc + controls).
- Write tool registered **only** when launched with `CLAUDESYNC_MCP_WRITE_SCOPE=project-memory` (scoped -- not a general write switch): `put_project_memory_controls`. One tool, because there is one write.
- The write tool requires the project UUID as an explicit confirmation field and the `updated_at` seen in a prior read (stale-read guard: reject if remote advanced). It performs the merge-before-PUT internally so an MCP client cannot blind-clobber. Response returns before/after hashes and `updated_at`, never echoed content. It warns the call takes ~1 minute.
- Filesystem sync is not exposed as an MCP tool (MCP clients must not pick host output paths).

### CLI

```
claudesync projects memory show|pull|status|push <project-id> [--output <dir>]
claudesync projects memory edits list|clear <project-id>
```

`push` and `edits clear` print the merge plan (adds/deletes count, content-free) and default to dry-run; remote mutation needs `--apply` and warns "~1 minute"; `edits clear --apply` additionally needs `--confirm-project <project-id>`. No `regenerate` subcommand -- `push` (re-PUTting current controls) is the only way to force regeneration, and it says so. `status` reports clean / pending adds / pending deletes / conflict (both sides changed), content-free.

## 8. Privacy controls (required, not optional)

Memory is the most sensitive data ClaudeSync touches (legal names, medical, employment detail).

- Broad export opt-in (section 5); warn when the target is a git repo, and again if it has configured remotes (history retains deleted memory).
- `memory/` dirs created owner-only; files `0600` where supported.
- Memory/instruction content never appears in progress output, errors, journals, changelogs, debug logs, telemetry, or crash reports; never sent to another model for diffing.
- Fixtures synthetic only; spike captures redacted before commit.
- Principal mismatch fails closed. Existing cookie hygiene (clear `CLAUDE_AI_COOKIE` after read) unchanged.
  - **Phase 1 limitation:** the principal fingerprint is currently derived from the **organization id**, not a per-user account id (the SDK's `AuthProvider` exposes only `getOrganizationId()`). For a single-member org this is 1:1 with the user, but two members of the same org would share a fingerprint, so the guard does not distinguish users within an org. Phase 2 upgrade: add a `getAccount()` client method over the existing `/api/account` endpoint and key the fingerprint on the account uuid.

## 9. Phasing

- **P0 -- Spike**: DONE (2026-07-13). `docs/spike-results/memory-findings.md`.
- **P1 -- Pull**: `getProjectMemory` + Zod schema, local layout (`MEMORY.md` + `edits.md`) + sidecar, hash merge, `memory pull`/`status`/`show`, read-only MCP tool, `--include-memory` export, changelog/git integration. Tests: nightly churn, no-op pulls, principal mismatch, dirty-local abort, crash recovery. Ships value alone (read-only archive of memory).
- **P2 -- Push**: `putProjectMemoryControls` (>=90 s timeout), three-way controls merge, merge-before-PUT, `edits clear`, journal integration, dry-run/`--apply`, gated MCP write tool. Tests: merge correctness (all six merge rows), never-blind-PUT, crash between PUT-200 and sidecar-write replays as no-op, cookie-expiry re-run safety, empty-project no-op.
- **P3 -- REMOVED**: no direct memory-doc write endpoint exists; `MEMORY.md` is permanently server-owned.

## 10. Risks

- **API churn / rollout variance**: isolate memory schemas (`.passthrough()`) so failures never break conversation/project reads; treat unavailable memory (`memory/settings` flags off, or `{memory:"",controls:null}`) as a capability result, not an empty doc.
- **~57 s synchronous write**: long timeout + user warning; never wrap in generic retry (a retry could stack two 57 s regenerations). The merge makes a manual re-run safe.
- **Blind whole-array PUT clobbering another client**: THE correctness hazard -- always GET + three-way merge before PUT (section 6). Last-writer-wins is banned.
- **Empty-project write no-op**: writes to a project with no generated memory silently don't persist (spike open question); `status`/`push` must detect `controls==null` remote and tell the user to chat first / wait for nightly generation rather than reporting success.
- **Nightly regen racing pulls/exports**: `updated_at`-guarded refetch; single lock across memory sync and whole-project export.
- **Optimistic-concurrency unproven**: server may or may not honor a stale `updated_at`; merge-before-PUT is the primary guard, the precondition is belt-and-suspenders once confirmed.
- **Git retention of sensitive data**: opt-in export + remote warnings.
