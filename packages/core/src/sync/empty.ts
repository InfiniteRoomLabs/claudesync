import type { Conversation, ConversationSummary } from "../models/types.js";

/**
 * Policy for how to handle a previously-exported conversation that has since
 * become empty (no human turns).
 *
 * @remarks
 * One of three strategies for reconciling an empty conversation with prior
 * sync state. Used by the sync engine to decide whether to re-materialize,
 * keep stale artifacts, or delete the conversation entirely.
 *
 * - `"sync"`: Re-materialize the full conversation artifact bundle (the
 *   conversation should not be skipped, even though it is empty, so the
 *   deletion of all human turns is recorded).
 * - `"retain"`: Keep the existing artifact bundle; the conversation is
 *   empty but its prior state remains on disk for archival purposes.
 * - `"clean"`: Delete the conversation artifact bundle from disk; empty
 *   conversations are never materialized in the first place.
 */
export type OnBecameEmpty = "sync" | "retain" | "clean";

/**
 * Resolved action for one empty conversation, given its prior sync state
 * presence and the configured became-empty policy.
 *
 * @remarks
 * Returned by {@link decideEmptyAction} to tell the sync engine whether to:
 *
 * - `"skip"`: Do not materialize or touch this conversation; no prior state
 *   exists, so there is nothing to sync or clean up.
 * - `"materialize-full"`: Re-materialize the full conversation (e.g., to
 *   record that human turns have been deleted). Prior state existed; the
 *   policy is `"sync"`.
 * - `"retain"`: Keep the existing on-disk artifacts. Prior state existed; the
 *   policy is `"retain"`.
 * - `"clean"`: Delete the on-disk artifacts. Prior state existed; the policy
 *   is `"clean"`.
 */
export type EmptyAction = "skip" | "materialize-full" | "retain" | "clean";

/**
 * Determines whether a conversation is empty (contains no human messages).
 *
 * @param conversation - A conversation object with at least its `chat_messages`
 *   array. Typically a {@link Conversation} hydrated from `GET .../conversations/{uuid}`.
 * @returns `true` if the conversation's complete message tree (all branches)
 *   contains zero messages from sender `"human"`. `false` if at least one human
 *   message exists (including whitespace-only turns, which still count as human
 *   presence).
 *
 * @remarks
 * An empty conversation has zero human-authored turns across the complete,
 * branched message tree. The flat `chat_messages` array includes all messages
 * from all branches, so this predicate correctly identifies empty conversations
 * even when humans have only abandoned branches.
 *
 * This predicate is intended for claude.ai conversations only; it should never
 * be called on neutral seams (e.g., imported external transcripts, where sender
 * semantics may differ).
 */
export function isEmptyConversation(conversation: Pick<Conversation, "chat_messages">): boolean {
  return !conversation.chat_messages.some((m) => m.sender === "human");
}

/**
 * List-level emptiness signal derived from a conversation summary.
 *
 * @param summary - A conversation summary object with at least its
 *   `current_leaf_message_uuid` field. Typically a {@link ConversationSummary}
 *   from `GET .../conversations` (list endpoint).
 * @returns `true` if `current_leaf_message_uuid` is `null` or `undefined`,
 *   implying the conversation has zero messages. `false` otherwise.
 *
 * @remarks
 * A null or undefined `current_leaf_message_uuid` is a spike-verified invariant
 * for the one direction: if a conversation is empty, the API omits (or sets to
 * null) the active leaf pointer. However, the converse is not guaranteed; a
 * non-null leaf does NOT prove the conversation is nonempty (though in practice
 * it almost always does).
 *
 * This predicate is used for list-hiding (e.g., skipping empty conversations
 * in the sync engine's list loop without fetching the full conversation). For
 * definitive emptiness checks, use {@link isEmptyConversation} on the full
 * conversation object.
 */
export function summaryLooksEmpty(summary: Pick<ConversationSummary, "current_leaf_message_uuid">): boolean {
  return summary.current_leaf_message_uuid == null;
}

/**
 * Maps a prior-sync-state presence flag and a became-empty policy to the action
 * the sync engine takes for an empty conversation.
 *
 * @param hasPriorState - `true` if the conversation was previously exported
 *   (sync state exists on disk); `false` if this is the first encounter.
 * @param policy - The {@link OnBecameEmpty} policy governing empty conversations
 *   that previously had exported state.
 * @returns An {@link EmptyAction} value instructing the sync engine how to
 *   handle this conversation.
 *
 * @remarks
 * The decision matrix is:
 *
 * | hasPriorState | policy    | action              |
 * |---------------|-----------|---------------------|
 * | false         | (any)     | "skip"              |
 * | true          | "sync"    | "materialize-full"  |
 * | true          | "retain"  | "retain"            |
 * | true          | "clean"   | "clean"             |
 *
 * No prior state always skips, regardless of policy, because there is nothing
 * to reconcile. With prior state, the policy determines the action: sync
 * re-materializes the full conversation (recording deletions), retain preserves
 * the existing on-disk artifacts, and clean removes them.
 */
export function decideEmptyAction(hasPriorState: boolean, policy: OnBecameEmpty): EmptyAction {
  if (!hasPriorState) return "skip";
  switch (policy) {
    case "sync":
      return "materialize-full";
    case "retain":
      return "retain";
    case "clean":
      return "clean";
  }
}
