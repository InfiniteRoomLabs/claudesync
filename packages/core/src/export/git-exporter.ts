import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import type { GitBundle } from "./types.js";

/**
 * Creates a real git repository from a GitBundle.
 *
 * Uses a staging approach: writes to `{outputPath}.tmp`, then renames on
 * success. On failure, cleans up the `.tmp` directory.
 *
 * @param bundle - The GitBundle describing commits to create
 * @param outputPath - Absolute path for the output git repository
 */
export async function exportToGit(
  bundle: GitBundle,
  outputPath: string
): Promise<void> {
  const tmpPath = `${outputPath}.tmp`;

  // Clean up any leftover tmp directory from a previous failed run
  if (fs.existsSync(tmpPath)) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  }

  // Fail if target already exists
  if (fs.existsSync(outputPath)) {
    throw new Error(`Output path already exists: ${outputPath}`);
  }

  try {
    // Initialize git repo
    fs.mkdirSync(tmpPath, { recursive: true });
    await git.init({ fs, dir: tmpPath, defaultBranch: "main" });

    // Replay each commit
    for (const commit of bundle.commits) {
      // Write files
      for (const [filePath, content] of Object.entries(commit.files)) {
        const fullPath = path.join(tmpPath, filePath);
        const dir = path.dirname(fullPath);
        fs.mkdirSync(dir, { recursive: true });

        if (typeof content === "string") {
          fs.writeFileSync(fullPath, content, "utf-8");
        } else {
          fs.writeFileSync(fullPath, content);
        }

        // Stage the file
        await git.add({ fs, dir: tmpPath, filepath: filePath });
      }

      // Create the commit
      const timestamp = Math.floor(
        new Date(commit.timestamp).getTime() / 1000
      );

      await git.commit({
        fs,
        dir: tmpPath,
        message: commit.message,
        author: {
          name: commit.author.name,
          email: commit.author.email,
          timestamp,
          timezoneOffset: 0,
        },
      });
    }

    // Success: rename .tmp to final path
    fs.renameSync(tmpPath, outputPath);
  } catch (error) {
    // Failure: clean up .tmp directory
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
    throw error;
  }
}
