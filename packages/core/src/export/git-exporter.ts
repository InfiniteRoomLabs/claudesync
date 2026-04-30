import fs from "node:fs";
import path from "node:path";
import git from "isomorphic-git";
import type { GitBundle, GitBundleCommit } from "./types.js";

const MAIN_BRANCH = "main";

type FileMap = Record<string, string | Uint8Array>;

interface PartitionedCommits {
  /** Commits whose files belong on `main` (root paths + artifacts/). */
  mainCommits: GitBundleCommit[];
  /** Commits per alt branch, keyed by short label. Files have the
   *  `branches/<label>/` prefix stripped. */
  altCommitsByLabel: Map<string, GitBundleCommit[]>;
}

/**
 * Inspects bundle commits and routes their files onto either the main branch
 * (root paths + artifacts/) or a per-leaf alt branch. A commit whose files are
 * a mix is split apart into per-branch sub-commits sharing the original
 * message and author.
 */
function partitionCommits(commits: GitBundleCommit[]): PartitionedCommits {
  const mainCommits: GitBundleCommit[] = [];
  const altCommitsByLabel = new Map<string, GitBundleCommit[]>();

  for (const commit of commits) {
    const mainFiles: FileMap = {};
    const altFilesByLabel = new Map<string, FileMap>();
    let mainSeen = false;

    for (const [filePath, content] of Object.entries(commit.files)) {
      const altMatch = filePath.match(/^branches\/([^/]+)\/(.+)$/);
      if (altMatch) {
        const label = altMatch[1];
        const stripped = altMatch[2];
        let bucket = altFilesByLabel.get(label);
        if (!bucket) {
          bucket = {};
          altFilesByLabel.set(label, bucket);
        }
        bucket[stripped] = content;
      } else {
        mainFiles[filePath] = content;
        mainSeen = true;
      }
    }

    if (mainSeen) {
      mainCommits.push({ ...commit, files: mainFiles });
    }
    for (const [label, files] of altFilesByLabel) {
      const list = altCommitsByLabel.get(label) ?? [];
      list.push({ ...commit, files });
      altCommitsByLabel.set(label, list);
    }
  }

  return { mainCommits, altCommitsByLabel };
}

function toEpochSeconds(timestamp: string): number {
  return Math.floor(new Date(timestamp).getTime() / 1000);
}

async function commitFiles(
  dir: string,
  commit: GitBundleCommit
): Promise<void> {
  for (const [filePath, content] of Object.entries(commit.files)) {
    const fullPath = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    if (typeof content === "string") {
      fs.writeFileSync(fullPath, content, "utf-8");
    } else {
      fs.writeFileSync(fullPath, content);
    }
    await git.add({ fs, dir, filepath: filePath });
  }
  await git.commit({
    fs,
    dir,
    message: commit.message,
    author: {
      name: commit.author.name,
      email: commit.author.email,
      timestamp: toEpochSeconds(commit.timestamp),
      timezoneOffset: 0,
    },
  });
}

/**
 * Removes everything tracked + working tree (except `.git`), used before
 * checking out an alt branch's content from a clean slate.
 */
async function clearWorkingTree(dir: string): Promise<void> {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === ".git") continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  const tracked = await git.listFiles({ fs, dir });
  for (const f of tracked) {
    try { await git.remove({ fs, dir, filepath: f }); } catch {}
  }
}

async function checkoutOrCreateBranch(
  dir: string,
  ref: string,
  startPoint?: string
): Promise<void> {
  const refs = await git.listBranches({ fs, dir });
  if (!refs.includes(ref)) {
    if (startPoint) {
      await git.branch({ fs, dir, ref, object: startPoint });
    } else {
      await git.branch({ fs, dir, ref });
    }
  }
  await git.checkout({ fs, dir, ref, force: true });
}

