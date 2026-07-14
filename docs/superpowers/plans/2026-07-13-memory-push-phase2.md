# Project Memory Sync -- Phase 2 (Push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a project's edit list to claude.ai: reconcile the local `edits.md` against the live remote `controls` via a three-way merge, then apply it with the single confirmed write (`PUT .../memory/controls`, ~57 s synchronous), materialize the regenerated result, and expose it through the SDK, CLI (`projects memory push`, `edits clear`), and a gated MCP write tool. Writing edits is the ONLY mutation the API offers; the memory doc stays GET-only.

**Architecture:** Push is one atomic server mutation, so there is no saga and no journal. The flow is always `acquire project lock -> GET remote -> three-way merge (base/local/remote) -> if changed, PUT merged -> GET + verify -> materialize -> release`. A pure `mergeProjectMemoryControls` holds the reconciliation policy; a shared `materialize.ts` (extracted from the Phase 1 pull engine) is the only writer of `MEMORY.md`/`edits.md`/sidecar; `push.ts` splits plan (pure) from apply (does the PUT). The principal fingerprint is upgraded from org id to account uuid (writes are the dangerous direction), with a safe, explicit legacy-sidecar migration.

**Tech Stack:** TypeScript (strict, ESM, NodeNext -- relative imports end in `.js`), Node 24, Vitest, Zod, `node:crypto`, `node:fs`, commander (CLI), `@modelcontextprotocol/sdk` (MCP).

## Global Constraints

