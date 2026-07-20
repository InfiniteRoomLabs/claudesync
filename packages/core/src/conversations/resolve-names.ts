import type { Conversation, ConversationSummary } from "../models/types.js";
import { isEmptyConversation } from "../sync/empty.js";
import { deriveConversationTitle } from "./title.js";

/**
 * Options narrowing which unnamed conversations {@link selectUnnamedConversations}
 * returns.
 *
 * @remarks
 * Both fields are optional and independent: `ids` narrows by membership
 * first, then `limit` caps the (already `ids`-narrowed) result. Passing
 * neither returns every unnamed summary, in list order.
 */
export type SelectUnnamedConversationsOptions = {
  /**
   * When present, restricts the result to summaries whose `uuid` appears in
   * this list. Uuids that don't correspond to any summary in `summaries`
   * (unknown ids), or that correspond to a summary that isn't unnamed, are
   * simply absent from the result -- this function does not report on them;
   * a caller that needs to surface "requested id not found" does that
   * itself by diffing the input list against the returned uuids.
   */
  ids?: readonly string[];
  /**
   * When present, caps the result to at most this many entries. Applied
   * AFTER the `ids` filter, so `limit` bounds the final selection size, not
   * the pre-filter candidate pool.
   */
  limit?: number;
};

/**
 * One conversation's entry in a resolve-names batch plan.
 *
 * @remarks
 * Produced by {@link planRename} for one hydrated conversation. `status`
 * distinguishes a successfully derived title from a structural reason the
 * title could not be derived; `reason` carries that structural cause and is
 * present only when `status` is `"unresolved"`.
 *
 * Duplicate `title` values across multiple candidates in the same batch are
 * expected and allowed -- this type does not deduplicate or flag them. A
 * caller that wants a duplicate count computes it from the plan array (e.g.
 * by counting repeated non-null `title` values); no extra machinery is
 * needed here.
 */
export type ResolveNameCandidate = {
  /** The conversation's stable identifier. */
  uuid: string;
  /** The derived title, or `null` when no title could be derived. */
  title: string | null;
  /**
   * Outcome of title derivation for this conversation.
   *
   * - `"resolvable"`: {@link deriveConversationTitle} produced a usable,
   *   non-null title.
   * - `"unresolved"`: no usable title could be derived; see `reason` for why.
   */
  status: "resolvable" | "unresolved";
  /**
   * Structural cause of an `"unresolved"` status. Absent when `status` is
   * `"resolvable"`.
   *
   * - `"no-human-message"`: no entry in the conversation's `chat_messages`
   *   has sender `"human"` anywhere in the flat, all-branches array (see
   *   {@link isEmptyConversation}).
   * - `"empty-after-sanitize"`: at least one human message exists somewhere
   *   in the conversation, but {@link deriveConversationTitle} still
   *   returned `null` -- the candidate text (whitespace-only, markdown-only,
   *   code-only, etc.) sanitized to nothing, or the active branch's human
   *   message was on an abandoned branch relative to the resolved leaf.
   */
  reason?: "no-human-message" | "empty-after-sanitize";
};

/**
 * Predicate for the spike-recorded "unnamed" definition used by claude.ai's
 * conversation list payloads.
 *
 * @remarks
 * Mirrors the safe selection predicate recorded in the rename spike findings
 * (`docs/spike-results/rename-findings.md`): `!name || name.trim() === ""`.
 * The list API always sends `name` as `""` (never omitted or `null`) for an
 * unnamed conversation, and {@link ConversationSummary}'s schema types `name`
 * as a required, non-nullable string -- but this predicate stays defensive
 * against `null`/`undefined` inputs anyway, since the API is undocumented and
 * not every caller of this module passes schema-validated data.
 *
 * @param name - A conversation summary's `name` field.
 * @returns `true` when the name counts as unnamed (missing, `null`,
 *   `undefined`, empty, or whitespace-only).
 */
function isUnnamed(name: string | null | undefined): boolean {
  return !name || name.trim() === "";
}

