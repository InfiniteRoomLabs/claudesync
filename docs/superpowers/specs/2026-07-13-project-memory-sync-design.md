# Project Memory Sync -- Design

**Date:** 2026-07-13
**Status:** Draft, pending approval
**Method:** Two independent plans (Claude Fable 5 + Codex GPT-5 on the same inputs), reconciled, then adversarially cross-reviewed by Codex. Convergent decisions are high-confidence; divergences were argued out and are noted inline.

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
- **Push**: only the edits list, plus explicit regenerate. `MEMORY.md` text is never pushed -- nightly regen would clobber it, and no write endpoint is confirmed.
- Memory is **per-user within a project** (private "Only you" semantics), so sync state is keyed by a principal fingerprint as well as project UUID.

## 3. Phase 0 (blocking): endpoint discovery spike

Network-capture every UI operation in Claude Desktop / claude.ai: memory load, Manage modal load, edit submission, per-entry delete, clear edits, regenerate, pencil action.

Record verb, path, request/response shapes, status codes, revision/etag headers, feature flags, async-job behavior. **Redact all captured content** before saving findings to `docs/spike-results/memory-findings.md`; fixtures are synthetic only.

Exit criteria:

- Stable read schema for memory and edits (Zod, `.passthrough()`).
- Stable identifiers for deletable edits. **If edits have no stable server IDs, deletion and clear stay disabled** rather than matching destructively by text.
- Known regeneration completion signal (sync response, job ID to poll, or revision change).
- Known concurrency mechanism (etag/revision), if any.
- Whether edits apply immediately (model-mediated rewrite) or only at next regeneration.
- Direct-edit (pencil) status resolved.

## 4. Local representation

Inside the existing project export tree:

```
<project-dir>/
  knowledge/
  conversations/
  memory/
    MEMORY.md                        # rendered memory doc; server-authoritative, managed
    edits/<safe-edit-id>.md          # one active server edit instruction per file; managed
    outbox/<client-op-id>.md         # locally authored instructions awaiting push; never touched by pull
    drafts/                          # abandoned/uncertain outbox items parked here; never pushed
    .claudesync-memory-state.json    # sidecar: merge base + remote identity map
```

- **Per-edit files, not one aggregate list.** A single `edits.md` reintroduces parser/delimiter/duplicate-text/concurrent-delete ambiguity. Human ergonomics come from `claudesync projects memory edits list`, not a second serialization.
- Edit filenames use the server ID when it matches a conservative pattern, else `edit-<first-16-hex-of-sha256(id)>.md` with the real ID kept in the sidecar.
- Content canonicalization before hashing/writing: UTF-8, strip BOM, CRLF/CR -> LF, exactly one trailing newline.
- The **txn journal lives outside `memory/`** (project level, per idea-099 txn core) so it survives subtree swaps.

### Sidecar schema (memory-scoped)

`memory/.claudesync-memory-state.json`, strict Zod, `schema_version: 1`:

| Field | Purpose |
|---|---|
| `project_uuid` | Owning project. |
| `principal_fingerprint` | sha256 of the account identifier. Mismatch = hard error (fail closed); prevents one account clobbering another's private memory in a shared project dir. |
| `memory.{remote_revision, remote_updated_at, content_sha256, content_bytes}` | Merge base for `MEMORY.md`. Revision fields nullable until the spike names them. |
| `edits[]: {remote_id, local_path, position, content_sha256, created_at}` | Merge base per edit. |
| `remote_snapshot_sha256` | Hash of canonical structure (memory hash + ordered edit ids/hashes), timestamps excluded. Drives the true no-op check. |
| `last_successful_txn_id`, `last_pull_at`, `last_push_at` | Audit linkage. |

Sidecar holds hashes and metadata only -- **never memory or instruction text**. Written only after the local materialization or remote op fully succeeds. Gitignored (as are journal files); `MEMORY.md` and `edits/` are tracked in git-format exports.

## 5. Pull behavior

Order: project lock -> read/validate state -> fetch memory + edits (concurrently if separate endpoints) -> canonicalize + hash -> merge decision -> stage complete managed subtree -> atomic swap preserving `outbox/**` and `drafts/**` -> changelog entry -> git commit (if applicable) -> write sidecar -> journal commit -> unlock.

### Hash-based merge (per managed entity: B = base hash from sidecar, L = local, R = remote)

| Condition | Result |
|---|---|
| L == B and R == B | No-op |
| L == B and R != B | Pull remote |
| L != B and R == B | Local change pending; pull aborts without overwriting |
| L == R | Converged; refresh state only |
| L != B, R != B, L != R | Conflict; write nothing, report |
| No base, no local | Initial pull |
| No base, local differs from remote | Conflict; adopt neither silently |

