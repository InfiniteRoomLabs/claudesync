import fs from "node:fs";
import path from "node:path";
import type { ConversationDiff } from "./diff.js";

export const CHANGELOG_FILENAME = "CHANGELOG.md";

const CHANGELOG_HEADER = [
  "# Changelog",
  "",
  "All sync activity for this conversation, newest first.",
  "",
].join("\n");

/**
 * Renders a single dated section for a sync diff. Returns an empty string if
 * there is nothing to record. Caller is expected to gate isUnchanged.
 *
 * Date is taken as the UTC date (YYYY-MM-DD) of `at`.
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
 * Appends a section to CHANGELOG.md inside `dir`, creating the file (with
 * header) if missing. Newest entries go directly after the header so the file
 * reads newest-first. If a section for the same date already exists, the new
 * entries are inserted at the top of that date's section.
 *
 * Returns true if the file was modified, false if section was empty.
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

function basenameOf(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}
