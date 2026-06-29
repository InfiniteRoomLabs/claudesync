import type { ChatMessage } from "../models/types.js";

/**
 * A node in the message tree, wrapping a {@link ChatMessage} with the child
 * references that the flat API response does not carry. claude.ai returns
 * messages as a flat array linked only by `parent_message_uuid`; this node is
 * the materialized parent -> children form produced by {@link buildMessageTree}.
 */
export interface MessageTreeNode {
  /** The wrapped message, exactly as returned by the API. */
  message: ChatMessage;
  /**
   * Direct replies to {@link MessageTreeNode.message}, sorted ascending by
   * {@link ChatMessage.index}. More than one child means the conversation
   * branched at this message (e.g. an edited prompt or regenerated reply).
   */
  children: MessageTreeNode[];
}

/**
 * Materializes the parent -> children tree from a flat array of messages.
 *
 * Each message is linked to its parent via `parent_message_uuid`. A root
 * message's `parent_message_uuid` does not match any message's `uuid` (the API
 * uses "" or another sentinel for the first message), so it simply has no
 * parent node to attach to. Children of each node are sorted by
 * {@link ChatMessage.index} so traversal order is deterministic.
 *
 * The returned map owns the node objects; callers walk it with the other helpers
 * here ({@link findLeafMessages}, {@link getLinearBranch}, {@link getAllBranches}).
 *
 * @param messages - The conversation's messages in any order.
 * @returns A map from message `uuid` to its {@link MessageTreeNode}. Root nodes
 *   are those whose `parent_message_uuid` is not a key in the map.
 */
export function buildMessageTree(
  messages: ChatMessage[]
): Map<string, MessageTreeNode> {
  const nodeMap = new Map<string, MessageTreeNode>();

  // First pass: create a node for every message
  for (const message of messages) {
    nodeMap.set(message.uuid, { message, children: [] });
  }

  // Second pass: wire up parent -> child relationships
  for (const node of nodeMap.values()) {
    const parentId = node.message.parent_message_uuid;
    const parentNode = nodeMap.get(parentId);
    if (parentNode) {
      parentNode.children.push(node);
    }
  }

  // Sort children by index for deterministic ordering
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => a.message.index - b.message.index);
  }

  return nodeMap;
}

/**
 * Collects every leaf message -- a node with no children. Each leaf is the tip
 * of one conversation branch, so the leaf count equals the branch count.
 *
 * @param nodeMap - A tree built by {@link buildMessageTree}.
 * @returns The {@link ChatMessage} at each branch tip, in map iteration order.
 */
export function findLeafMessages(
  nodeMap: Map<string, MessageTreeNode>
): ChatMessage[] {
  const leaves: ChatMessage[] = [];
  for (const node of nodeMap.values()) {
    if (node.children.length === 0) {
      leaves.push(node.message);
    }
  }
  return leaves;
}

/**
 * Walks the single root-to-target path by following `parent_message_uuid` links
 * upward from the target and reversing. The target is typically a leaf, but any
 * node works -- the result ends at whatever `targetUuid` names.
 *
 * @param nodeMap - A tree built by {@link buildMessageTree}.
 * @param leafUuid - The `uuid` of the target message (usually a branch tip).
 * @returns The messages from root to target in order, or an empty array when
 *   `leafUuid` is not present in the map.
 */
export function getLinearBranch(
  nodeMap: Map<string, MessageTreeNode>,
  leafUuid: string
): ChatMessage[] {
  const startNode = nodeMap.get(leafUuid);
  if (!startNode) {
    return [];
  }

  // Walk upward from the leaf to the root
  const path: ChatMessage[] = [];
  let current: MessageTreeNode | undefined = startNode;

  while (current) {
    path.push(current.message);
    const parentId = current.message.parent_message_uuid;
    current = nodeMap.get(parentId);
  }

  // Reverse so the result is root -> leaf order
  path.reverse();
  return path;
}

/**
 * Expands the tree into one root-to-leaf branch per leaf. Shared prefixes
 * between branches are duplicated; use {@link findDivergencePoint} to locate
 * where two branches split.
 *
 * @param nodeMap - A tree built by {@link buildMessageTree}.
 * @returns A map keyed by leaf `uuid`, each value the root-to-leaf message array
 *   from {@link getLinearBranch}.
 */
export function getAllBranches(
  nodeMap: Map<string, MessageTreeNode>
): Map<string, ChatMessage[]> {
  const branches = new Map<string, ChatMessage[]>();
  for (const leaf of findLeafMessages(nodeMap)) {
    branches.set(leaf.uuid, getLinearBranch(nodeMap, leaf.uuid));
  }
  return branches;
}

/**
 * Finds the last message both branches share -- the point past which they
 * diverge. Because both inputs are root-to-leaf arrays from
 * {@link getLinearBranch}, their common ancestors form a shared prefix; this
 * returns the `uuid` of the final element of that prefix.
 *
 * @param branchA - A root-to-leaf branch from {@link getLinearBranch}.
 * @param branchB - The other root-to-leaf branch to compare against.
 * @returns The deepest common ancestor's `uuid`, or undefined when the branches
 *   share no common prefix.
 */
export function findDivergencePoint(
  branchA: ChatMessage[],
  branchB: ChatMessage[]
): string | undefined {
  const aUuids = new Set(branchA.map((m) => m.uuid));
  let last: string | undefined;
  for (const msg of branchB) {
    if (aUuids.has(msg.uuid)) {
      last = msg.uuid;
    } else {
      break;
    }
  }
  return last;
}

/**
 * Picks a stable, short, unique label for a leaf by taking the shortest uuid
 * prefix (8, 12, or 16 chars) that no other leaf in the conversation shares.
 * Used to name per-branch outputs (e.g. export file/dir names) without leaking
 * full uuids. The result is stable for a fixed `allLeafUuids` set.
 *
 * @param leafUuid - The leaf `uuid` to label.
 * @param allLeafUuids - Every leaf `uuid` in the conversation, including
 *   `leafUuid`; used to detect prefix collisions.
 * @returns The shortest non-colliding prefix of `leafUuid`, 8 to 16 chars.
 * @throws Error when even the 16-char prefix collides with another leaf
 *   (effectively impossible for real uuids).
 */
export function shortLeafLabel(
  leafUuid: string,
  allLeafUuids: Iterable<string>
): string {
  const others: string[] = [];
  for (const u of allLeafUuids) {
    if (u !== leafUuid) others.push(u);
  }
  for (let len = 8; len <= 16; len += 4) {
    const prefix = leafUuid.slice(0, len);
    if (!others.some((o) => o.startsWith(prefix))) {
      return prefix;
    }
  }
  throw new Error(
    `Cannot produce a unique short label for leaf ${leafUuid} within 16 chars`
  );
}
