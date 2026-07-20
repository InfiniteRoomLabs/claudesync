# Skip Empty Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Skip conversations with zero human messages in `export`, `export-all`, and the surface sync path, hide them in `ls` via the list-level null-leaf invariant, with typed `skipped-empty` outcomes, a configurable became-empty policy, and full config plumbing.

**Architecture:** One pure predicate module (`sync/empty.ts`) feeds two genuinely independent code paths -- the legacy scheduler (`export-all`) and the surface seam (`export`) -- plus a list-level filter in `ls`. Emptiness is decided AFTER hydration and BEFORE artifact downloads. Slug allocation always runs over the complete discovered set before any filtering. A `BehaviorConfig` sibling of the existing concurrency config carries `skipEmptyConversations` + `onBecameEmpty` through file/env/flag precedence.

**Tech Stack:** TypeScript (strict, ESM, NodeNext -- relative imports end `.js`), Node 24, Vitest (globals off, `@core` alias), Zod, commander.

**Spec:** `docs/superpowers/specs/2026-07-17-skip-empty-conversations-design.md` (includes spike results). **Recon map (read before implementing):** `.superpowers/sdd/recon-skip-empty.md` -- exact file/line/type references for every integration point named below.

## Global Constraints

- node/pnpm direct on PATH via mise shims; do NOT run `nvm use`.
- pnpm only. Core test file run: `pnpm --filter @infinite-room-labs/claudesync-core exec vitest run test/<path>.test.ts`.
- ESM + NodeNext: every relative import ends in `.js`. Strict TS, no `any`.
- Tests in `packages/core/test/**`, import source via `@core` alias, `import { describe, it, expect, vi } from "vitest"`.
- FULL TSDoc on every declaration AND member; no `{type}`, no `@property`/`@interface`; `@param name - desc`, `@returns`, `@throws`, `{@link}`.
- ASCII only. Synthetic fixtures only (never real conversation content).
- Branch: `feat/skip-empty-conversations` (already exists; spec + spike committed).
- `git add` and `git commit` are SEPARATE Bash calls.
- **Emptiness predicate is claude.ai-scoped**: it must NEVER be called from `surface/orchestrator.ts`'s neutral loop; the orchestrator only reacts to a neutral `isEmpty` marker set by `ClaudeSource`.
- **API facts (spike-verified, do not re-derive):** the conversations list endpoint returns ALL summaries in one response (no pagination). `current_leaf_message_uuid == null` (loose, folds undefined) implies zero messages (10/10 hydrated confirmations, 0 violations). Summary has NO message-count field. `chat_messages` on a hydrated conversation is a FLAT array containing every branch.

---

### Task 1: Pure emptiness predicate + became-empty policy decision

**Files:**
- Create: `packages/core/src/sync/empty.ts`, `packages/core/test/memory/../sync/empty.test.ts` (path: `packages/core/test/sync/empty.test.ts`)
- Modify: `packages/core/src/index.ts` (export all three functions + the two types)

**Interfaces:**
- Produces:

```ts
/** Policy for a previously-exported conversation that has since become empty. */
export type OnBecameEmpty = "sync" | "retain" | "clean";

/** Resolved action for one empty conversation, given prior-state presence and policy. */
export type EmptyAction = "skip" | "materialize-full" | "retain" | "clean";

/** True iff no message in the conversation's complete (all-branches) flat
 * chat_messages array has sender "human". Whitespace-only human turns count
 * as human. Claude.ai conversations only -- never call from neutral seams. */
export function isEmptyConversation(conversation: Pick<Conversation, "chat_messages">): boolean {
  return !conversation.chat_messages.some((m) => m.sender === "human");
}

/** List-level emptiness signal: null/undefined active-leaf pointer implies a
 * conversation with zero messages (spike-verified invariant, one direction
 * only -- a non-null leaf does NOT prove nonempty). For `ls` hiding only. */
export function summaryLooksEmpty(summary: Pick<ConversationSummary, "current_leaf_message_uuid">): boolean {
  return summary.current_leaf_message_uuid == null;
}

/** Maps (prior sync state exists?, policy) to the action the caller takes for
 * an empty conversation. No prior state always skips regardless of policy. */
export function decideEmptyAction(hasPriorState: boolean, policy: OnBecameEmpty): EmptyAction {
  if (!hasPriorState) return "skip";
  switch (policy) {
    case "sync": return "materialize-full";
    case "retain": return "retain";
    case "clean": return "clean";
  }
}
```

