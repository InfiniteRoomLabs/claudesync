# Skip Empty Conversations -- Design

Status: IMPLEMENTED 2026-07-20 (7-task subagent-driven run on feat/skip-empty-conversations; live-smoked read-only against the real org). Design was reviewed by a multi-model /deliberate panel 2026-07-16 (full participation) and revised per its findings plus user decisions. Implementation deviations from this spec: none of substance; notable clarifications -- (1) the became-empty policy for PROJECT bundle conversations uses the on-disk subtree as the prior-state proxy (project bundles have no per-conversation sidecar) and `retain` preserves subtrees via preserve-glob injection into the rebuild; (2) json-format project output has no subtree, so the policy is effectively skip-only there; (3) with a small `--limit`, ls's hidden-count notice reflects only scanned candidates (documented behavior).

## Problem

Empty conversations (abandoned drafts, accidental opens) are exported as empty bundles and clutter listings. They waste API calls, disk, and attention.

## Locked decisions (user-adjudicated; do not relitigate)

- Emptiness = **zero human messages** (assistant-greeting-only conversations are empty).
- Skipping applies to `export`, `export-all`, `sync`, and hiding in `ls`, each with `--include-empty`.
- The setting is configurable via every config path (config file, env var, CLI flag; flag wins).
- Previously-exported conversation later becomes empty: **all three policies available behind a config knob**, default `sync` (follow the remote snapshot; git mode records deletions). Other values: `retain` (never touch existing output, do not advance state), `clean` (delete generated subtree, record empty marker).
- Explicitly targeted `export <uuid>` of an empty conversation: **skips with an explicit `skipped-empty` result** and a `--include-empty` hint. Never a silent no-op, never a bypass.
- `ls --json` / `--query`: **filtered identically to the human table**; hidden-count notice goes to stderr so stdout stays clean machine-readable output.

## Emptiness predicate

A hydrated conversation is empty iff no entry in its complete `chat_messages` array has `sender === "human"`.

- Evaluated over the ENTIRE message tree (all branches), not just the active branch from `current_leaf_message_uuid`. A human message on an abandoned branch makes the conversation nonempty.
- Whitespace-only or empty-text human messages are NONempty (the locked definition counts senders, not content quality).
- Attachment-only human turns are nonempty (attachments/`files_v2` hang off a human message).
- The predicate accepts a hydrated `Conversation`, NOT a `ConversationSummary` -- the type signature prevents accidental use on incomplete data.
- Scope: claude.ai conversations only. The predicate must NOT be placed in the surface-neutral sync seam where it could affect Claude Code / Aider / Gemini CLI / OpenCode sources.
- Documented caveat: a conversation with no human message but server-side artifacts is still empty and its artifacts are not exported (data-loss note in the skip message when artifact count is known).
- Fetch/schema/artifact errors are NEVER classified as empty -- they surface as errors.

## Phase 0 spike (required before implementation)

The list endpoint (`ConversationSummarySchema`) carries no message counts, so exact detection requires the full tree. The spike probes whether list metadata gives a reliable shortcut:

- Capture list-level fields for: an empty draft, an assistant-greeting-only conversation, an ordinary conversation, an attachment-only-opener conversation, a branched conversation.
- Hypothesis to test: `current_leaf_message_uuid === null` implies zero messages anywhere. Also inspect any other candidate fields observed.
- Outcome A (invariant proven): `ls` and bulk paths pre-filter on the invariant, hydrating only ambiguous cases.
- Outcome B (no invariant): exports/sync accept bounded hydration (they fetch trees anyway -- see pipeline below); `ls` CANNOT afford N+1 hydration, so `ls` default degrades to annotate-only (a `possibly-empty` marker where cheap signals suggest it) and the hide-by-default behavior is limited to surfaces that already hydrate. This deviation from the locked scope, if triggered, is flagged to the user at plan time before implementation.
- Unverified heuristics must not ship: whichever branch is taken is recorded here with the spike evidence.

### Spike results (run 2026-07-20, live API, read-only; outcome: A, with a one-directional invariant)

- Corpus: 1628 conversations in the account. Summary fields observed: `created_at, current_leaf_message_uuid, effective_thinking_mode, is_starred, is_temporary, is_wiggle_enabled, model, name, platform, project, project_uuid, session_id, settings, summary, updated_at, user_uuid, uuid`. No message-count field exists.
- 15 conversations had `current_leaf_message_uuid == null`. ALL 10 hydrated null-leaf conversations had literally ZERO messages (`chat_messages: []`). Zero violations of `leaf == null -> no messages`.
- All 12 hydrated non-null-leaf conversations had at least one human message. No assistant-greeting-only conversation was observed in the corpus.
- **Decision (one-directional invariant):** `ls` hides on `current_leaf_message_uuid == null` ONLY -- list-level, zero extra requests. This direction is the safe one for a listing: a hypothetical assistant-only conversation (non-null leaf, zero human messages) would still be SHOWN by `ls` but is skipped exactly by export/sync's hydrated predicate. The asymmetry ("ls hides a subset of what exports skip") is documented in `--help` text.
- Export/sync/export-all use the exact hydrated predicate (they fetch trees anyway); the summary-level signal is never used where the exact answer is already in hand.