/**
 * Pure selection of which conversation summaries count as unnamed, per the
 * spike-recorded definition, optionally narrowed by id membership and/or
 * capped by count.
 *
 * @remarks
 * Filtering order is fixed and matters for `limit`'s meaning: unnamed-ness
 * first, then `opts.ids` membership, then `opts.limit`. The result preserves
 * `summaries`' original relative order throughout -- `opts.ids`' own order is
 * never consulted for ordering, only for membership testing. This keeps the
 * function's output order stable and independent of how a caller happened to
 * list ids.
 *
 * @param summaries - Conversation summaries to filter, e.g. from a list-org
 *   endpoint response. Not mutated.
 * @param opts - Optional id-membership and count constraints; see
 *   {@link SelectUnnamedConversationsOptions}.
 * @returns The subset of `summaries` that are unnamed and (if `opts` was
 *   given) match its constraints, in `summaries`' original order.
 */
export function selectUnnamedConversations(
  summaries: readonly ConversationSummary[],
  opts?: SelectUnnamedConversationsOptions,
): ConversationSummary[] {
  const unnamed = summaries.filter((summary) => isUnnamed(summary.name));

  const idFiltered = opts?.ids
    ? (() => {
        const wantedIds = new Set(opts.ids);
        return unnamed.filter((summary) => wantedIds.has(summary.uuid));
      })()
    : unnamed;

  return opts?.limit !== undefined ? idFiltered.slice(0, opts.limit) : idFiltered;
}

/**
 * Derives a resolve-names candidate for one hydrated conversation.
 *
 * @remarks
 * Wraps {@link deriveConversationTitle}, adding the `status`/`reason`
 * classification the batch planner needs. When derivation succeeds
 * (non-`null` title), `status` is `"resolvable"`. When it fails, the reason
 * is determined by whether ANY message anywhere in the conversation's flat
 * `chat_messages` array (all branches, not just the active one) has sender
 * `"human"`:
 *
 * - None do -> `"no-human-message"` (delegated to {@link isEmptyConversation},
 *   which implements exactly this flat, all-branches check).
 * - At least one does, but {@link deriveConversationTitle} still returned
 *   `null` -> `"empty-after-sanitize"`.
 *
 * @param conversation - A hydrated conversation, typically from the
 *   conversation-detail endpoint.
 * @returns A {@link ResolveNameCandidate} describing this conversation's
 *   rename plan.
 */
export function planRename(conversation: Conversation): ResolveNameCandidate {
  const title = deriveConversationTitle(conversation);

  if (title !== null) {
    return { uuid: conversation.uuid, title, status: "resolvable" };
  }

  const reason = isEmptyConversation(conversation) ? "no-human-message" : "empty-after-sanitize";
  return { uuid: conversation.uuid, title: null, status: "unresolved", reason };
}

/**
 * Reconciles an ambiguous post-write outcome for a rename request by
 * comparing the freshly re-read conversation name against the name that was
 * requested.
 *
 * @remarks
 * "Ambiguous" here means the caller could not tell from the write response
 * alone whether the rename actually landed (e.g. a request that timed out
 * after being sent, or any other transport outcome that leaves the local
 * state uncertain) and had to re-fetch the conversation to find out. This
 * function is the pure comparison step of that reconciliation, given the
 * re-read name:
 *
 * - `currentName` exactly equals `desired` -> `"applied"`: the rename landed.
 * - `currentName` is `null`, `undefined`, empty, or whitespace-only (and does
 *   not exactly equal `desired`) -> `"failed"`: the conversation is still
 *   unnamed, so the write did not take effect.
 * - Any other non-empty `currentName` -> `"concurrent-edit"`: someone (or
 *   something -- e.g. claude.ai's own unreliable server-side auto-titling,
 *   see the rename spike findings) renamed the conversation to a different
 *   value in the interim.
 *
 * Exact-match is checked first, so a `desired` value that is itself empty or
 * whitespace-only (not expected from this module's own callers, which only
 * request non-empty derived titles, but not ruled out for a caller reusing
 * this function directly) still classifies as `"applied"` when it matches
 * `currentName` exactly, rather than falling through to `"failed"`.
 *
 * @param currentName - The conversation's `name` as re-read after the
 *   ambiguous write, or `null`/`undefined` if the re-read could not recover
 *   a value.
 * @param desired - The title that was requested to be written.
 * @returns `"applied"`, `"concurrent-edit"`, or `"failed"`, per the rules
 *   above.
 */
export function classifyAmbiguousRename(
  currentName: string | null | undefined,
  desired: string,
): "applied" | "concurrent-edit" | "failed" {
  if (currentName === desired) {
    return "applied";
  }

  if (isUnnamed(currentName)) {
    return "failed";
  }

  return "concurrent-edit";
}