- [ ] **Step 1: Write the failing test** (`test/sync/empty.test.ts`). Cases: zero messages -> empty; assistant-only -> empty; one human -> nonempty; whitespace-only human text -> NONempty; human on an abandoned branch (two branches, human only on the non-leaf one; flat array carries both) -> nonempty; `summaryLooksEmpty` for `null`, `undefined`, and a real uuid; `decideEmptyAction` full matrix (2 x 3). Build messages with a local fixture helper mirroring `test/sync/scheduler.test.ts`'s `message()` builder.
- [ ] **Step 2: Run it, expect FAIL** (module missing).
- [ ] **Step 3: Implement** `empty.ts` exactly as above with full TSDoc; export from `index.ts`.
- [ ] **Step 4: Run test + full core suite + `pnpm --filter @infinite-room-labs/claudesync-core exec tsc --noEmit`, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): emptiness predicate + became-empty policy decision`.

---

### Task 2: Behavior config (`skipEmptyConversations`, `onBecameEmpty`)

**Files:**
- Modify: `packages/core/src/config/index.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/config/behavior-config.test.ts`

**Interfaces:**
- Produces (mirror the existing `ConcurrencyConfigSchema` / `resolveConcurrencyConfig` patterns in the same file -- read them first):

```ts
/** Zod schema for behavior settings in .claudesyncrc.json (top-level keys). */
export const BehaviorConfigSchema = z
  .object({
    skipEmptyConversations: z.boolean().default(true),
    onBecameEmpty: z.enum(["sync", "retain", "clean"]).default("sync"),
  })
  .passthrough();
export type BehaviorConfig = z.infer<typeof BehaviorConfigSchema>;

/** Parses a boolean env var: "1"/"true"/"yes" -> true, "0"/"false"/"no" -> false
 * (case-insensitive); unset -> undefined; anything else -> throws (invalid
 * values fail loudly rather than silently defaulting). */
export function envBool(env: NodeJS.ProcessEnv, key: string): boolean | undefined;

/** Precedence: CLI flag > env > config file > schema default. An undefined
 * flag falls through (?? chain) -- it never overrides env/file. */
export function resolveBehaviorConfig(
  flags: { skipEmptyConversations?: boolean; onBecameEmpty?: OnBecameEmpty },
  env: NodeJS.ProcessEnv,
  file: Record<string, unknown>
): BehaviorConfig;
```

- Env vars: `CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS` (via `envBool`), `CLAUDESYNC_ON_BECAME_EMPTY` (validate against the enum; invalid -> throw). File keys are the same camelCase names at the top level of `.claudesyncrc.json` (the existing `loadConfigFile` is reused untouched).

- [ ] **Step 1: Failing test** modeled on `test/config/config.test.ts`'s precedence-matrix structure (`noEnv = {} as NodeJS.ProcessEnv` sentinel): defaults; file only; env overrides file; flag overrides env+file; EXPLICIT `false` flag beats env/file `true`; explicit env `"false"` beats file `true`; absent flag (undefined) does NOT override env; `envBool` accepted spellings + throw on garbage; `onBecameEmpty` enum validation (file, env, flag) + throw on invalid.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** in `config/index.ts` beside the concurrency resolver. Full TSDoc. Export schema/type/resolver (+ `envBool` if exported -- keep internal unless the test needs it via `@core` path import, which reaches internals fine; do NOT add it to `index.ts` barrel).
- [ ] **Step 4: Run new test + existing `config.test.ts` + full suite + tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): behavior config with skip-empty + became-empty settings`.

---

### Task 3: Sync-path integration -- `fetchAndBuild` early exit, `syncConversation` policies, typed outcomes

**Files:**
- Modify: `packages/core/src/sync/fetch.ts`, `packages/core/src/sync/incremental.ts`, `packages/core/src/sync/state.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/sync/empty-sync.test.ts`