- **Node 24 on PATH via mise shims** -- call `node`/`pnpm` directly; do NOT run `nvm use`.
- **pnpm only.** One core test file: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/memory/<name>.test.ts`.
- **ESM + NodeNext:** every relative import ends in `.js`. Strict TS, no `any`.
- **Tests in `packages/core/test/**/*.test.ts`**, import via the `@core` alias. Vitest globals NOT enabled -- import `{ describe, it, expect, vi }` from `vitest`. **No unit test may sleep for the real ~57 s write** -- stub `global.fetch` / inject a fake client.
- **Full TSDoc (MANDATORY):** every declaration AND member gets `/** */`; no `{type}` annotations, no `@property`/`@interface`; use `@param name - desc`, `@returns`, `@throws`, `{@link}`. Pass this into subagent prompts.
- **ASCII only.** No hard-wrapped markdown prose.
- **Privacy (HARD):** memory text and edit-instruction text NEVER appear in plans, CLI/MCP output, logs, errors, the sidecar, changelogs, or fixtures. Only hashes/counts. Fixtures synthetic only.
- **Ground truth:** `docs/spike-results/memory-findings.md`. Design: `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md` section 6.
- **API facts (do not re-derive):** ONE write -- `PUT /api/organizations/<org>/memory/controls?project_uuid=<project>` body `{controls: string[]}`, whole-array replace, ~57 s synchronous, returns `200` with body `null`, regenerates the memory doc inline. No per-edit ops, no standalone regenerate. A PUT to a project with `controls === null` (never-generated memory) silently no-ops. `updated_at` is the only version signal; the server is NOT confirmed to enforce it as a precondition.
- **Phase 1 already built (reuse, do not reimplement):** `getProjectMemory`, `hashContent`, `canonicalize`/`serializeEdits`/`parseEdits`, the `MemoryState` sidecar (`controls_base` = ordered per-entry hashes, `memory_content_sha256`, `remote_snapshot_sha256`, `remote_updated_at`, `principal_fingerprint`, `last_pull_at`), `pullProjectMemory`, `computePrincipalFingerprint`, `snapshotHash`.
- **No txn core:** the idea-099 WAL module does NOT exist and is NOT built here (a single atomic PUT does not need it -- see Task 6 crash analysis).
- **Branch:** work on `feat/memory-push` (not `main`), so per-commit changelog-guard does not gate each TDD commit; CHANGELOG entry added once in the final task. Create it before Task 1: `git checkout -b feat/memory-push`.
- **Commit hooks:** `git add` and `git commit` are SEPARATE Bash calls (a hook blocks combined add+commit and `-a`/`-am`).

## Decisions locked by the dual-plan + cross-review (Claude + Codex)

- **No journal.** One atomic PUT; local writes are state-last; a crash is reconciled by the next push's opening GET. (Both planners agreed.)
- **Never blind-PUT.** Every write path GETs the live remote and three-way merges before PUT, so a concurrent remote addition is preserved, not clobbered. This does NOT fully close the GET->PUT race (no server CAS); documented as a residual limitation.
- **Post-PUT verification is a hybrid (Codex override adopted):** after the PUT, GET again. Always materialize the returned `MEMORY.md` (server-authoritative). If the returned `controls` do NOT match the intended merged array, do NOT overwrite `edits.md` and do NOT advance `controls_base` -- emit a content-free warning and exit nonzero, so the next push re-merges the still-pending local intent. Never silently convert a dropped local add into an accepted deletion.
- **Account-uuid principal (Codex Task 3 adopted, with safe migration):** wire `getAccount()` and key the fingerprint on the account uuid, because push is the write direction and the org-scoped fingerprint does not distinguish users in a multi-member org (this is community/MIT software; multi-user IS a real user). Legacy org-keyed sidecars are migrated ONLY via an explicit `--adopt-legacy-principal` (+ `--confirm-project`) that rewrites the fingerprint in place, preserving `edits.md` and `controls_base`. Never automatic; never via `pull --force` (which would eat pending edits).
- **Per-project lock (Codex override adopted):** a minimal cross-process advisory lock guards the whole push envelope. The ~57 s blocking PUT makes "user re-runs a push that looks stuck" a realistic self-race with a huge window; the lock removes ClaudeSync racing itself (it does not solve external-client races).
- **Deferred to a Phase 1.5 follow-up (not built here):** the core `status.ts` rewrite (rich remote-vs-local status) -- push computes its own authoritative plan; rich status is UX, not push-correctness.

## File Structure

- `packages/core/src/client/endpoints.ts` -- add `memoryControls(orgId, projectId)`; add `encodeURIComponent` to the existing `memory` builder (MODIFY).
- `packages/core/src/client/client.ts` -- extract private `requestResponse`; add `putProjectMemoryControls` + `getAccount` (MODIFY).
- `packages/core/src/models/schemas.ts` / `types.ts` -- add `AccountSchema`/`Account` (MODIFY).
- `packages/core/src/memory/merge.ts` -- pure three-way merge (CREATE).
- `packages/core/src/memory/materialize.ts` -- shared atomic writer extracted from pull (CREATE).
- `packages/core/src/memory/pull.ts` -- refactor to call the shared materializer (MODIFY).
- `packages/core/src/memory/state.ts` -- add optional `last_push_at` (MODIFY).
- `packages/core/src/memory/lock.ts` -- minimal per-project advisory lock (CREATE).
- `packages/core/src/memory/push.ts` -- `planProjectMemoryPush` + `applyProjectMemoryPush` (CREATE).
- `packages/core/src/index.ts` -- export the new public surface (MODIFY).
- `packages/cli/src/commands/projects.ts` -- `memory push`, `edits clear`, `--adopt-legacy-principal` (MODIFY).
- `packages/mcp-server/src/server.ts` -- gated `put_project_memory_controls`; `createServer` gains injectable options (MODIFY).
- `CHANGELOG.md`, design spec -- final task (MODIFY).

---

### Task 1: SDK write path -- `requestResponse` refactor + `putProjectMemoryControls`

**Files:**
- Modify: `packages/core/src/client/endpoints.ts`, `packages/core/src/client/client.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/client/put-controls.test.ts`

**Interfaces:**
- Produces:
  - `ENDPOINTS.memoryControls(orgId, projectId): string` -> `/api/organizations/<org>/memory/controls?project_uuid=<encoded project>`; also `encodeURIComponent` the `project_uuid` in the existing `ENDPOINTS.memory`.
  - Private `requestResponse(url: string, init?: RequestInit): Promise<Response>` owning limiter + auth-headers + 429/non-2xx mapping + success notify; `request()` and `requestRaw()` refactored to call it (behavior unchanged).
  - `PutProjectMemoryControlsOptions = { timeoutMs?: number }`
  - `putProjectMemoryControls(orgId, projectId, controls: string[], options?): Promise<void>` -- PUT, `content-type: application/json`, body `{controls}`, `signal: AbortSignal.timeout(timeoutMs ?? 90_000)`, one limiter slot, accepts 200/null, NO automatic retry (429/timeout/5xx/401/403 all surface). On abort/timeout throw an error whose message states the write may have applied server-side and MUST NOT be auto-retried; reconcile by re-running push. Reject non-finite/non-positive `timeoutMs` before fetching.

- [ ] **Step 1: Write the failing test** (`test/client/put-controls.test.ts`, stubbing `global.fetch` via `vi.stubGlobal`). Cases: PUT hits the right URL with encoded `project_uuid`; body is `{"controls":[...]}` with JSON content-type; a 200/`null` body resolves `void`; a 429 maps to `RateLimitError` and fetch is called exactly once (no retry); a 500 maps to `ClaudeSyncError` once; a timeout (make the stub reject with an `AbortError`) throws the ambiguous-write error; the default abort timeout is 90000 ms (assert via a captured `init.signal`), and a custom `timeoutMs` is honored; a GET via the existing `request()` still works after the refactor.
- [ ] **Step 2: Run it, expect FAIL** (`putProjectMemoryControls`/`memoryControls` missing).
- [ ] **Step 3: Implement** the endpoint builder, the `requestResponse` extraction (move the limiter/auth/429/error logic out of `request`; have `request` parse JSON and `requestRaw` return the Response), and `putProjectMemoryControls`. Full TSDoc.
- [ ] **Step 4: Run the test + full core suite + `tsc --noEmit`, expect PASS.** Export `putProjectMemoryControls`-related types from `index.ts` if any are public.
- [ ] **Step 5: Commit.** `git add <files>` then `git commit -m "feat(core): putProjectMemoryControls write path (90s timeout, no retry)"`.

---

### Task 2: Account-uuid principal -- `getAccount()` + schema

**Files:**
- Modify: `packages/core/src/client/client.ts`, `packages/core/src/models/schemas.ts`, `packages/core/src/models/types.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/models/account-schema.test.ts`, cases added to a client test

**Interfaces:**
- Produces:
  - `AccountSchema` (Zod, `.passthrough()`) with at least `{ uuid: string }` (the account uuid observed at `/api/account`; other fields optional/passthrough), `Account` type.
  - `ClaudeSyncClient.getAccount(): Promise<Account>` -- GET `ENDPOINTS.account` (the constant already exists), validate with `AccountSchema`.
- Note: `computePrincipalFingerprint` is unchanged (it hashes whatever string it is handed); the CALLER now passes the account uuid instead of the org id.

- [ ] **Step 1: Failing schema test** -- `AccountSchema` parses `{ uuid: "acct-uuid", email_address: "x", ... }` and passes through unknown fields; requires `uuid`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `AccountSchema`/`Account`, `getAccount()`, exports. Full TSDoc. (Do NOT change any fingerprint logic here; wiring the CLI/MCP to use the account uuid happens in Tasks 8-9, and the legacy migration in Task 8.)
- [ ] **Step 4: Run schema test + client test + `tsc`, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): getAccount SDK read for per-user principal`.

