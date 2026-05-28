import { resolve, dirname } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { Project, ProjectDoc } from "../models/types.js";
import type { GitBundle, GitBundleCommit } from "../export/types.js";
import { exportToGit } from "../export/git-exporter.js";
import { replaceWithPreserve, expandPreserveForProject } from "./files-mode.js";
import { displayName } from "../util/naming.js";
import type { ExportFormat } from "./incremental.js";

/**
 * One fetched-and-built conversation belonging to a project. `index` is the
 * conversation's original position in the project's conversation list; it is
 * used to emit commits in a deterministic order regardless of the order in
 * which parallel fetches completed. `commits` are the conversation-level
 * commits straight from its GitBundle (not yet remapped under conversations/).
 */
export interface ProjectConvBuilt {
  index: number;
  slug: string;
  commits: GitBundleCommit[];
}

/**
 * Assemble a project's repo bundle: a leading commit with the project README +
 * knowledge docs, then each conversation's commits remapped under
 * `conversations/<slug>/`. Conversations are emitted in `index` order so git
 * history is stable across runs.
 */
export function assembleProjectBundle(
  project: Project,
  docs: ProjectDoc[],
  builtConvs: ProjectConvBuilt[],
  author: { name: string; email: string },
  exportedAt: string
): GitBundle {
  const label = displayName(project.name, project.uuid);
  const commits: GitBundleCommit[] = [];

  const projectFiles: Record<string, string | Uint8Array> = {};
  projectFiles["README.md"] = buildProjectReadme(
    project,
    docs.length,
    builtConvs.length
  );
  for (const doc of docs) {
    const safeName = doc.file_name.replace(/[/\\]/g, "_");
    projectFiles[`knowledge/${safeName}`] = doc.content;
  }
  commits.push({
    message: `Export project: ${label}`,
    timestamp: project.created_at,
    author,
    files: projectFiles,
  });

  const ordered = [...builtConvs].sort((a, b) => a.index - b.index);
  for (const conv of ordered) {
    const convDir = `conversations/${conv.slug}`;
    for (const commit of conv.commits) {
      const remappedFiles: Record<string, string | Uint8Array> = {};
      for (const [p, content] of Object.entries(commit.files)) {
        remappedFiles[`${convDir}/${p}`] = content;
      }
      commits.push({ ...commit, files: remappedFiles });
    }
  }

  return {
    metadata: {
      conversationId: project.uuid,
      conversationName: label,
      model: null,
      createdAt: project.created_at,
      exportedAt,
    },
    commits,
  };
}

/**
 * Write an assembled project bundle to disk. For `json`, dumps a single file.
 * For `git`/`files`, rebuilds the tree from scratch through replaceWithPreserve
 * so locally-added files (project-root and nested per-conversation INDEX.md,
 * notes, etc.) survive the re-sync. Moved verbatim from the CLI so the scheduler
 * and CLI share one implementation.
 */
export async function writeProjectBundle(
  bundle: GitBundle,
  outputPath: string,
  format: ExportFormat,
  preserve: readonly string[]
): Promise<void> {
  if (format === "json") {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(
      outputPath + ".json",
      JSON.stringify(bundle, null, 2),
      "utf-8"
    );
    return;
  }
  await replaceWithPreserve({
    outputPath,
    writeFresh: async () => {
      await exportToGit(bundle, outputPath);
      if (format === "files") {
        rmSync(resolve(outputPath, ".git"), { recursive: true, force: true });
      }
    },
    preserveGlobs: expandPreserveForProject(preserve),
  });
}

export function buildProjectReadme(
  project: Pick<
    Project,
    "name" | "uuid" | "description" | "created_at" | "updated_at"
  >,
  docCount: number,
  convCount: number
): string {
  const lines: string[] = [];
  lines.push(`# ${displayName(project.name, project.uuid)}`);
  lines.push("");
  if (project.description) {
    lines.push(project.description);
    lines.push("");
  }
  lines.push(`- **Project ID:** ${project.uuid}`);
  lines.push(`- **Created:** ${project.created_at}`);
  lines.push(`- **Updated:** ${project.updated_at}`);
  lines.push(`- **Knowledge docs:** ${docCount}`);
  lines.push(`- **Conversations:** ${convCount}`);
  lines.push("");
  lines.push("## Structure");
  lines.push("");
  lines.push("```");
  lines.push("knowledge/          # Project knowledge documents");
  lines.push("conversations/      # Exported conversations with artifacts");
  lines.push("```");
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Exported by [ClaudeSync](https://github.com/infiniteroomlabs/claudesync)"
  );
  lines.push("");
  return lines.join("\n");
}
