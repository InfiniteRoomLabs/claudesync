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