A tracked edit file deleted locally means **delete intent**, not permission for pull to recreate it -- pull reports it and stops; the user pushes the deletion or restores the file.

### Idempotency and regen churn

- True no-op when `remote_snapshot_sha256` matches state and local managed hashes still match state. Timestamp-only changes refresh the sidecar but produce **no file write, no changelog entry, no git commit**.
- Nightly regeneration that changes content is real change: materialize once, at most one git commit per pull ("Sync project memory"). No semantic/model-based diff suppression.
- Changelog lines are content-free: "Project memory changed on claude.ai", "2 memory edit instructions added", never excerpts or instruction text.

### Integration with project export

- `assembleProjectBundle` gains optional memory input; memory rides the leading project commit under `memory/`.
- **Export default: opt-in** (`--include-memory` on `projects export` / `export-all`). Rationale: default-on would silently add highly sensitive, git-history-retained data to existing automated exports and configured remotes after an upgrade. Your-data-is-yours supports availability, not surprise disclosure. The dedicated `memory pull` command is always explicit and needs no flag.
- `writeProjectBundle` / `replaceWithPreserve` must share the same project-level lock and explicitly preserve `memory/outbox/**`, `memory/drafts/**`, and the journal; the memory sidecar is rewritten intentionally, not dropped incidentally.
- Long-export race: fetch memory at project **finalization** (after conversation fan-out), refetch immediately before materialization; if revision changed, retry the snapshot once or mark the export stale. Never write an hours-old memory snapshot over a newer local pull.

## 6. Push behavior

### Pushable operations (Phase 2)

1. **Submit** new instructions from `memory/outbox/*.md`.
2. **Delete** an active edit by removing its `memory/edits/*.md` file.
3. **Clear edits** -- standalone explicit command, never combined with other ops.
4. **Regenerate** -- standalone explicit command, runs after any requested edit mutations, never automatic.

Not pushable: direct `MEMORY.md` edits (conflict-reported, see merge table); in-place edits to a tracked `edits/<id>.md` (conflict -- the supported replacement flow is: add replacement to outbox, delete old tracked file, push); **automatic synthesis of edit instructions from a local MEMORY.md diff is permanently rejected** -- there is no faithful mapping from a markdown diff to a model-interpreted instruction across nightly rewrites. The safe assist: `memory status` detects local drift and prompts the user to author an outbox instruction themselves.

### Preflight (every push)

Refetch current remote memory + edits -- the sidecar is a merge base, never trusted as current remote state. Then: verify principal fingerprint -> detect outbox additions, tracked-file deletions, unsupported modifications -> compare each touched entity to base -> emit a deterministic plan. **Any conflicted touched entity = zero remote calls.** Untouched remote changes do not block commuting outbox additions.

### Op ordering and semantics

1. Create outbox instructions (sorted by client op ID) -- additions before deletions so a replace flow never leaves a coverage gap.
2. Refetch; resolve server IDs; atomically move each outbox file to its `edits/<id>.md` path.
3. Compare-and-delete removed edits (sorted by remote ID): remote absent = no-op success; remote hash == base = delete; remote hash != base = conflict.
4. Final refetch -> materialize converged tree -> git commit -> sidecar write last.

### Atomicity, idempotency, audit (idea 099)

- Envelope per op: `lock -> recover -> plan/hash -> journal begin -> apply -> verify/refetch -> local commit -> state write -> journal commit`.
- Journal op kinds: `project-memory-pull`, `memory-edit-create`, `memory-edit-delete`, `memory-edits-clear`, `project-memory-regenerate`. Records carry IDs, hashes, status codes, error classes -- **never content**.
- A multi-op push is a **resumable saga**, not a transaction: each remote mutation commits individually; on failure, stop before later ops; **never compensate by deleting a successfully created instruction** (that destroys real user intent); next run refetches and resumes from verified outcomes.
- Client txn ID: `sha256(project_uuid + principal_fingerprint + op_kind + target_id + content_hash)`; used as an API idempotency key if the endpoint accepts one. Without server idempotency: preflight for an attributable existing entry, submit once, on timeout refetch before retry; exactly one new match = committed; none = retry; multiple indistinguishable matches = mark txn `uncertain` and stop (identical instructions may be intentional -- content equality never silently collapses entries).
- Cookie expiry mid-saga: 401/403 stops the saga, marks the in-flight op uncertain; reauth, re-verify principal fingerprint, refetch, reconcile. No rollback of remote successes.

### Uncertain-transaction reconciliation

```
memory status                          # reports uncertain txns + candidate remote edit IDs (no content)
memory reconcile <txn> --adopt <id>    # bind one candidate, complete locally
memory reconcile <txn> --retry        # only allowed when refetch finds no candidate
memory reconcile <txn> --abandon      # park the outbox item in drafts/ (non-pushable)
```