## Pipeline placement (detection cost)

Order of operations in the fetch path becomes: hydrate message tree -> classify emptiness -> ONLY for included conversations, list/download artifacts and build the bundle. Today `packages/core/src/sync/fetch.ts` downloads artifacts before bundle construction; classification must run before that work, otherwise skipping saves little.

For never-exported empty conversations there is no sidecar, so each sync re-hydrates them to reconfirm emptiness. v1 accepts this bounded recurring cost (they are cheap tree fetches, no artifacts); a persistent empty-classification cache is explicitly a follow-up, not v1 (it would introduce a new state format, invalidation, and concurrency obligations).

## Slug stability (correctness-critical)

Slug allocation/disambiguation in `packages/core/src/sync/scheduler.ts` runs over the COMPLETE discovered set BEFORE empty filtering. An empty conversation entering or leaving the set must never change another conversation's slug (which would orphan its export directory and state). Regression tests pin this.

## Became-empty transitions

- Never-exported + empty: skipped (`skipped-empty` outcome), no directory, no state.
- Previously-exported + becomes empty: governed by `onBecameEmpty` config:
  - `sync` (default): normal sync of the remote snapshot; messages disappear from output; git mode records deletions; state advances.
  - `retain`: output untouched, state not advanced; conversation re-checked each run (documented cost); reported as `retained-stale`.
  - `clean`: generated subtree deleted, empty marker recorded in state so subsequent runs skip cheaply; preserved/user files and git history survive per existing preservation rules.
- Empty -> nonempty: absence of state must never mean "known empty"; the conversation is hydrated and materialized normally the moment it gains a human message.
- Project bundles: the same policy applies during project rebuilds; omitting an empty conversation from a rebuild must follow `onBecameEmpty`, not silently delete prior subtrees under `retain`.

## CLI surface semantics

- `export`, `export-all`, `sync`: skip with per-item `skipped-empty` outcome; summary line `N empty conversation(s) skipped (--include-empty to include)`. Distinct counter (`skippedEmpty`) in bulk results and scheduler progress events -- NOT overloaded onto the existing unchanged-"skipped" outcome.
- `export <uuid>`: `skipped-empty` result + hint, exit 0 (it is a successful classification, not an error).
- `ls`: hides empty conversations by default. Notice `N empty conversation(s) hidden; use --include-empty` on stderr. Output distinguishes "no conversations exist" from "all conversations hidden". `--limit` counts VISIBLE items (filtering happens before the limit check -- note current `ls.ts` stops collecting at the limit, so collection must over-fetch or filter inline). Hidden count covers scanned candidates, not the whole org, unless pagination was exhausted anyway. `--json`/`--query` filtered identically; notices on stderr only.
- TUI and MCP listings: OUT OF SCOPE for v1 (filtering there would force N+1 hydration on interactive surfaces); explicitly documented.
- `is_temporary` conversations: follow the same emptiness rule; no special-casing in v1.

## Configuration

Extends the config layer (`packages/core/src/config/`) with a behavior-config section -- the existing resolver is concurrency-specific and gains a sibling, not a bolted-on passthrough.

| Setting | File key | Env | CLI | Default |
|---|---|---|---|---|
| Skip empties | `skipEmptyConversations` | `CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS` | `--include-empty` (maps to false) | `true` |
| Became-empty policy | `onBecameEmpty` (`sync`\|`retain`\|`clean`) | `CLAUDESYNC_ON_BECAME_EMPTY` | `--on-became-empty <v>` | `sync` |

Precedence: CLI flag > env > file > default. An absent flag is `undefined` (does not override env/file). A boolean env parser is added (the existing helper is numeric); invalid values fail loudly. Tests cover the full precedence matrix including explicit `false`.

## Testing

- Predicate corpus: empty draft, greeting-only, whitespace-only human turn, attachment-only turn, human turn on abandoned branch, ordinary conversation.
- Slug-stability: empties entering/leaving the discovered set do not move neighbors.
- Became-empty matrix: all three policies x standalone + project bundle.
- Config precedence matrix.
- Request-count tests: skipping an empty conversation performs no artifact requests; `ls` performs no per-conversation hydration on the invariant path.
- Machine-output stability: `--json` stdout parses; notices only on stderr.

## Out of scope (v1)

Persistent empty-classification cache; TUI/MCP filtering; secret/content scanning; `ls` hydration fallback beyond the annotate-only degradation described in the spike section.
