import type { ChatMessage } from "../models/types.js";

/**
 * A node in the message tree, wrapping a ChatMessage with child references.
 */
export interface MessageTreeNode {
  message: ChatMessage;
  children: MessageTreeNode[];
}

/**
 * Builds a tree structure from a flat array of ChatMessages.
 *
 * Messages are linked via `parent_message_uuid`. The root message has a
 * `parent_message_uuid` that does not correspond to any other message's uuid
 * (the API uses a sentinel value for the first message).
 *
 * @returns A Map from message uuid to its MessageTreeNode. To find root nodes,
 *   look for nodes whose parent_message_uuid is not a key in the map.
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
 * Finds all leaf messages -- messages that have no children in the tree.
 * Each leaf represents the tip of a conversation branch.
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
 * Returns the linear path from the root to a specific leaf message,
 * following parent_message_uuid links upward and then reversing.
 *
 * @param nodeMap - The tree built by buildMessageTree()
 * @param leafUuid - The uuid of the target leaf message
 * @returns Ordered array of ChatMessages from root to the specified leaf,
 *   or an empty array if the leafUuid is not found in the tree.
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
 * Returns one linear branch (root -> leaf) per leaf in the tree.
 * Keys are leaf message uuids, values are the message arrays.
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
 * Finds the deepest message uuid shared by both branches (the divergence
 * point). Branches are expected as root-to-leaf arrays from getLinearBranch().
 *
 * Returns undefined if the branches share no ancestor.
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
 * Picks a stable, short, unique label for a leaf uuid given a set of all leaf
 * uuids in the same conversation. Starts at 8 characters and grows until the
 * prefix is unique within the set. Caps at 16 characters to keep names
 * readable; throws if even 16 chars collide (extremely unlikely).
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