---

### Task 3: Pure three-way controls merge

**Files:**
- Create: `packages/core/src/memory/merge.ts`, `packages/core/test/memory/merge.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `ControlsMergeResult = { controls: string[]; localAdds: number; localDeletes: number; remoteAdds: number; remoteDeletes: number; deduplicated: number }`
  - `mergeProjectMemoryControls(baseHashes: readonly string[], local: readonly string[], remote: readonly string[]): ControlsMergeResult`
  - `assertNoDelimiterEntries(controls: readonly string[]): void` -- throws if any entry contains a line exactly equal to `---` (cannot round-trip `edits.md`); called by the planner before merging local input.

**Algorithm (normalize every input with `parseEdits(serializeEdits(x))` then dedupe by exact string, first occurrence; base membership = `hashContent(normalizedEntry)` in `baseHashes`):**
```
result = [], seen = Set()
LHashes = { hash(e) : e in L }
for e in R:                         # remote order is authoritative for survivors
  h = hash(e)
  if h in B and h not in LHashes: continue   # local deleted a base entry -> delete wins
  if e not in seen: result.push(e); seen.add(e)
for e in L:
  h = hash(e)
  if h in B: continue               # base entry absent from R -> remote deleted it -> delete wins
  if e not in seen: result.push(e); seen.add(e)   # local add, appended after remote survivors