**Interfaces (consumes Task 1's module; produces for Tasks 4-6):**
- `fetch.ts`: add option `detectEmpty?: boolean` to `fetchAndBuild`'s options. When set, immediately after `getConversation` hydrates, run `isEmptyConversation`; if empty, return early with a new discriminated shape BEFORE any artifact call:

```ts
/** Early-exit result when detectEmpty found a zero-human-message conversation:
 * hydration happened, but no artifacts were listed/downloaded and no bundle built. */
export type FetchAndBuildEmpty = { empty: true; conversation: Conversation };
// fetchAndBuild return type becomes FetchAndBuildResult | FetchAndBuildEmpty
// (existing success shape gains `empty?: false` OR callers discriminate via "empty" in r)
```

  Pick the cleanest discrimination that keeps existing callers compiling unchanged when `detectEmpty` is not set (overloads on the option, or a union + type guard -- implementer's choice, TSDoc'd).
- `state.ts`: extend `last_sync_action` enum with `"cleaned-empty"` (additive).
- `incremental.ts`: `SyncConversationResult.action` union gains `"skipped-empty" | "retained-stale" | "cleaned-empty"`. `syncConversation` gains options `{ skipEmpty?: boolean; onBecameEmpty?: OnBecameEmpty }` (defaults true/"sync"). Flow, inserted after the existing skip-existing/skip-same checks and using `detectEmpty` on its `fetchAndBuild` call:
  1. fetch returns empty=false -> existing behavior unchanged.
  2. empty=true -> `decideEmptyAction(priorStateExists, policy)`:
     - `skip` -> return `{action: "skipped-empty"}` (no writes, no state).
     - `materialize-full` -> materialize the (empty) conversation with a FORCED full (not incremental) materialization -- `diffConversation` does not model branches vanishing to zero; full rebuild sidesteps it. State advances normally.
     - `retain` -> return `{action: "retained-stale"}` (no writes, state NOT advanced).
     - `clean` -> replace the conversation directory content using the existing preserve-aware replacement (`replaceWithPreserve` semantics -- reuse, do not reimplement) with an EMPTY generated set, keeping the state file, and write state with `last_sync_action: "cleaned-empty"`. Subsequent runs short-circuit via the existing skip-same list-metadata check.
- `skipEmpty: false` bypasses all of the above (empty conversations flow through the pre-existing path).

- [ ] **Step 1: Failing tests** (`empty-sync.test.ts`, mock client like `scheduler.test.ts`'s `buildMockClient` but ALSO stubbing `listArtifacts`/`downloadArtifact` with call trackers): empty + no prior state -> `skipped-empty`, zero artifact calls, no files written; empty + prior state + policy sync -> full materialization, state advanced; + policy retain -> `retained-stale`, files byte-untouched, state file byte-untouched; + policy clean -> generated files gone, state file present with `cleaned-empty`; nonempty conversation with detectEmpty on -> artifacts fetched, normal result; `skipEmpty:false` -> empty conversation exports as before; second run after clean -> cheap skip (no re-hydration when list metadata unchanged -- goes through the existing skip-same branch).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Full TSDoc on every changed signature/union member. Export new types from `index.ts`.
- [ ] **Step 4: Run new tests + existing `test/sync/*` (all must still pass) + full suite + tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): empty-aware sync path with became-empty policies`.

---

### Task 4: Scheduler + project-bundle integration (`export-all` path)

**Files:**
- Modify: `packages/core/src/sync/scheduler.ts`
- Test: `packages/core/test/sync/scheduler-empty.test.ts` (new; extend fixtures from `scheduler.test.ts` -- note its mock client omits artifact methods, so either run with skipArtifacts or extend the mock)

**Interfaces:**
- `RunOrgSyncOptions` gains `{ skipEmpty?: boolean; onBecameEmpty?: OnBecameEmpty }`, threaded into every `syncConversation` call (both `runProjectConv` and `runStandalone`).
- `RunOrgSyncResult` gains counters: `skippedEmpty: number`, `retainedStale: number`, `cleanedEmpty: number` (sum across standalone + project conversations).
- `ProgressEvent` "conv-done" events carry the new action strings (field is already `action: string`; just pass through).
- Project bundles: a conversation whose sync outcome is `skipped-empty`/`retained-stale`/`cleaned-empty` is EXCLUDED from the `ProjectConvBuilt[]` accumulator so `assembleProjectBundle` rebuilds without it. CRITICAL: slug allocation (`disambiguateSlugs` calls) is NOT moved -- it already runs over the complete discovered set before dispatch; add a regression test proving an empty conversation still occupies its slug (a nonempty conversation with a colliding name keeps its disambiguated suffix whether or not the empty one is skipped).

- [ ] **Step 1: Failing tests:** org with 1 empty + 2 nonempty standalone -> result counters `{skippedEmpty: 1}`, both nonempty exported; project with an empty member -> bundle written without it, README/bundle content excludes it; slug-stability: two same-named conversations where one is empty -> the nonempty one's directory slug is IDENTICAL whether skipEmpty is true or false; progress events include a conv-done with action `skipped-empty`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Full TSDoc on new options/fields.
- [ ] **Step 4: Run new + existing scheduler tests + full suite + tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): scheduler empty-skip counters + project bundle exclusion`.

---

### Task 5: Surface-seam integration (`export` path)

**Files:**
- Modify: `packages/core/src/surface/types.ts`, `packages/core/src/surface/claude-source.ts`, `packages/core/src/surface/orchestrator.ts`
- Test: `packages/core/test/surface/empty-seam.test.ts` (model on `seam.test.ts`)

**Interfaces:**
- `types.ts`: `CanonicalItem` gains optional `isEmpty?: boolean` -- a NEUTRAL "the source considers this item content-empty" marker (any source may set it; only ClaudeSource does today). `ApplyResult.action` union gains `"skipped-empty" | "retained-stale" | "cleaned-empty"`.
- `claude-source.ts`: `ClaudeSource` options gain `{ skipEmpty?: boolean }` (default true). `read()` calls `fetchAndBuild` with `detectEmpty: skipEmpty`; on the empty early-exit it returns a `CanonicalItem` with `isEmpty: true` and the hydrated `conversation` but NO bundle/artifacts (adjust the item construction accordingly -- the mutually-exclusive bundle/tree invariant must still hold; document the third shape in TSDoc).
- `orchestrator.ts`: in the per-item loop, AFTER `read()`: if `item.isEmpty && opts.skipEmpty !== false`:
  - `await sink.exists(ref)` false -> result `{action: "skipped-empty"}`, next item.
  - exists -> `decideEmptyAction(true, opts.onBecameEmpty ?? "sync")`: `materialize-full` -> fall through to the normal write (sink materializes the empty snapshot; forced-full is Task 3's materialize behavior); `retain` -> `{action: "retained-stale"}`; `clean` -> the sink write path performs the clean (FileSink delegates to the same preserve-aware replacement used in Task 3 -- pass the action through `SinkSurface.write`'s options; extend its options type minimally).
  - The orchestrator NEVER inspects messages/senders itself -- it only reads the neutral `isEmpty` marker and the neutral policy option. `SyncOptions` gains `{ skipEmpty?: boolean; onBecameEmpty?: OnBecameEmpty }`.

- [ ] **Step 1: Failing tests** with a stub source/sink pair (per `seam.test.ts` conventions): empty item + sink lacks it -> `skipped-empty`, sink.write never called; empty + sink has it + sync policy -> write called (empty snapshot); + retain -> `retained-stale`, write not called; + clean -> write called with the clean directive; nonempty item -> unchanged behavior; a non-claude stub source that never sets `isEmpty` -> completely unaffected even with skipEmpty on.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Full TSDoc; keep orchestrator changes minimal and neutral.
- [ ] **Step 4: Run new + existing surface tests (`seam.test.ts`, `cc-seam.test.ts` must pass untouched) + full suite + tsc, expect PASS.**
- [ ] **Step 5: Commit** `feat(core): surface-seam empty handling via neutral isEmpty marker`.

---

### Task 6: CLI wiring -- `ls`, `export`, `export-all`

**Files:**
- Modify: `packages/cli/src/commands/ls.ts`, `packages/cli/src/commands/export.ts`, `packages/cli/src/commands/export-all.ts`
- Test: `pnpm build` gate + controller-run read-only smoke (no CLI unit-test infra exists; core logic is fully unit-tested above).

**Semantics:**
- All three commands add `--include-empty` (boolean). `export-all` and `export` also add `--on-became-empty <sync|retain|clean>`. Flags + env + `.claudesyncrc.json` resolve through `resolveBehaviorConfig` (`--include-empty` maps to `skipEmptyConversations: false` ONLY when the flag is present).
- `ls`: in the existing collection loop, add `if (skipEmpty && summaryLooksEmpty(conv)) { hiddenEmpty++; continue; }` BEFORE the limit check (so `--limit` counts visible items). After the loop: if `hiddenEmpty > 0`, print `` `${hiddenEmpty} empty conversation(s) hidden; use --include-empty` `` to STDERR (all modes). If the table would be empty: print "No conversations." when nothing existed vs "All N conversations are empty drafts (hidden); use --include-empty" when everything was hidden. `--json`/`--query` operate on the already-filtered array (they do today -- verify, don't restructure). Document in `--help` that ls's hide signal is the list-level draft marker (a subset of what exports skip).
- `export`: pass `skipEmpty`/`onBecameEmpty` into the seam `sync()` options; print outcomes for the three new actions: `skipped-empty` -> `Conversation has no human messages -- skipped. Re-run with --include-empty to export it.` (exit 0); `retained-stale` -> note output kept + state frozen; `cleaned-empty` -> note directory cleaned.
- `export-all`: thread options into `runOrgSync`; `actionTag` gains the three new actions (`"skipped-empty"` -> `Skipping (empty)`, etc.); final summary appends `, N empty skipped` (+ retained/cleaned counts when nonzero) from the new result counters.

- [ ] **Step 1: Implement all three.** Full TSDoc on any new helper. Copy strings above are verbatim.
- [ ] **Step 2: `pnpm build`, expect clean.**
- [ ] **Step 3: Controller smoke (read-only, live):** `ls` against the real org shows the hidden-count stderr notice (the account has 15 null-leaf conversations) and `--include-empty` restores them; `ls --json | jq length` differs by exactly the hidden count. NO export/sync smoke against real data in this task.
- [ ] **Step 4: Commit** `feat(cli): skip-empty wiring for ls, export, export-all`.

---

### Task 7: Changelog, spec status, finish branch

**Files:**
- Modify: `CHANGELOG.md`, `docs/superpowers/specs/2026-07-17-skip-empty-conversations-design.md`

- [ ] **Step 1:** CHANGELOG `[Unreleased]` `### Added`: skip-empty feature summary (predicate, policies, config, CLI surfaces, list-level ls invariant) -- content-free, match entry style.
- [ ] **Step 2:** Mark the spec's status line implemented; note any deviations discovered during implementation.
- [ ] **Step 3: Full gate:** `pnpm build && pnpm -r test` green; `grep -rnP '[^\x00-\x7F]'` clean on touched files.
- [ ] **Step 4: Commit** `docs: changelog + spec status for skip-empty conversations` (separate add/commit).
- [ ] **Step 5:** Finish via superpowers:finishing-a-development-branch.

---

## Self-Review Notes

- Spec coverage: predicate incl. abandoned-branch + whitespace rules (T1); spike-decided ls invariant + stderr notices + limit semantics (T6); detection-cost split (hydrate-then-classify-then-artifacts, T3); slug-before-filter (T4 regression test); all three became-empty policies + explicit-uuid skip semantics (T3/T5/T6); typed outcomes + counters (T3/T4/T5); config precedence incl. explicit-false (T2); claude.ai scoping via neutral marker (T5); TUI/MCP + cache explicitly out of scope (spec).
- Type flow: `OnBecameEmpty`/`decideEmptyAction` (T1) -> `syncConversation` opts (T3) -> scheduler opts (T4) and `SyncOptions` (T5) -> CLI flags (T6). `FetchAndBuildEmpty` (T3) consumed by ClaudeSource (T5).
- Both sync paths covered independently (T4 scheduler, T5 seam) because they are genuinely separate code paths (recon finding).
- No placeholders: every task names exact files, signatures, copy strings, and test cases; the recon file carries the line-level map.
