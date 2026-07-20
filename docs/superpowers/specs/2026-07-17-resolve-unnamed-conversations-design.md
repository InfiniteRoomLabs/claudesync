# Resolve Unnamed Conversations -- Design

Status: reviewed (multi-model /deliberate panel 2026-07-16, full participation) and revised per its findings plus user decisions. Supersedes the one-paragraph draft. The panel's blocking finding (local-derived paths break incremental sync) is resolved by narrowing v1: local paths follow the remote name, period.

## Problem

Unnamed conversations (empty `name` on the API) export as `unnamed-<uuid>/` and are indistinguishable in listings and on claude.ai itself. The feature derives a real title from the conversation's opening message and mirrors it up to claude.ai.

## Locked decisions (user-adjudicated; do not relitigate)

- Title source: **first-message heuristic** (no LLM titling in v1).
- Names ARE **mirrored to claude.ai** -- that is the point of the feature.
- v1 narrowing (panel blocker fix): **no local-only derived paths.** Export slugs continue to follow the remote name; an unnamed conversation stays `unnamed-<uuid>` until the remote rename succeeds. Local naming improves as a CONSEQUENCE of the remote rename, via the normal sync path.

## Phase 0 spike (required; runs only with explicit user go-ahead -- it mutates real data)

**COMPLETE 2026-07-20 -- findings in `docs/spike-results/rename-findings.md`.** Summary: `PUT /api/organizations/<org>/chat_conversations/<uuid>` body `{"name": string}` returns 202 with the updated summary; rollback via `name: ""` proven; same-value idempotent; no server truncation at 150 chars; Unicode fine; project conversations eligible; `updated_at` bumps on every rename (one refetch per renamed conversation on next sync); unnamed means `name === ""`. Bonus: the UI sometimes triggers server-side auto-titling on open (unreliable -- not built upon).

Observe, then reproduce -- do not guess the endpoint:

1. Capture the browser's actual rename request from claude.ai (devtools/claude-in-chrome network capture while renaming a conversation in the UI). Record method, path, headers, body, response shape.
2. Reproduce against ONE explicitly approved unnamed conversation. Establish beyond a 2xx: name visible in list + detail + UI; whether `updated_at` changes (a rename-triggered refetch storm on next sync is a real cost to record); whether omitted body fields are left untouched; max length + Unicode behavior; same-value assignment behavior; project-conversation and `is_temporary` behavior.
3. Prove rollback: set `name: ""` and confirm the conversation actually returns to unnamed. Until proven, the mutation is NOT described as reversible.
4. Record the observed definition of "unnamed" (absent vs null vs `""` vs whitespace) against the live schema; the feature's selection predicate uses exactly that.

## Core: title derivation

`deriveConversationTitle(conversation): string | null` -- pure, deterministic, offline.

- Input selection: earliest human message on the ACTIVE branch (walk from `current_leaf_message_uuid` using the existing tree utilities in `packages/core/src/tree/`); deterministic fallback (earliest human message by index) when branch metadata is missing/malformed.
- Inspect at most the first ~1 KiB of the message text before heavier processing.
- Sanitize: strip markdown fences/delimiters (without deleting code content), ANSI/OSC control sequences, and bidi control characters (terminal-injection hygiene); Unicode NFC normalize.
- Truncate to a maximum of 60 graphemes -- word-boundary preferred, hard grapheme boundary for spaceless scripts; never split a grapheme cluster/surrogate pair. Single limit for all languages (no CJK special-casing in v1).
- Returns `null` (conversation stays unresolved) for: whitespace-only, markdown-only, or contentless openers, and attachment-only conversations. No invented titles. Unresolved conversations are reported distinctly.
- Duplicate derived titles across conversations are allowed remotely but reported in the summary.
- Heuristic versioning: applied remote names become the source of truth; the tool only ever targets currently-unnamed conversations, so algorithm changes never silently rewrite previously applied names.
- Known limitation (documented): `slugify()` strips non-ASCII, so a valid CJK/emoji-only remote title still slugs to `unnamed-<uuid>` locally. Unicode slugging is out of scope.