return result
```
Yields: kept-by-both -> remote position; local delete -> gone; remote delete -> gone; local add -> appended in local order; remote add -> remote position; same text both sides -> one entry; both delete -> gone; reorder-only -> remote order wins for base entries. Counts are for content-free plans only.

- [ ] **Step 1: Failing test** with cases: both-unchanged; local add; local delete; remote add; remote delete; both-add-same-text (collapses to one); both-delete; local modification (= delete old + add new); remote order retained; local adds appended in local order; duplicate entries collapse (with `deduplicated` count); whitespace/newline normalization equivalence; empty arrays; remote add survives an unrelated local clear (`local = []`, remote has a new entry not in base -> merged keeps it); deterministic on repeat; `assertNoDelimiterEntries` throws on an entry containing a `---` line.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `merge.ts`. Full TSDoc on the result type members and both functions. Export from `index.ts`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): three-way controls merge`.

---

### Task 4: Extract shared materializer; add `last_push_at`

**Files:**
- Create: `packages/core/src/memory/materialize.ts`, `packages/core/test/memory/materialize.test.ts`
- Modify: `packages/core/src/memory/pull.ts`, `packages/core/src/memory/state.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `materializeProjectMemorySnapshot(opts: { remote: ProjectMemory & { controls: string[] }; prior: MemoryState | undefined; accountId: string; projectId: string; dir: string; now: string; source: "pull" | "push" }): { memoryChanged: boolean; controlsCount: number }` -- the ONLY writer: canonicalize memory, compute hashes (memory + normalized per-entry control hashes), create `dir` owner-only (`mkdir mode 0o700` + `chmodSync 0o700`), atomically write `MEMORY.md` and `edits.md` with UNIQUE temp suffixes (e.g. `<file>.<random-hex>.tmp` via `randomBytes`) + rename + mode `0o600`, then write the sidecar LAST via `writeMemoryState`. `source: "push"` stamps `last_push_at: now` (and preserves the existing `last_pull_at`); `source: "pull"` stamps `last_pull_at` (and preserves any `last_push_at`).
- Modifies:
  - `MemoryStateSchema`: add `last_push_at: z.string().optional()` and make `last_pull_at` optional (both back-compat -- existing sidecars parse; `schema_version` stays `1`).
  - `pull.ts`: replace its inline write block with a call to `materializeProjectMemorySnapshot({ ..., source: "pull" })`. Pull's decision logic (no-memory / unchanged / conflict / initial-pre-existing) is UNCHANGED -- only the write is delegated.

- [ ] **Step 1: Failing test** for the materializer: writes all three files; dir is `0700`, files `0600` (assert `statSync().mode & 0o777`); `edits.md` round-trips through `parseEdits`; sidecar holds only hashes; `source:"push"` sets `last_push_at` and keeps `last_pull_at`; temp files are cleaned (no `.tmp` left); memoryChanged is correct vs prior.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `materialize.ts`; refactor `pull.ts` to use it; extend the schema. Full TSDoc.
- [ ] **Step 4: Run the materializer test AND the existing `pull.test.ts` (all 13 must still pass) + full suite + `tsc`, expect PASS.** Export the materializer from `index.ts` only if push needs it cross-module (it is same-package, so a direct import in push.ts is fine; export only if a consumer outside core needs it -- it does not, so keep it internal / no index export).
- [ ] **Step 5: Commit** `feat(core): extract shared memory materializer; add last_push_at`.

---

### Task 5: Minimal per-project advisory lock

**Files:**
- Create: `packages/core/src/memory/lock.ts`, `packages/core/test/memory/lock.test.ts`

**Interfaces:**
- Produces:
  - `withProjectMemoryLock<T>(dir: string, fn: () => Promise<T>): Promise<T>` -- acquires an exclusive advisory lock on `<dir>/.claudesync-memory.lock` via `fs.openSync(path, "wx")` (atomic create-exclusive; write the pid + `now`), runs `fn`, releases (unlink) in a `finally`. If the lock exists, throw a clear error naming the lockfile and that another push is in progress (include the recorded pid/time). Provide a stale-lock escape: if the lockfile's recorded timestamp is older than a generous TTL (e.g. 10 min -- longer than the ~57 s write plus slack) treat it as stale and take it over. Accept `now` and TTL as injectable params for tests (no wall-clock/`Date.now()` coupling in the core logic path used by tests).

- [ ] **Step 1: Failing test:** acquire runs fn and releases (lockfile gone after); a second concurrent acquire while held throws; a stale lockfile (old timestamp) is taken over; fn throwing still releases the lock.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `lock.ts` with `openSync(..., "wx")`. Full TSDoc. Keep it tiny -- this is an advisory lock, NOT a transaction framework.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): per-project memory advisory lock`.

