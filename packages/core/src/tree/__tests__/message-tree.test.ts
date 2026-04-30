import { describe, expect, it } from "vitest";
import {
  buildMessageTree,
  findLeafMessages,
  getLinearBranch,
  getAllBranches,
  findDivergencePoint,
  shortLeafLabel,
} from "../message-tree.js";
import type { ChatMessage } from "../../models/types.js";

/**
 * Helper to create a minimal ChatMessage for testing.
 * Only uuid, parent_message_uuid, index, and sender are meaningful
 * for tree operations; other fields get sensible defaults.
 */
function makeMessage(
  uuid: string,
  parentUuid: string,
  index: number,
  sender: "human" | "assistant" = "human"
): ChatMessage {
  return {
    uuid,
    parent_message_uuid: parentUuid,
    index,
    sender,
    text: `Message ${uuid}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    attachments: [],
    files_v2: [],
    sync_sources: [],
  };
}

describe("buildMessageTree", () => {
  it("builds a tree from a flat list of messages", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      makeMessage("h2", "a1", 2, "human"),
      makeMessage("a3", "h2", 3, "assistant"),
    ];

    const tree = buildMessageTree(messages);

    expect(tree.size).toBe(4);
    expect(tree.get("root")!.children).toHaveLength(1);
    expect(tree.get("root")!.children[0].message.uuid).toBe("a1");
    expect(tree.get("a1")!.children[0].message.uuid).toBe("h2");
    expect(tree.get("h2")!.children[0].message.uuid).toBe("a3");
    expect(tree.get("a3")!.children).toHaveLength(0);
  });

  it("handles branching (multiple children for one parent)", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      // Branch 1: user edits their follow-up
      makeMessage("h2-v1", "a1", 2, "human"),
      // Branch 2: user tries a different follow-up
      makeMessage("h2-v2", "a1", 3, "human"),
    ];

    const tree = buildMessageTree(messages);

    const a1Node = tree.get("a1")!;
    expect(a1Node.children).toHaveLength(2);
    // Children sorted by index
    expect(a1Node.children[0].message.uuid).toBe("h2-v1");
    expect(a1Node.children[1].message.uuid).toBe("h2-v2");
  });

  it("returns an empty map for empty input", () => {
    const tree = buildMessageTree([]);
    expect(tree.size).toBe(0);
  });

  it("sorts children by index", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      // Insert out of order
      makeMessage("c", "root", 5, "human"),
      makeMessage("a", "root", 1, "assistant"),
      makeMessage("b", "root", 3, "human"),
    ];

    const tree = buildMessageTree(messages);
    const rootChildren = tree.get("root")!.children;

    expect(rootChildren[0].message.uuid).toBe("a");
    expect(rootChildren[1].message.uuid).toBe("b");
    expect(rootChildren[2].message.uuid).toBe("c");
  });
});

describe("findLeafMessages", () => {
  it("finds single leaf in a linear conversation", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      makeMessage("h2", "a1", 2, "human"),
    ];

    const tree = buildMessageTree(messages);
    const leaves = findLeafMessages(tree);

    expect(leaves).toHaveLength(1);
    expect(leaves[0].uuid).toBe("h2");
  });

  it("finds multiple leaves in a branching conversation", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      // Branch A
      makeMessage("h2-a", "a1", 2, "human"),
      makeMessage("a3-a", "h2-a", 3, "assistant"),
      // Branch B
      makeMessage("h2-b", "a1", 4, "human"),
      makeMessage("a3-b", "h2-b", 5, "assistant"),
      makeMessage("h4-b", "a3-b", 6, "human"),
    ];

    const tree = buildMessageTree(messages);
    const leaves = findLeafMessages(tree);
    const leafUuids = leaves.map((l) => l.uuid).sort();

    expect(leaves).toHaveLength(2);
    expect(leafUuids).toEqual(["a3-a", "h4-b"]);
  });

  it("returns all messages as leaves when none are connected", () => {
    const messages: ChatMessage[] = [
      makeMessage("orphan-1", "missing-1", 0, "human"),
      makeMessage("orphan-2", "missing-2", 1, "human"),
    ];

    const tree = buildMessageTree(messages);
    const leaves = findLeafMessages(tree);

    expect(leaves).toHaveLength(2);
  });

  it("returns empty array for empty tree", () => {
    const tree = buildMessageTree([]);
    const leaves = findLeafMessages(tree);
    expect(leaves).toHaveLength(0);
  });
});

describe("getLinearBranch", () => {
  it("returns root-to-leaf path for a linear conversation", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      makeMessage("h2", "a1", 2, "human"),
      makeMessage("a3", "h2", 3, "assistant"),
    ];

    const tree = buildMessageTree(messages);
    const branch = getLinearBranch(tree, "a3");

    expect(branch.map((m) => m.uuid)).toEqual(["root", "a1", "h2", "a3"]);
  });

  it("follows the correct branch in a forking conversation", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      // Branch A
      makeMessage("h2-a", "a1", 2, "human"),
      makeMessage("a3-a", "h2-a", 3, "assistant"),
      // Branch B
      makeMessage("h2-b", "a1", 4, "human"),
      makeMessage("a3-b", "h2-b", 5, "assistant"),
    ];

    const tree = buildMessageTree(messages);

    const branchA = getLinearBranch(tree, "a3-a");
    expect(branchA.map((m) => m.uuid)).toEqual(["root", "a1", "h2-a", "a3-a"]);

    const branchB = getLinearBranch(tree, "a3-b");
    expect(branchB.map((m) => m.uuid)).toEqual(["root", "a1", "h2-b", "a3-b"]);
  });

  it("returns empty array for unknown uuid", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
    ];

    const tree = buildMessageTree(messages);
    const branch = getLinearBranch(tree, "nonexistent");

    expect(branch).toEqual([]);
  });

  it("returns single-element array for root message", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
    ];

    const tree = buildMessageTree(messages);
    const branch = getLinearBranch(tree, "root");

    expect(branch).toEqual([messages[0]]);
  });

  it("works with a mid-conversation node (not a leaf)", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      makeMessage("h2", "a1", 2, "human"),
      makeMessage("a3", "h2", 3, "assistant"),
    ];

    const tree = buildMessageTree(messages);
    const branch = getLinearBranch(tree, "a1");

    expect(branch.map((m) => m.uuid)).toEqual(["root", "a1"]);
  });
});

describe("getAllBranches", () => {
  it("returns one branch per leaf in a forked tree", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      makeMessage("h2-v1", "a1", 2, "human"),
      makeMessage("h2-v2", "a1", 3, "human"),
      makeMessage("a3-v2", "h2-v2", 4, "assistant"),
    ];
    const tree = buildMessageTree(messages);
    const branches = getAllBranches(tree);
    expect(branches.size).toBe(2);
    expect(branches.has("h2-v1")).toBe(true);
    expect(branches.has("a3-v2")).toBe(true);
    expect(branches.get("h2-v1")!.map((m) => m.uuid)).toEqual([
      "root",
      "a1",
      "h2-v1",
    ]);
    expect(branches.get("a3-v2")!.map((m) => m.uuid)).toEqual([
      "root",
      "a1",
      "h2-v2",
      "a3-v2",
    ]);
  });
});

describe("findDivergencePoint", () => {
  it("finds the deepest shared ancestor between two branches", () => {
    const messages: ChatMessage[] = [
      makeMessage("root", "sentinel", 0, "human"),
      makeMessage("a1", "root", 1, "assistant"),
      makeMessage("h2-v1", "a1", 2, "human"),
      makeMessage("h2-v2", "a1", 3, "human"),
      makeMessage("a3-v2", "h2-v2", 4, "assistant"),
    ];
    const tree = buildMessageTree(messages);
    const v1 = getLinearBranch(tree, "h2-v1");
    const v2 = getLinearBranch(tree, "a3-v2");
    expect(findDivergencePoint(v1, v2)).toBe("a1");
  });

  it("returns undefined when branches share no ancestor", () => {
    const m1 = makeMessage("a", "sentinel", 0);
    const m2 = makeMessage("b", "sentinel", 1);
    expect(findDivergencePoint([m1], [m2])).toBeUndefined();
  });
});

describe("shortLeafLabel", () => {
  it("returns 8-char prefix when unique", () => {
    expect(shortLeafLabel("019ddeab-d142", ["019ddea7-ef2a"])).toBe("019ddeab");
  });

  it("falls back to 12 chars when 8 chars collide", () => {
    expect(
      shortLeafLabel("019ddeab-d142-7b87-8a6a", [
        "019ddeab-7716-7019-93f1",
      ]),
    ).toBe("019ddeab-d14");
  });

  it("throws when no unique prefix exists within 16 chars", () => {
    expect(() =>
      shortLeafLabel("aaaa-bbbb-cccc-dddd", ["aaaa-bbbb-cccc-dddd-shared"]),
    ).toThrow();
  });
});