/**
 * Creates a real git repository from a GitBundle.
 *
 * Single-branch bundles: produces a repo with main + commits in order.
 *
 * Multi-branch bundles: produces a repo with main holding the current branch
 * + artifacts, plus one `alt-<short-label>` ref per alternate branch holding
 * its content. Alt branches are rooted off the initial main commit (git's
 * commit graph is intentionally simpler than the message tree -- the refs
 * exist to address branch contents, not to mirror message ancestry).
 *
 * Uses a staging approach: writes to `{outputPath}.tmp`, then renames on
 * success.
 */
export async function exportToGit(
  bundle: GitBundle,
  outputPath: string
): Promise<void> {
  const tmpPath = `${outputPath}.tmp`;

  if (fs.existsSync(tmpPath)) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  }
  if (fs.existsSync(outputPath)) {
    throw new Error(`Output path already exists: ${outputPath}`);
  }

  try {
    fs.mkdirSync(tmpPath, { recursive: true });
    await git.init({ fs, dir: tmpPath, defaultBranch: MAIN_BRANCH });

    const { mainCommits, altCommitsByLabel } = partitionCommits(bundle.commits);

    for (const commit of mainCommits) {
      await commitFiles(tmpPath, commit);
    }

    let mainHead: string | undefined;
    if (mainCommits.length > 0) {
      mainHead = await git.resolveRef({ fs, dir: tmpPath, ref: MAIN_BRANCH });
    }

    for (const [label, commits] of altCommitsByLabel) {
      const branchRef = `alt-${label}`;
      await checkoutOrCreateBranch(tmpPath, branchRef, mainHead);
      await clearWorkingTree(tmpPath);
      for (const commit of commits) {
        await commitFiles(tmpPath, commit);
      }
    }

    if (mainCommits.length > 0) {
      await git.checkout({ fs, dir: tmpPath, ref: MAIN_BRANCH, force: true });
    }

    fs.renameSync(tmpPath, outputPath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Appends new content onto an existing git repository at `outputPath`.
 * Stages a working copy at `{outputPath}.tmp`, writes one new commit per
 * affected branch, then atomically swaps. Branches not represented in
 * `bundle` are left untouched.
 *
 * isomorphic-git computes the diff naturally: we overwrite the working tree
 * with each branch's bundle files and let `git add` + `commit` figure out
 * what changed.
 */
export async function appendToGit(
  bundle: GitBundle,
  outputPath: string
): Promise<void> {
  if (!fs.existsSync(outputPath)) {
    throw new Error(
      `Cannot append to git repo: ${outputPath} does not exist. Use exportToGit for fresh exports.`
    );
  }

  const tmpPath = `${outputPath}.tmp`;
  if (fs.existsSync(tmpPath)) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  }

  try {
    // Local copy. cp -R is safe here -- single process, no concurrent
    // writers, and we swap atomically at the end.
    fs.cpSync(outputPath, tmpPath, { recursive: true });

    const { mainCommits, altCommitsByLabel } = partitionCommits(bundle.commits);

    if (mainCommits.length > 0) {
      await checkoutOrCreateBranch(tmpPath, MAIN_BRANCH);
      for (const commit of mainCommits) {
        await commitFiles(tmpPath, commit);
      }
    }

    let mainHead: string | undefined;
    try {
      mainHead = await git.resolveRef({ fs, dir: tmpPath, ref: MAIN_BRANCH });
    } catch {
      mainHead = undefined;
    }

    for (const [label, commits] of altCommitsByLabel) {
      const branchRef = `alt-${label}`;
      const existingBranches = await git.listBranches({ fs, dir: tmpPath });
      const isNew = !existingBranches.includes(branchRef);
      await checkoutOrCreateBranch(tmpPath, branchRef, mainHead);
      if (isNew) {
        await clearWorkingTree(tmpPath);
      }
      for (const commit of commits) {
        await commitFiles(tmpPath, commit);
      }
    }

    if (mainCommits.length > 0) {
      await git.checkout({ fs, dir: tmpPath, ref: MAIN_BRANCH, force: true });
    }

    fs.rmSync(outputPath, { recursive: true, force: true });
    fs.renameSync(tmpPath, outputPath);
  } catch (error) {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
    throw error;
  }
}