## SDK: `renameConversation`

`renameConversation(orgId, conversationId, name): Promise<void>` per the spike-confirmed endpoint.

- Rejects empty/whitespace-only names before any request (un-naming is not exposed in v1).
- One-shot: NO automatic retry at SDK or CLI level (undocumented endpoint, unknown side-effect semantics; rerunning the command is the natural resume). Rationale documented as rename-specific, not copied from the memory write.
- Errors carry conversation UUID + HTTP status -- never the candidate title.
- Exported from `packages/core/src/index.ts`. NOT exposed as an MCP tool in v1 (agent-initiated renames need their own security review).

## CLI: `conversations resolve-names`

A new intentional `conversations` namespace (future conversation-scoped subcommands land here; top-level `ls`/`export` remain).

- **Dry-run by default.** Fetches each unnamed conversation's tree (~N full fetches -- stated up front in output), derives titles, prints a `uuid -> proposed title` table plus counts: resolvable, unresolved (with reason), total.
- **Titles are sensitive content, not metadata.** The preview intentionally displays them -- that is its review function -- with a one-line warning that titles are derived from message content. Titles never appear in logs, debug output, progress errors, or exception messages. Output is sanitized (controls/bidi already stripped by derivation). `--json` includes titles (a title-less preview is useless) and the docs prominently mark that output as content-bearing; behavior does not vary by TTY.
- **`--apply`:** resolve ALL candidates first, then write serially (write concurrency 1; reads use the existing limiter). Per-item failure does not abort the batch; a mid-batch 404 is recorded as `skipped-deleted`. SIGINT stops starting new writes. Exit nonzero if any item failed or ended ambiguous. Summary counts: renamed, unresolved, skipped, failed, ambiguous.
- **Ambiguous transport outcomes** (timeout/connection loss on a write): re-read the conversation name once to classify -- desired name = success; different non-empty name = concurrent user edit (left alone, reported); still unnamed = failed. No blanket verification of successful writes.
- **Staged operation:** `--id <uuid>` (repeatable) and `--limit N` restrict the target set. Successful renames naturally leave the unnamed set, so re-running resumes without checkpoint files.
- Eligibility: project conversations and `is_temporary` per spike findings (excluded by default if the spike shows surprises).

## Interaction with exports (and the rename-orphan caveat)

After `--apply`, the next sync sees the new remote name, computes a new slug, and exports under the new directory -- the OLD `unnamed-<uuid>` directory and its state are left behind. This is the repo's pre-existing rename-orphan behavior (any browser rename does the same); batch rename makes it loud.

- v1: the `--apply` summary warns that renamed conversations will re-export under new paths on next sync and that old `unnamed-<uuid>` directories become stale.
- UUID-based directory discovery/migration is a separate, explicitly designed follow-up (candidate: scan the export namespace for a state file matching `conversation_uuid`, require unique match, collision-check, never delete either directory on ambiguity). Not built here.
- Synthetic titles are never injected into remote conversation state: `materialize.ts`/`diff.ts` continue to represent the actual API name.

## Testing

- Derivation corpus: code-only openers, pasted logs, URLs, emoji, CJK, RTL, whitespace-only, markdown-only, control/bidi characters, attachment-only, >1 KiB openers, surrogate-pair boundaries.
- Client: rename URL/body/encoding, empty-name rejection, no-retry on 429/5xx/timeout, error privacy (no title in message).
- CLI batch: mid-batch failure continues, 404 classification, ambiguous-outcome reconciliation, SIGINT behavior, exit codes, counts.
- Privacy: assert no title strings in any error/log path.

## Out of scope (v1)

LLM titling; attachment-filename fallback titles; un-naming (`name: ""`) as a user feature; MCP rename tool; Unicode slugs; export-directory migration; automatic sensitive-title detection (optional follow-up; human review of the dry-run table is the mandatory control).