Multiple candidates always require explicit `--adopt`; ClaudeSync never guesses.

## 7. Surfaces

### SDK (`packages/core`)

Endpoints added to `ENDPOINTS` only after the spike confirms real paths. Client methods:

```ts
getProjectMemory(orgId, projectId): Promise<ProjectMemorySnapshot>
listProjectMemoryEdits(orgId, projectId): Promise<ProjectMemoryEdit[]>
createProjectMemoryEdit(orgId, projectId, instruction, { idempotencyKey? })
deleteProjectMemoryEdit(orgId, projectId, editId, { expectedRevision? })
clearProjectMemoryEdits(orgId, projectId, { expectedSnapshotRevision? })
regenerateProjectMemory(orgId, projectId): Promise<{ jobId, revision }>
```

No `replaceProjectMemory` unless the spike proves a direct-edit endpoint with a safe conditional-write mechanism. Sync layer separates planning from applying: `planProjectMemorySync` / `applyProjectMemorySync` / `syncProjectMemory`; serialized plans carry ops, IDs, hashes, conflicts -- no content. All mutations go through the existing Node-24 client and shared limiter (no curl fallback, no generic auto-retry).

### MCP server (stays stdio-only)

- Read tools, always on: `get_project_memory`, `list_project_memory_edits`.
- Write tools registered **only** when launched with `CLAUDESYNC_MCP_WRITE_SCOPE=project-memory` (scoped -- not a general write switch): `submit_project_memory_edit`, `delete_project_memory_edit`, `clear_project_memory_edits`, `regenerate_project_memory`.
- Destructive tools require the project UUID as an explicit confirmation field; delete requires expected revision/content hash from a prior read; clear requires the expected snapshot hash. Write responses return IDs/hashes/outcomes, never echoed content.
- Filesystem sync is not exposed as an MCP tool (MCP clients must not pick host output paths).

### CLI

```
claudesync projects memory show|pull|status|push|regenerate <project-id> [--output <dir>]
claudesync projects memory edits list|clear <project-id>
claudesync projects memory reconcile <txn> --adopt <id>|--retry|--abandon
```

`push`, `regenerate`, `edits clear` print a plan and default to dry-run; remote mutation needs `--apply`; `edits clear --apply` additionally needs `--confirm-project <project-id>`. `status` reports clean / pending adds / pending deletes / unsupported modifications / conflicts / uncertain txns, content-free.

## 8. Privacy controls (required, not optional)

Memory is the most sensitive data ClaudeSync touches (legal names, medical, employment detail).

- Broad export opt-in (section 5); warn when the target is a git repo, and again if it has configured remotes (history retains deleted memory).
- `memory/` dirs created owner-only; files `0600` where supported.
- Memory/instruction content never appears in progress output, errors, journals, changelogs, debug logs, telemetry, or crash reports; never sent to another model for diffing.
- Fixtures synthetic only; spike captures redacted before commit.
- Principal mismatch fails closed. Existing cookie hygiene (clear `CLAUDE_AI_COOKIE` after read) unchanged.

## 9. Phasing

- **P0 -- Spike**: capture + document endpoints, schemas, IDs, concurrency, regen signal. Blocking.
- **P1 -- Pull**: schemas, SDK reads, local layout + sidecar, hash merge, `memory pull`/`status`/`show`, read-only MCP tools, `--include-memory` export, changelog/git integration. Tests: nightly churn, no-op pulls, principal mismatch, dirty-local abort, crash recovery.
- **P2 -- Push**: outbox submission, compare-and-delete, clear + regenerate, journal integration, uncertain-txn reconcile flow, dry-run/`--apply`, gated MCP writes. Fault-injection tests at every remote/local boundary.
- **P3 -- Direct memory replacement**: only if the spike proves a supported endpoint, defined interaction with nightly regen, and a revision/etag conditional-write mechanism. Otherwise `MEMORY.md` stays remote-owned permanently.

## 10. Risks

- **API churn / rollout variance**: isolate memory schemas so failures never break conversation/project reads; treat unavailable memory as a capability result, not an empty doc.
- **No stable edit IDs**: ship pull-only; keep destructive ops disabled.
- **No server idempotency**: ambiguous creates/regens resolved via refetch + reconcile flow; may remain uncertain.
- **Nightly regen racing pulls/exports**: refetch-before-materialize; single lock across memory sync and whole-project export.
- **Cross-client conflicts**: base/hash preconditions everywhere; last-writer-wins is banned.
- **Git retention of sensitive data**: opt-in export + remote warnings.
