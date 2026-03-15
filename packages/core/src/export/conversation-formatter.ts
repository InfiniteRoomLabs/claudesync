import type { ChatMessage } from "../models/types.js";

/**
 * Formats a linear branch of ChatMessages as a readable markdown document.
 *
 * Output format:
 * ```
 * ## Human
 * _2026-01-15T10:30:00Z_
 *
 * Hello, can you help me with...
 *
 * ## Assistant
 * _2026-01-15T10:30:05Z_
 *
 * Of course! Here's how...
 * ```
 *
 * @param messages - Ordered array of ChatMessages (root to leaf), typically
 *   from getLinearBranch().
 * @returns Formatted markdown string.
 */
export function formatConversation(messages: ChatMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  const sections: string[] = [];

  for (const msg of messages) {
    const role = msg.sender === "human" ? "Human" : "Assistant";
    const timestamp = msg.created_at;
    const text = msg.text.trim();

    const lines: string[] = [];
    lines.push(`## ${role}`);
    lines.push(`_${timestamp}_`);
    lines.push("");
    lines.push(text || "_[empty message]_");
    lines.push("");

    sections.push(lines.join("\n"));
  }

  return sections.join("\n");
}