---

### Task 6: Push planner + apply engine

**Files:**
- Create: `packages/core/src/memory/push.ts`, `packages/core/test/memory/push-plan.test.ts`, `packages/core/test/memory/push-apply.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
  - `PlanProjectMemoryPushOptions = { remote: ProjectMemory; accountId: string; projectId: string; dir: string; localControlsOverride?: string[] }`
  - `ProjectMemoryPushPlan = { projectId: string; action: "put" | "no-op" | "no-memory"; mergedControls: string[]; remoteControls: string[]; remoteUpdatedAt: string | null; localAdds: number; localDeletes: number; remoteAdds: number; remoteDeletes: number }` (callers render counts only, NEVER `mergedControls`/`remoteControls`).
  - `planProjectMemoryPush(opts): ProjectMemoryPushPlan` -- pure (no network/writes): read+validate sidecar (throw if absent: "run `projects memory pull` first"); throw if `state.project_uuid !== projectId`; verify `state.principal_fingerprint === computePrincipalFingerprint(accountId)` else throw a principal-mismatch error whose message names `--adopt-legacy-principal` as the migration path; read `edits.md` (missing file is an error, NOT an implicit clear) unless `localControlsOverride` is supplied; if `remote.controls === null` -> `action: "no-memory"`; else `assertNoDelimiterEntries(local)`, `mergeProjectMemoryControls(state.controls_base, local, remote.controls)`; if merged (normalized) deep-equals remote (normalized) -> `no-op`; else `put`.
  - `ApplyProjectMemoryPushOptions = { client: Pick<ClaudeSyncClient,"getProjectMemory"|"putProjectMemoryControls">; orgId: string; accountId: string; projectId: string; dir: string; now: string; localControlsOverride?: string[]; timeoutMs?: number }`
  - `ProjectMemoryPushOutcome = { action: "written" | "unchanged" | "no-memory" | "verify-mismatch"; controlsCount: number; memoryChanged: boolean; remoteUpdatedAt: string | null }`
  - `applyProjectMemoryPush(opts): Promise<ProjectMemoryPushOutcome>` -- wraps the whole body in `withProjectMemoryLock(dir, ...)`:
    1. GET current memory (fresh -- never trust the sidecar as current remote).
    2. `planProjectMemoryPush` against it.
    3. `no-memory` -> return (no PUT).
    4. `no-op` -> materialize the current remote (converge files/sidecar) via `materializeProjectMemorySnapshot(source:"push")`, return `unchanged`.
    5. `put` -> `putProjectMemoryControls(orgId, projectId, plan.mergedControls, {timeoutMs})`.
    6. GET again. If returned `controls === null` -> throw (server lost the write). Normalize returned controls; if they deep-equal `plan.mergedControls` -> materialize (source `push`) -> `written`.
    7. **Verify-mismatch (hybrid):** returned controls differ from intended -> materialize ONLY `MEMORY.md` from the returned snapshot, do NOT overwrite `edits.md`, do NOT advance `controls_base` (leave the sidecar's edit base as-is), emit a content-free warning, return `verify-mismatch`. (Implement by a materializer flag or a dedicated small writer that writes MEMORY.md + updates only `memory_content_sha256`/`remote_updated_at` in the sidecar, leaving `controls_base` untouched.)

- [ ] **Step 1: Failing planner test** (`push-plan.test.ts`): missing sidecar throws; missing `edits.md` throws (not a clear); wrong project uuid throws; principal mismatch throws and the message mentions `--adopt-legacy-principal`; `controls===null` -> `no-memory`; merged==remote -> `no-op`; local adds + a concurrent remote add -> `put` with the remote add preserved in `mergedControls` and correct counts; a `---`-containing local entry throws.
- [ ] **Step 2: Failing apply test** (`push-apply.test.ts`) with a FAKE client (implements only `getProjectMemory` + `putProjectMemoryControls`, records calls): GET precedes every PUT; PUT called exactly once; PUT receives the normalized merged array including a remote add; `no-op` skips PUT but converges local files; `no-memory` skips PUT; success materializes regenerated memory + controls + advances sidecar (incl. `last_push_at`); a timeout (fake PUT throws AbortError) does NOT retry and surfaces the ambiguous error; verify-mismatch (fake post-PUT GET returns different controls) writes `MEMORY.md`, leaves `edits.md` and `controls_base` unchanged, returns `verify-mismatch` (nonzero-worthy); simulated "crash after PUT" (re-run apply against a remote that already equals merged) becomes `unchanged`; lock is held across the body and released after (assert lockfile gone).
- [ ] **Step 3: Run both, expect FAIL.**
- [ ] **Step 4: Implement** `push.ts`. Full TSDoc. Export the plan/apply functions + their public types from `index.ts`.
- [ ] **Step 5: Run both test files + full suite + `tsc`, expect PASS.**
- [ ] **Step 6: Commit** `feat(core): memory push planner + apply engine (merge-before-PUT, hybrid verify, locked)`.

---

### Task 7: CLI -- `projects memory push`, `edits clear`, `--adopt-legacy-principal`

**Files:**
- Modify: `packages/cli/src/commands/projects.ts`
- Test: manual smoke (thin shell; core logic unit-tested).

**Semantics:**
- `projects memory push <project-id> [--org] [--output <dir>] [--apply] [--timeout <seconds>]`: resolve org; resolve `accountId = (await client.getAccount()).uuid`; ALWAYS GET + compute a real plan. Default DRY-RUN: print content-free counts (`Plan: add N, delete M, N remote addition(s) preserved. Nothing sent -- re-run with --apply.`). `--apply`: print `Updating project memory. claude.ai takes about 1 minute to regenerate it.`, then `applyProjectMemoryPush`; on a TTY show an elapsed timer (no spinner escape codes on non-TTY). Print outcome: `written` (with `controlsCount`), `unchanged` (`Already synchronized; nothing to push.`), `no-memory` (hint: chat + wait for nightly generation, then pull), `verify-mismatch` (warn: server did not persist the intended edits; MEMORY.md updated, local edits preserved, re-run push) and EXIT NONZERO. On the ambiguous-timeout error: print that the write may have applied and to re-run push (do NOT retry). Never print controls/memory text.
- `projects memory edits clear <project-id> [--org] [--output <dir>] [--apply] --confirm-project <project-id>`: uses `localControlsOverride: []`; dry-run touches nothing and sends no PUT; `--apply` requires `--confirm-project` to exactly equal the positional id; a concurrent remote addition still survives the merge (clear is remove-wins for base entries only). No `--force-clear` in this phase.
- `projects memory push <project-id> --adopt-legacy-principal --confirm-project <project-id>`: the ONLY migration path for a Phase-1 (org-keyed) sidecar. If the sidecar's `principal_fingerprint === computePrincipalFingerprint(orgId)` and `state.project_uuid === projectId` and the confirm matches, atomically rewrite ONLY the fingerprint to `computePrincipalFingerprint(accountId)`, preserving `edits.md`, `controls_base`, and all other fields; then proceed with the normal (dry-run or --apply) push. Never overwrite `edits.md`. Print what it migrated (content-free).

- [ ] **Step 1: Implement** the three behaviors. Add a small module-level helper for the legacy-principal rewrite (full TSDoc) that reads the sidecar, checks the org-fingerprint precondition, and `writeMemoryState`s the fingerprint-only change. Reuse `createClient`/`resolveOrgId`/`outputJson`.
- [ ] **Step 2: `pnpm build`, expect clean.**
- [ ] **Step 3: Manual smoke (controller-run, not a subagent -- needs the live cookie).** Dry-run push against a real already-pulled project prints counts and sends nothing. NOTE: a live `--apply` costs a real ~57 s regeneration and mutates real memory -- the controller decides whether to run it against the throwaway project (which must first have generated memory) or to rely on the unit-tested apply engine. Do NOT auto-run `--apply` against a real personal project without explicit user say-so. Report smoke results structurally (no memory/edit text).
- [ ] **Step 4: Commit** `feat(cli): projects memory push + edits clear + legacy-principal adoption`.

---

### Task 8: Gated MCP write tool `put_project_memory_controls`

**Files:**
- Modify: `packages/mcp-server/src/server.ts`
- Test: `packages/mcp-server/test/write-tool.test.ts` (or the existing server test file)

**Interfaces:**
- `createServer(options?: { auth?: AuthProvider; client?: ClaudeSyncClient; memoryWriteEnabled?: boolean }): McpServer` -- production derives `memoryWriteEnabled` from `process.env.CLAUDESYNC_MCP_WRITE_SCOPE === "project-memory"` (exact match; not `true`/`1`/`all`); tests inject it. Read tools unchanged; server stays stdio-only.
- Registered ONLY when `memoryWriteEnabled`: `put_project_memory_controls` with inputs `{ projectId: string; confirmProjectId: string; orgId?: string; expectedUpdatedAt: string; baseControls: string[]; desiredControls: string[] }`. Handler: require `confirmProjectId === projectId`; GET current memory; refuse if `controls === null`; require `remote.updated_at === expectedUpdatedAt` (else return a stale-read error telling the client to re-read -- do NOT silently merge/write for an autonomous caller); `mergeProjectMemoryControls(baseControls-as-hashes... ` -- NOTE the merge takes base HASHES: hash `baseControls` entries to form the base, then merge `desiredControls` (local) against fresh `remote.controls`; if merged==remote -> no-op (no PUT); else PUT (90 s), GET, verify; return ONLY `{ action, before_controls_sha256, after_controls_sha256, before_updated_at, after_updated_at, controls_count }` -- never controls/memory text. Tool description states it can take ~1 minute and clients must not auto-retry after timeout.

- [ ] **Step 1: Failing test** (inject a fake client + `memoryWriteEnabled`): tool ABSENT when disabled; PRESENT only for exact scope; `confirmProjectId` mismatch refuses before any GET/PUT; `controls===null` refuses; stale `expectedUpdatedAt` refuses before PUT; a concurrent remote add is merged into the PUT; merged==remote -> no-op (no PUT); PUT called exactly once on a real change; response contains hashes/counts and NO control text.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Refactor `createServer` to accept injected options; register the gated tool. Full inline consistency with sibling tools (banner comment; no TSDoc block needed on an inline registration).
- [ ] **Step 4: Run the test + `pnpm build`, expect PASS.** Confirm `tools/list` omits the write tool without the env var and includes it with it.
- [ ] **Step 5: Commit** `feat(mcp): gated put_project_memory_controls write tool`.

---

### Task 9: Changelog, design-doc update, finish branch

**Files:**
- Modify: `CHANGELOG.md`, `docs/superpowers/specs/2026-07-13-project-memory-sync-design.md`

- [ ] **Step 1: Design-doc update.** In section 6/9, record the locked decisions: no journal (crash-safe via opening GET), hybrid post-PUT verification (materialize MEMORY.md, preserve edits.md + base on mismatch), account-uuid principal + `--adopt-legacy-principal` migration, per-project advisory lock (motivated by the ~57 s window), residual GET->PUT race (no server CAS), and that a control entry containing a `---` line is refused. Mark Phase 2 status and that the core `status.ts` rewrite remains a Phase 1.5 follow-up.
- [ ] **Step 2: CHANGELOG** `## [Unreleased]` `### Added`: project memory PUSH (Phase 2) -- content-free summary of the SDK write, merge, push engine, CLI `push`/`edits clear`, gated MCP write tool, account-uuid principal.
- [ ] **Step 3: Full gate:** `pnpm build && pnpm test` (all green) + `grep -rnP '[^\x00-\x7F]'` on the touched core/cli/mcp dirs returns nothing.
- [ ] **Step 4: Stage + commit** (separate calls) `docs: changelog + design update for project memory push (phase 2)`.
- [ ] **Step 5: Finish branch** via superpowers:finishing-a-development-branch.

---

## Self-Review Notes

- **Design section 6 coverage:** pushable = edits only (merge + PUT, Tasks 3/6); never blind-PUT (Task 6 GET-before-plan); ~57 s sync write + long timeout + no retry (Task 1); refuse empty-project (Task 6 `no-memory`); explicit-only clear (Task 7); gated MCP write (Task 8); privacy content-free throughout. The design's "resumable saga / idempotency-key / uncertain-txn reconcile" language is SUPERSEDED by the spike (one atomic PUT) -- Task 9 updates the doc to match, so plan and spec do not contradict.
- **Cross-review deltas folded in:** hybrid verify (not fail-closed-write-nothing, not blind-adopt); account principal + safe `--adopt-legacy-principal` (not "just re-pull", which `pull --force` would turn into edit loss); per-project lock kept (the ~57 s window makes the self-race real); core status.ts deferred.
- **No txn-core dependency:** materializer uses tmp+rename with unique suffixes; state written last; crash reconciled by the next push's GET (Task 6 tests the re-run-becomes-no-op case).
- **Type flow:** `ProjectMemory` (Phase 1) -> planner/apply `remote`; `ControlsMergeResult` (T3) consumed by planner (T6); `materializeProjectMemorySnapshot` (T4) is the single writer for pull (refactored) and push; `getAccount().uuid` (T2) -> `accountId` in CLI/MCP (T7/T8); `computePrincipalFingerprint` unchanged, fed the account uuid.
- **Placeholder scan:** none -- every code step names concrete files, signatures, and test cases.
- **Testability:** the ~57 s write is never slept on -- Task 1 stubs `fetch`, Task 6/8 inject fake clients. The one real-time cost (a live `--apply`) is a controller-gated manual smoke, explicitly not auto-run against real personal memory.
