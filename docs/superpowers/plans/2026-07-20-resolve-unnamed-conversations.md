# Resolve Unnamed Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive titles for unnamed conversations from their first human message (pure heuristic) and mirror them to claude.ai via a new `renameConversation` SDK write and a dry-run-by-default `conversations resolve-names` CLI command.

**Architecture:** A pure, grapheme-safe derivation helper feeds a batch CLI command. The only mutation is a spike-verified single-conversation rename (one-shot, no retry, ambiguous outcomes reconciled by re-reading). v1 deliberately does NOT derive local export paths -- local slugs keep following the remote name, so incremental sync is untouched; local naming improves as a consequence of the remote rename.

**Tech Stack:** TypeScript (strict, ESM, NodeNext -- `.js` relative imports), Node 24, Vitest (globals off, `@core` alias), Zod, commander. `Intl.Segmenter` (Node-native) for grapheme-safe truncation -- no new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-17-resolve-unnamed-conversations-design.md`.

## Global Constraints

- node/pnpm direct on PATH via mise shims; do NOT run `nvm use`.
- pnpm only. Core test run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/<path>.test.ts`.
- ESM + NodeNext: relative imports end `.js`. Strict TS, no `any`.
- Tests in `packages/core/test/**`, `@core` alias, `import { describe, it, expect, vi } from "vitest"`.
- FULL TSDoc on every declaration AND member; no `{type}`, no `@property`; `@param name - desc`, `@returns`, `@throws`, `{@link}`.
- ASCII only in source/docs. Synthetic fixtures only -- NEVER real conversation text. Non-ASCII TEST INPUT (CJK/emoji/RTL cases) is expressed via `\u` escapes, never literal bytes.
- **Privacy (HARD):** derived titles are CONTENT. They appear ONLY in the resolve-names preview table and JSON output (that is the command's function). They must NEVER appear in logs, debug output, progress errors, exception messages, or any other output path. Errors carry conversation UUID + HTTP status only.
- **Writes:** `renameConversation` is one-shot -- NO automatic retry at any layer (undocumented endpoint; rerunning the command is the resume mechanism). Rejects empty/whitespace names pre-request. NOT exposed via MCP in v1.
- Branch: `feat/resolve-unnamed-conversations` (spec committed; work here).
- `git add` and `git commit` are SEPARATE Bash calls.
- Task 1 (spike) is CONTROLLER-RUN (needs the live cookie + user-blessed target conversation `57df4700-a624-4c42-a9a5-878d9ffc2b19`); subagents never touch the live API.

---

### Task 1: Endpoint spike (CONTROLLER-RUN, live, mutating -- user-blessed target only)

**Files:**
- Create: `docs/spike-results/rename-findings.md` (structural findings only, no content)
- Modify: `docs/superpowers/specs/2026-07-17-resolve-unnamed-conversations-design.md` (record findings in the Phase 0 section)

- [ ] **Step 1: Capture.** With the Chrome extension, open claude.ai, rename conversation `57df4700-...` in the UI, and read the network request: method, exact path, headers of interest, body shape, response status/shape.
- [ ] **Step 2: Reproduce via fetch/SDK path** with the harvested cookie against the SAME conversation: same method/path/body. Verify: 2xx; name visible in list + detail GET; whether `updated_at` changed; same-value re-assignment behavior.
- [ ] **Step 3: Rollback proof.** Set `name: ""` via the same endpoint; verify the conversation returns to unnamed in list + detail. If `""` is rejected, record the actual un-naming mechanism (or that none exists) -- this changes the spec's reversibility claim and the CLI's messaging.
- [ ] **Step 4: Edge probes** (same conversation, all rolled back): a 100+ char name (record truncation/limit behavior); a name with emoji (record Unicode handling). Record the observed definition of "unnamed" from the list payload (absent vs null vs "").
- [ ] **Step 5: Write findings** to `docs/spike-results/rename-findings.md` (ASCII, structural, no conversation content; name values used are synthetic). Update the spec's Phase 0 section with the outcome. Commit both (separate add/commit): `docs: rename endpoint spike findings`.

---

### Task 2: Pure title derivation -- `deriveConversationTitle`

**Files:**
- Create: `packages/core/src/conversations/title.ts`, `packages/core/test/conversations/title.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
/** Max length of a derived title, in grapheme clusters (not code units). */
export const MAX_TITLE_GRAPHEMES = 60;

/** Derives a display title from a hydrated conversation's opening human
 * message, or null when no usable text exists (title stays unresolved --
 * never invent one). Pure and deterministic. */
export function deriveConversationTitle(
  conversation: Pick<Conversation, "chat_messages" | "current_leaf_message_uuid">
): string | null;
```

- Algorithm (spec-locked):
  1. Select the earliest human message on the ACTIVE branch: walk the parent chain from `current_leaf_message_uuid` using `buildMessageTree`/`getLinearBranch` from `packages/core/src/tree/message-tree.ts` (read its exports first); fallback when branch metadata is missing/malformed: earliest human message by array order. No human message anywhere -> null.
  2. Take at most the first 1024 CHARACTERS of the message text before any heavier processing.
  3. Sanitize: strip fenced code blocks (```...``` including unterminated openers -- drop from the fence marker on), inline backticks (keep inner text), markdown emphasis/heading/link syntax (keep link text, drop URLs), ANSI/OSC escape sequences, C0/C1 control chars, and bidi control characters (U+202A-U+202E, U+2066-U+2069). Collapse all whitespace runs to single spaces; trim.
  4. Unicode NFC normalize.
  5. If the result is empty -> null.
  6. Truncate to MAX_TITLE_GRAPHEMES grapheme clusters via `Intl.Segmenter("und", {granularity: "grapheme"})`; prefer the last word boundary (space) within the limit when one exists past grapheme 20, else hard grapheme cut. Never split a cluster/surrogate pair. Trim trailing space.

- [ ] **Step 1: Failing test corpus** (all inputs via \u escapes where non-ASCII): plain sentence (passes through); code-only opener -> null; leading fence + prose -> prose only; pasted log/URL soup -> sanitized + truncated at word boundary; >1024-char opener (only first 1KiB considered); emoji cluster at the 60-grapheme boundary (not split -- assert output length in graphemes and valid surrogates); CJK string (hard cut at 60 graphemes, no mojibake); RTL text with bidi controls (controls stripped, text kept); whitespace-only -> null; markdown-only (`**` `##` etc.) -> null; ANSI-laced text -> clean; attachment-only conversation (human message, empty text) -> null; assistant-only conversation -> null; abandoned-branch selection (active branch's first human message chosen, not the other branch's); malformed leaf uuid -> array-order fallback; determinism (same input twice -> identical output).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `title.ts` with full TSDoc (document each sanitization pass inline).
- [ ] **Step 4: Run + full core suite + `tsc --noEmit`, expect PASS.** Export `deriveConversationTitle` + `MAX_TITLE_GRAPHEMES` from `index.ts`.
- [ ] **Step 5: Commit** `feat(core): grapheme-safe conversation title derivation`.

---

### Task 3: SDK write -- `renameConversation`

**Files:**
- Modify: `packages/core/src/client/endpoints.ts`, `packages/core/src/client/client.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/client/rename-conversation.test.ts`

**Interfaces (endpoint per Task 1 findings -- the implementer reads `docs/spike-results/rename-findings.md` FIRST and uses the observed method/path/body verbatim):**
- `ENDPOINTS.renameConversation(orgId, conversationId)` (or reuse an existing conversation endpoint builder if the path matches -- check endpoints.ts).
- `renameConversation(orgId: string, conversationId: string, name: string): Promise<void>` -- one limiter slot; observed method + JSON body; accepts the observed success shape; throws on empty/whitespace-only `name` BEFORE any request (un-naming is not exposed in v1); NO retry -- 429/5xx/timeout surface unchanged (mirror `putProjectMemoryControls`'s no-retry rationale with a rename-specific TSDoc note); errors include conversationId + status, NEVER the name value.

- [ ] **Step 1: Failing test** (stub `global.fetch` via `vi.stubGlobal`, following `test/client/put-controls.test.ts` patterns): correct method/URL/body per spike findings; success resolves void; empty name and whitespace-only name throw pre-fetch (fetch not called); 429 -> RateLimitError, fetch called exactly once; 500 -> ClaudeSyncError once; error message contains the conversation id and NOT the attempted name (plant a marker string as the name, assert absence).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Full TSDoc.
- [ ] **Step 4: Run + full suite + `tsc --noEmit`, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): renameConversation SDK write (one-shot, no retry)`.

---

### Task 4: Batch planner core -- select, derive, reconcile

**Files:**
- Create: `packages/core/src/conversations/resolve-names.ts`, `packages/core/test/conversations/resolve-names.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
/** One conversation's entry in a resolve-names plan. status: "resolvable" (title derived), "unresolved" (no usable opener -- reason carries a structural cause like "no-human-message" | "empty-after-sanitize"). */
export type ResolveNameCandidate = {
  uuid: string;
  title: string | null;
  status: "resolvable" | "unresolved";
  reason?: "no-human-message" | "empty-after-sanitize";
};

/** Pure selection: which summaries count as unnamed (per the spike-recorded definition), capped/filtered by ids/limit. */
export function selectUnnamedConversations(
  summaries: readonly ConversationSummary[],
  opts?: { ids?: readonly string[]; limit?: number }
): ConversationSummary[];

/** Derives a candidate for one hydrated conversation (wraps deriveConversationTitle with status/reason). */
export function planRename(conversation: Conversation): ResolveNameCandidate;

/** Post-write reconciliation of an ambiguous transport outcome: re-read name; returns "applied" (matches desired), "concurrent-edit" (different non-empty name), or "failed" (still unnamed). */
export function classifyAmbiguousRename(currentName: string | null | undefined, desired: string): "applied" | "concurrent-edit" | "failed";
```

- Duplicate derived titles across candidates: allowed; a `duplicates` count is computable by the caller from the plan array (no extra machinery).

- [ ] **Step 1: Failing tests:** selection honors the spike-recorded unnamed definition (empty/null/whitespace name variants), ids filter, limit; planRename resolvable + both unresolved reasons; classifyAmbiguousRename all three outcomes (incl. null/undefined current name -> "failed", whitespace-only current -> "failed").
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Full TSDoc. Export the three functions + type from `index.ts`.
- [ ] **Step 4: Run + full suite + tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): resolve-names planning + ambiguous-outcome classification`.

---

### Task 5: CLI -- `conversations resolve-names`

**Files:**
- Create: `packages/cli/src/commands/conversations.ts`
- Modify: `packages/cli/src/index.ts` (register the new `conversations` namespace command)

**Semantics (spec-locked):**
- `claudesync conversations resolve-names [--org <id>] [--id <uuid>...] [--limit <n>] [--apply] [--json]`
- DRY-RUN default: list summaries -> `selectUnnamedConversations` -> hydrate each (`getConversation`) -> `planRename`. Print up-front: `Resolving N unnamed conversation(s) -- this fetches each one in full.` Then a table `uuid  ->  proposed title` for resolvable candidates plus an unresolved section (uuid + reason only). One-line warning above the table: `Proposed titles are derived from conversation content -- review before applying.` Summary counts: resolvable, unresolved, total. Then `Nothing renamed -- re-run with --apply to push these names to claude.ai.`
- `--apply`: resolve ALL candidates first, then rename serially (writes concurrency 1; reads use the client's existing limiter). Per item: success -> `renamed`; 404 -> `skipped-deleted`; thrown timeout/connection error -> re-read once, `classifyAmbiguousRename` -> applied / concurrent-edit (left alone, reported) / failed. Other errors -> `failed` (uuid + status only), batch CONTINUES. SIGINT: finish the in-flight write, start no new ones, print partial summary. Exit nonzero if any item failed or stayed ambiguous. Final counts: renamed, unresolved, skipped, failed, concurrent-edit.
- After a successful apply, print: `Renamed conversations will re-export under new directory names on next sync; previous unnamed-<uuid> directories are left behind.` (rename-orphan caveat, verbatim).
- `--json`: the plan (and per-item outcomes under --apply) as JSON INCLUDING titles -- documented in `--help` as content-bearing output.
- Eligibility per spike findings (exclude project conversations and/or is_temporary if the spike said so -- read rename-findings.md).
- Reuse `createClient`/`resolveOrgId`/`outputJson` patterns from sibling commands. Full TSDoc on helpers.

- [ ] **Step 1: Implement.**
- [ ] **Step 2: `pnpm build`, expect clean.**
- [ ] **Step 3: Controller smoke (live):** dry-run against the real org -- table renders, counts sane, nothing sent (verify no PUT/POST in any request log the client makes -- structurally: dry-run code path contains no rename call). A LIVE `--apply` happens only in Task 6's acceptance smoke, controller-run, against the blessed conversation only.
- [ ] **Step 4: Commit** `feat(cli): conversations resolve-names (dry-run default, serial apply)`.

---

### Task 6: Changelog, spec status, acceptance smoke, finish

**Files:**
- Modify: `CHANGELOG.md`, `docs/superpowers/specs/2026-07-17-resolve-unnamed-conversations-design.md`

- [ ] **Step 1 (controller): acceptance smoke.** `conversations resolve-names --id 57df4700-... ` dry-run shows a derived title for the blessed conversation; `--apply --id 57df4700-...` renames it on claude.ai (verify via list GET); then roll back per the spike's proven un-naming mechanism and re-verify unnamed. Structural reporting only (no title text in the session transcript beyond what the user sees in their own terminal).
- [ ] **Step 2:** CHANGELOG `[Unreleased]` `### Added` entry (content-free description). Spec status -> implemented, with deviations noted.
- [ ] **Step 3: Full gate:** `pnpm build && pnpm -r test`; ASCII grep over touched files.
- [ ] **Step 4: Commit** `docs: changelog + spec status for resolve-unnamed conversations`.
- [ ] **Step 5:** Finish via superpowers:finishing-a-development-branch.

---

## Self-Review Notes

- Spec coverage: heuristic contract incl. every listed sanitization + grapheme rule (T2); observe-first spike + rollback proof + edge probes (T1); one-shot SDK write with pre-request validation + privacy-safe errors (T3); selection/plan/reconciliation pure core (T4); CLI dry-run default, serial apply, 404/ambiguous/SIGINT handling, rename-orphan warning, content-bearing output documented (T5); no local-derived paths anywhere (nothing in the plan touches naming.ts/scheduler/sync -- v1 narrowing held); no MCP tool; migration deferred.
- Type flow: `deriveConversationTitle` (T2) -> `planRename` (T4) -> CLI (T5); `renameConversation` (T3) -> CLI apply (T5); spike findings (T1) -> endpoint constants (T3) + unnamed definition (T4) + eligibility (T5).
- Placeholder check: T3's endpoint intentionally references T1's recorded findings rather than a guessed literal -- that is the observe-first mandate, and the findings doc will exist before T3 dispatches.
- Privacy: titles appear only in the resolve-names table/JSON; every error path is uuid+status; T3 tests plant a marker name and assert absence from errors.
