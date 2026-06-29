import fs from "node:fs";
import path from "node:path";
import type { ConversationDiff } from "./diff.js";

/**
 * Name of the human-readable sync log written into each conversation
 * directory. Treated as an always-preserve file by {@link writeTreeWithPreserve}
 * so it accumulates history across re-syncs rather than being overwritten.
 */
export const CHANGELOG_FILENAME = "CHANGELOG.md";

/** Fixed header prepended when a CHANGELOG.md is first created. */
const CHANGELOG_HEADER = [
  "# Changelog",
  "",
  "All sync activity for this conversation, newest first.",
  "",
].join("\n");

/**
 * Renders a single dated Markdown section describing one sync's diff. Initial
 * syncs produce an "Initial export" summary; subsequent syncs produce Added/
 * Changed/Removed subsections covering branches, artifacts, rename, and model
 * change.
 *
 * @param diff - The diff to render. Callers should gate on
 * {@link ConversationDiff.isUnchanged} before calling; for an unchanged diff
 * this still returns "".
 * @param at - Timestamp whose UTC date (YYYY-MM-DD) heads the section.
 * @returns The section text (with trailing newline), or "" when the diff
 * records no reportable change.
 */
export function renderChangelogSection(
  diff: ConversationDiff,
  at: Date
): string {
  const date = at.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`## ${date}`);
  lines.push("");

  if (diff.isInitial) {
    lines.push("### Initial export");
    lines.push("");
    const branchCount = diff.branches.length;
    const altCount = diff.branches.filter((b) => !b.isMain).length;
    const totalMsgs = diff.branches.reduce(
      (sum, b) => sum + b.messages.length,
      0
    );
    lines.push(`- ${branchCount} branch(es) (${altCount} alternate).`);
    lines.push(`- ${totalMsgs} message(s) across all branches.`);
    if (diff.artifacts.added.length > 0) {
      lines.push(`- ${diff.artifacts.added.length} artifact(s).`);
    }
    lines.push("");
    return lines.join("\n");
  }

  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const b of diff.branches) {
    if (b.isNew) {
      const branchTag = b.isMain ? "main" : `alt-${b.shortLabel}`;
      added.push(
        `- Branch \`${branchTag}\` discovered (${b.messages.length} message(s), leaf \`${b.leafUuid}\`).`
      );
    } else if (b.hasNewMessages) {
      const branchTag = b.isMain ? "current branch" : `branch alt-${b.shortLabel}`;
      const range = b.newMessageIndices.length === 1
        ? `index ${b.newMessageIndices[0]}`
        : `indices ${b.newMessageIndices[0]}-${b.newMessageIndices[b.newMessageIndices.length - 1]}`;
      changed.push(
        `- ${b.newMessageIndices.length} new message(s) on ${branchTag} (${range}).`
      );
    }
  }

  for (const a of diff.artifacts.added) {
    added.push(`- Artifact \`${basenameOf(a.path)}\` (${a.size} bytes).`);
  }
  for (const a of diff.artifacts.changed) {
    changed.push(
      `- Artifact \`${basenameOf(a.path)}\` updated (${a.prev_size} -> ${a.size} bytes).`
    );
  }
  for (const a of diff.artifacts.removed) {
    removed.push(`- Artifact \`${basenameOf(a.path)}\` removed.`);
  }

  if (diff.metadata.renamed) {
    changed.push(
      `- Conversation renamed: \`${diff.metadata.renamed.from}\` -> \`${diff.metadata.renamed.to}\`.`
    );
  }
  if (diff.metadata.modelChanged) {
    changed.push(
      `- Model changed: \`${diff.metadata.modelChanged.from ?? "unknown"}\` -> \`${diff.metadata.modelChanged.to ?? "unknown"}\`.`
    );
  }

  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    return "";
  }

  if (added.length > 0) {
    lines.push("### Added");
    lines.push(...added);
    lines.push("");
  }
  if (changed.length > 0) {
    lines.push("### Changed");
    lines.push(...changed);
    lines.push("");
  }
  if (removed.length > 0) {
    lines.push("### Removed");
    lines.push(...removed);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Appends a rendered section to {@link CHANGELOG_FILENAME} inside `dir`,
 * creating the file (with {@link CHANGELOG_HEADER}) if missing. New entries are
 * inserted directly after the header so the file reads newest-first. If a
 * section for the same date already exists, the two bodies are merged under a
 * single date heading rather than stacking duplicate `## YYYY-MM-DD` headings.
 *
 * @param dir - Conversation directory to write the changelog into.
 * @param section - A section produced by {@link renderChangelogSection}. An
 * empty or whitespace-only section is a no-op.
 * @returns True if the file was written, false if `section` was empty.
 */
export function appendChangelog(dir: string, section: string): boolean {
  if (!section.trim()) return false;

  const filePath = path.join(dir, CHANGELOG_FILENAME);
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : CHANGELOG_HEADER;

  const headerEnd = existing.indexOf("\n## ");
  let head: string;
  let rest: string;
  if (headerEnd === -1) {
    head = existing.endsWith("\n") ? existing : existing + "\n";
    rest = "";
  } else {
    head = existing.slice(0, headerEnd + 1);
    rest = existing.slice(headerEnd + 1);
  }

  // Section starts with "## YYYY-MM-DD\n\n...". Extract date.
  const dateMatch = section.match(/^## (\d{4}-\d{2}-\d{2})\n/);
  if (!dateMatch) {
    // Defensive: just prepend.
    fs.writeFileSync(filePath, head + section + rest, "utf-8");
    return true;
  }
  const date = dateMatch[1];

  // If rest already starts with the same date heading, merge the bodies so we
  // do not stack multiple "## 2026-04-30" sections in a single day.
  const sameDayPrefix = `## ${date}\n`;
  if (rest.startsWith(sameDayPrefix)) {
    const sectionBody = section.slice(`## ${date}\n\n`.length);
    const restWithoutHeading = rest.slice(sameDayPrefix.length).replace(/^\n/, "");
    const merged = `## ${date}\n\n${sectionBody.trimEnd()}\n\n${restWithoutHeading}`;
    fs.writeFileSync(filePath, head + merged, "utf-8");
  } else {
    fs.writeFileSync(filePath, head + section + rest, "utf-8");
  }
  return true;
}

/** Returns the final POSIX path segment of `p` (its basename), or `p` itself if it has none. */
function basenameOf(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}
