import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ClaudeSyncClient } from "../client/client.js";
import { RateLimitError } from "../client/errors.js";
import type {
  ConversationSummary,
  Project,
  ProjectDoc,
} from "../models/types.js";
import { fetchAndBuild, type FetchAndBuildResult } from "./fetch.js";
import { syncConversation, type ExportFormat } from "./incremental.js";
import type { OnBecameEmpty } from "./empty.js";
import {
  assembleProjectBundle,
  writeProjectBundle,
  type ProjectConvBuilt,
} from "./project-sync.js";
import { safeSlug, displayName, disambiguateSlugs } from "../util/naming.js";
import { MinPriorityQueue } from "../concurrency/priority-queue.js";
import { WorkerPool, type PoolTask } from "../concurrency/worker-pool.js";
import type { AdaptiveController } from "../concurrency/controller.js";

/**
 * Discriminated union of progress notifications emitted by {@link runOrgSync}
 * via {@link RunOrgSyncOptions.onProgress}. The `type` field is the
 * discriminant. These drive CLI/MCP progress UIs; the scheduler itself does no
 * printing. Every event is best-effort and fire-and-forget -- a slow or
 * throwing consumer must not be assumed to block the sync.
 */
export type ProgressEvent =
  /** Emitted once at the start, after the org's projects and conversations are listed. */
  | {
      type: "org-start";
      /** Number of projects discovered in the org. */
      projectCount: number;
      /** Total conversations in the org (project-attached plus standalone). */
      conversationCount: number;
    }
  /** A project's discovery finished and its conversations are about to be fetched. */
  | {
      type: "project-start";
      /** Human-readable project label from {@link displayName}. */
      project: string;
      /** Count of project knowledge docs that will be bundled. */
      docs: number;
      /** Count of conversations fanned out for this project. */
      conversations: number;
    }
  /** A project's bundle was assembled and written to disk. */
  | {
      type: "project-done";
      /** Human-readable project label from {@link displayName}. */
      project: string;
    }
  /** A project was skipped because it already exists on disk under `--skip-existing`. */
  | {
      type: "project-skipped";
      /** Human-readable project label from {@link displayName}. */
      project: string;
    }
  /** A single conversation finished (project-attached or standalone). */
  | {
      type: "conv-done";
      /** Whether the conversation belongs to a project or is standalone. */
      kind: "project" | "standalone";
      /** What happened, e.g. `"exported"` for project convs or the standalone sync action. */
      action: string;
      /** Human-readable conversation label from {@link displayName}. */
      displayName: string;
      /** Running count of conversations resolved so far. */
      completed: number;
      /** Total conversations expected; grows as discovery enqueues more work. */
      total: number;
    }
  /** A rate limit was hit; the offending task will be retried or given up on. */
  | {
      type: "throttle";
      /** Current adaptive concurrency limit at throttle time. */
      limit: number;
      /** Seconds the client intends to wait before resuming, from the rate-limit response. */
      resumeInSec: number;
    }
  /** A task failed terminally (retries exhausted or a non-retryable error). */
  | {
      type: "error";
      /** Human-readable label of the failed task. */
      displayName: string;
      /** Error message text. */
      message: string;
    };

/** Configuration for a single {@link runOrgSync} invocation over one org. */
export interface RunOrgSyncOptions {
  /** Destination directory root; `projects/` and `conversations/` are created under it. */
  outputRoot: string;
  /** On-disk export format ({@link ExportFormat}): `git`, `files`, or `json`. */
  format: ExportFormat;
  /** Git author name stamped onto generated commits. */
  authorName: string;
  /** Git author email stamped onto generated commits. */
  authorEmail: string;
  /** Skip fetching conversation artifacts (the wiggle filesystem), which is faster. */
  skipArtifacts?: boolean;
  /** Skip any project/conversation whose output directory already exists. */
  skipExisting?: boolean;
  /** Skip rewriting a standalone conversation whose content is unchanged since last sync. */
  skipSame?: boolean;
  /** Glob patterns of locally-added files to preserve across a re-sync overwrite. */
  preserve?: string[];
  /** Shared adaptive controller. MUST be the same instance the client uses. */
  controller: AdaptiveController;
  /** Optional per-project concurrency cap. Unset = no cap. */
  projectConcurrency?: number;
  /** Requeue attempts on RateLimitError before giving up on a task. */
  maxRetries: number;
  /** Cancels the run; in-flight tasks are swallowed and the pool shuts down. */
  signal?: AbortSignal;
  /** Callback invoked for each {@link ProgressEvent}. */
  onProgress?: (e: ProgressEvent) => void;
  /**
   * Skip conversations with zero human messages instead of exporting an
   * empty bundle for them. Defaults to `true` (same default as
   * {@link SyncConversationOptions.skipEmpty}). Threaded into every
   * standalone {@link syncConversation} call; project conversations are
   * detected the same way (via {@link fetchAndBuild}'s `detectEmpty`) but
   * have no per-conversation persisted state to consult, so an empty
   * project conversation is always excluded from its project's bundle when
   * this is `true` -- see {@link onBecameEmpty}'s doc for why the other
   * policies are unreachable there.
   */
  skipEmpty?: boolean;
  /**
   * Policy applied to a conversation found empty when prior sync state
   * exists; see {@link OnBecameEmpty} for what each value does. Defaults to
   * `"sync"`. Fully honored for standalone conversations, which persist
   * per-conversation sync state and pass this straight through to
   * {@link syncConversation}. Project conversations have no equivalent
   * persisted state -- a project's bundle is always fully rebuilt from the
   * conversations fetched in the current run (see `exportToGit`, which
   * never appends) -- so `decideEmptyAction` is always called with
   * `hasPriorState: false` for them, which only ever resolves to `"skip"`.
   * This option is still accepted for project conversations for API
   * symmetry with the standalone path and to leave room for a future task
   * that adds per-project-conversation state.
   */
  onBecameEmpty?: OnBecameEmpty;
}

/** Summary counts returned by {@link runOrgSync} after the pool drains. */
export interface RunOrgSyncResult {
  /** Number of projects discovered (whether written, skipped, or partially failed). */
  projects: number;
  /** Number of standalone (non-project) conversations enqueued for sync. */
  standalone: number;
  /** Number of tasks that failed terminally. */
  errors: number;
  /**
   * Number of conversations (standalone plus project-attached) skipped as
   * `"skipped-empty"`: zero human messages and no prior sync state to
   * reconcile. Excluded from any project bundle; no directory or state
   * written for standalone ones.
   */
  skippedEmpty: number;
  /**
   * Number of standalone conversations resolved as `"retained-stale"`:
   * became empty, prior state existed, and {@link RunOrgSyncOptions.onBecameEmpty}
   * is `"retain"`. Always `0` for project conversations -- see
   * {@link RunOrgSyncOptions.onBecameEmpty}'s doc for why that policy is
   * unreachable there.
   */
  retainedStale: number;
  /**
   * Number of standalone conversations resolved as `"cleaned-empty"`:
   * became empty, prior state existed, and {@link RunOrgSyncOptions.onBecameEmpty}
   * is `"clean"`. Always `0` for project conversations -- see
   * {@link RunOrgSyncOptions.onBecameEmpty}'s doc for why that policy is
   * unreachable there.
   */
  cleanedEmpty: number;
}

/**
 * Queue priority bands, lowest value served first. Discovery runs ahead of the
 * conversations it spawns, and project conversations run ahead of standalone
 * ones so standalone work only fills leftover worker slots once discovery is
 * complete. See {@link MinPriorityQueue}.
 */
const PRIORITY = { discovery: 0, projectConv: 1, standalone: 2 } as const;

/** Work item: list one project's docs and conversations, then fan out its convs. */
interface DiscoveryTask {
  /** Discriminant tag. */
  kind: "discovery";
  /** The project to discover. */
  project: Project;
  /** Retry count consumed on RateLimitError requeue, capped by `maxRetries`. */
  attempts: number;
}
/** Work item: fetch and build one conversation that belongs to a project. */
interface ProjectConvTask {
  /** Discriminant tag. */
  kind: "project-conv";
  /** UUID of the owning project, keying its {@link ProjectAccumulator}. */
  projectId: string;
  /** Summary of the conversation to fetch. */
  conv: ConversationSummary;
  /** Original position in the project's conversation list, for stable commit ordering. */
  index: number;
  /** Retry count consumed on RateLimitError requeue, capped by `maxRetries`. */
  attempts: number;
}
/** Work item: sync one standalone conversation directly to its own directory. */
interface StandaloneTask {
  /** Discriminant tag. */
  kind: "standalone";
  /** Summary of the conversation to sync. */
  conv: ConversationSummary;
  /** Retry count consumed on RateLimitError requeue, capped by `maxRetries`. */
  attempts: number;
}
/** Any unit of work the scheduler's queue and worker pool handle. */
type Task = DiscoveryTask | ProjectConvTask | StandaloneTask;

/**
 * Per-project mutable state collected while its conversations are fetched in
 * parallel. The project bundle is assembled and written only once `outstanding`
 * reaches zero (see {@link settleProjectConv}), so all conversation fetches
 * complete before the single off-the-rate-limited-path disk write.
 */
interface ProjectAccumulator {
  /** The project being accumulated. */
  project: Project;
  /** Knowledge docs fetched during discovery, committed ahead of conversations. */
  docs: ProjectDoc[];
  /** Built conversation bundles gathered as fetches complete; order-independent. */
  built: ProjectConvBuilt[];
  /** Conversations still pending; the project finalizes when this hits zero. */
  outstanding: number;
  /** uuid -> collision-safe slug for this project's conversations. */
  convSlugs: Map<string, string>;
}

/**
 * Parallel org sync. Walks orgs -> projects -> conversations through a single
 * adaptive worker pool. Projects are discovered first (priority 0); each
 * discovery fans out its conversations (priority 1); once all discovery is done
 * the standalone conversations (priority 2) are enqueued so leftover worker
 * slots pick them up. Per-project bundle assembly + disk writes happen at a
 * barrier when a project's last conversation fetch completes -- off the
 * rate-limited path. See docs/superpowers/specs and the plan for the rationale.
 *
 * @param client - Authenticated claude.ai API client; shares its rate-limit
 *   controller with {@link RunOrgSyncOptions.controller}.
 * @param orgId - Organization UUID to sync.
 * @param options - Run configuration; see {@link RunOrgSyncOptions}.
 * @returns Counts of projects, standalone conversations, terminal errors, and
 *   the three empty-conversation outcomes (skipped/retained/cleaned); see
 *   {@link RunOrgSyncResult}.
 */
export async function runOrgSync(
  client: ClaudeSyncClient,
  orgId: string,
  options: RunOrgSyncOptions
): Promise<RunOrgSyncResult> {
  const {
    outputRoot,
    format,
    authorName,
    authorEmail,
    controller,
    maxRetries,
    signal,
  } = options;
  const author = { name: authorName, email: authorEmail };
  const preserve = options.preserve ?? [];
  /** Per-project in-flight cap; unbounded when {@link RunOrgSyncOptions.projectConcurrency} is unset. */
  const cap = options.projectConcurrency ?? Number.POSITIVE_INFINITY;
  /** Forward a progress event to the optional consumer; a no-op when none is set. */
  const emit = (e: ProgressEvent) => options.onProgress?.(e);

  const [projects, allConversations] = await Promise.all([
    client.listProjects(orgId),
    client.listConversationsAll(orgId),
  ]);
  // Collision-safe slugs per directory namespace (see disambiguateSlugs).
  // Projects share `projects/<slug>`; standalone convs share
  // `conversations/<slug>`; each project's convs share their own namespace
  // (computed per-project in runDiscovery).
  const projectSlugs = disambiguateSlugs(projects);
  /** uuid -> disambiguated slug for standalone convs; populated in {@link enqueueStandalone}. */
  let standaloneSlugs = new Map<string, string>();
  /**
   * Look up a precomputed collision-safe slug, falling back to a fresh
   * {@link safeSlug} when the uuid is not in the map.
   *
   * @param m - Slug map for the relevant directory namespace.
   * @param name - Display name, possibly null/undefined.
   * @param uuid - Stable identifier used as the fallback slug seed.
   * @returns The filesystem-safe slug for this entity.
   */
  const slugFor = (m: Map<string, string>, name: string | null | undefined, uuid: string) =>
    m.get(uuid) ?? safeSlug(name, uuid);
  emit({
    type: "org-start",
    projectCount: projects.length,
    conversationCount: allConversations.length,
  });

  /** Single priority queue holding every {@link Task} kind. */
  const queue = new MinPriorityQueue<Task>();
  /** UUIDs known to belong to a project, so standalone selection can exclude them. */
  const projectConvUuids = new Set<string>();
  /** projectId -> count of its conversations currently running, enforced against `cap`. */
  const inFlightByProject = new Map<string, number>();
  /** projectId -> live {@link ProjectAccumulator}; removed once the project is finalized. */
  const accs = new Map<string, ProjectAccumulator>();

  /** Discovery tasks not yet resolved; the standalone barrier opens at zero. */
  let discoveryOutstanding = 0;
  /** True once standalone work has been enqueued, gating the pool's done check. */
  let standaloneEnqueued = false;
  /** Conversations resolved so far, reported as `completed` in `conv-done`. */
  let convCompleted = 0;
  /** Conversations expected; grows as discovery and the standalone barrier enqueue work. */
  let convTotal = 0;
  /** Number of standalone conversations, returned in {@link RunOrgSyncResult}. */
  let standaloneCount = 0;
  /** Terminal failure count, returned in {@link RunOrgSyncResult}. */
  let errors = 0;
  /** Running total for {@link RunOrgSyncResult.skippedEmpty}. */
  let skippedEmpty = 0;
  /** Running total for {@link RunOrgSyncResult.retainedStale}. */
  let retainedStale = 0;
  /** Running total for {@link RunOrgSyncResult.cleanedEmpty}. */
  let cleanedEmpty = 0;

  /**
   * Map a task to its queue priority band.
   *
   * @param task - The task to classify.
   * @returns The {@link PRIORITY} value for re-enqueueing on retry.
   */
  const priorityOf = (task: Task): number =>
    task.kind === "discovery"
      ? PRIORITY.discovery
      : task.kind === "project-conv"
        ? PRIORITY.projectConv
        : PRIORITY.standalone;

  /**
   * Human-readable label for a task, used in `error` progress events.
   *
   * @param task - The task to label.
   * @returns The project or conversation display name.
   */
  const labelOf = (task: Task): string =>
    task.kind === "discovery"
      ? displayName(task.project.name, task.project.uuid)
      : displayName(task.conv.name, task.conv.uuid);

  /**
   * Compute the standalone (non-project) conversation set and enqueue it at the
   * lowest priority. Runs once, after all discovery resolves, so any conv a
   * project claimed is excluded via {@link projectConvUuids} rather than being
   * misfiled as standalone. Also fixes the standalone slug namespace and count.
   */
  function enqueueStandalone(): void {
    standaloneEnqueued = true;
    const standalone = allConversations.filter(
      (c) => !c.project_uuid && !projectConvUuids.has(c.uuid)
    );
    standaloneSlugs = disambiguateSlugs(standalone);
    standaloneCount = standalone.length;
    for (const conv of standalone) {
      convTotal += 1;
      queue.push({ kind: "standalone", conv, attempts: 0 }, PRIORITY.standalone);
    }
  }

  /**
   * Mark one discovery task resolved and, when the last one clears, open the
   * standalone barrier exactly once. Called on both discovery success and
   * terminal failure so a failed discovery cannot strand the barrier closed.
   */
  function finishDiscovery(): void {
    discoveryOutstanding -= 1;
    if (discoveryOutstanding === 0 && !standaloneEnqueued) {
      enqueueStandalone();
    }
  }

  /**
   * Assemble and write a project's bundle, then emit `project-done`. Idempotent
   * per project: the accumulator is removed up front, so a duplicate call (no
   * accumulator) is a no-op. This is the off-the-rate-limited-path disk write
   * that runs at the per-project barrier.
   *
   * @param projectId - UUID of the project to finalize.
   */
  async function finalizeProject(projectId: string): Promise<void> {
    const acc = accs.get(projectId);
    if (!acc) return;
    accs.delete(projectId);
    const bundle = assembleProjectBundle(
      acc.project,
      acc.docs,
      acc.built,
      author,
      new Date().toISOString()
    );
    const projectPath = resolve(
      outputRoot,
      "projects",
      slugFor(projectSlugs, acc.project.name, acc.project.uuid)
    );
    await writeProjectBundle(bundle, projectPath, format, preserve);
    emit({
      type: "project-done",
      project: displayName(acc.project.name, acc.project.uuid),
    });
  }

  /**
   * Run one project's discovery: fetch its knowledge docs and conversation
   * list, register a {@link ProjectAccumulator}, and fan its conversations out
   * as priority-1 tasks. A project with zero conversations is finalized
   * immediately. Under `--skip-existing` with an existing output directory, the
   * conversations are still listed (so they are not later misclassified as
   * standalone) but docs, fan-out, and the write are skipped. Always calls
   * {@link finishDiscovery} so the standalone barrier advances.
   *
   * @param task - The discovery task identifying the project.
   */
  async function runDiscovery(task: DiscoveryTask): Promise<void> {
    const { project } = task;
    const projectPath = resolve(
      outputRoot,
      "projects",
      slugFor(projectSlugs, project.name, project.uuid)
    );

    // --skip-existing: still list conversations so they aren't misclassified as
    // standalone, but skip docs fetch, conv fans-out, and the write.
    if (options.skipExisting && existsSync(projectPath)) {
      const projConvs = await client.getProjectConversations(
        orgId,
        project.uuid
      );
      for (const c of projConvs) projectConvUuids.add(c.uuid);
      emit({
        type: "project-skipped",
        project: displayName(project.name, project.uuid),
      });
      finishDiscovery();
      return;
    }

    const docs = await client.getProjectDocs(orgId, project.uuid);
    const projConvs = await client.getProjectConversations(orgId, project.uuid);
    for (const c of projConvs) projectConvUuids.add(c.uuid);
    emit({
      type: "project-start",
      project: displayName(project.name, project.uuid),
      docs: docs.length,
      conversations: projConvs.length,
    });

    accs.set(project.uuid, {
      project,
      docs,
      built: [],
      outstanding: projConvs.length,
      convSlugs: disambiguateSlugs(projConvs),
    });

    if (projConvs.length === 0) {
      await finalizeProject(project.uuid);
    } else {
      projConvs.forEach((conv, index) => {
        convTotal += 1;
        queue.push(
          { kind: "project-conv", projectId: project.uuid, conv, index, attempts: 0 },
          PRIORITY.projectConv
        );
      });
    }
    finishDiscovery();
  }

  /**
   * Resolve one conversation against its project accumulator and finalize the
   * project once every conversation has resolved. Called on BOTH success (with
   * a built bundle) and terminal failure (without one), so a permanently-failed
   * conversation cannot strand the project at outstanding > 0 -- the project is
   * still written, minus the conversation(s) that could not be fetched.
   *
   * @param projectId - UUID of the owning project.
   * @param built - The built conversation bundle on success; omitted on failure.
   */
  async function settleProjectConv(
    projectId: string,
    built?: ProjectConvBuilt
  ): Promise<void> {
    const acc = accs.get(projectId);
    if (!acc) return;
    if (built) acc.built.push(built);
    acc.outstanding -= 1;
    if (acc.outstanding === 0) {
      await finalizeProject(projectId);
    }
  }

  /**
   * Fetch and build one project conversation via {@link fetchAndBuild} (no disk
   * I/O), emit `conv-done`, then hand the built bundle to
   * {@link settleProjectConv}, which writes the project once it is the last
   * outstanding conversation. The slug is taken from the project's
   * disambiguated map, falling back to the bundle's own slug.
   *
   * When {@link RunOrgSyncOptions.skipEmpty} is in effect (the default), the
   * fetch runs with `detectEmpty: true`; a conversation found to have zero
   * human messages is excluded from the project's bundle entirely (settled
   * with no built entry, exactly like a terminally-failed conversation) and
   * counted in `skippedEmpty` instead of being fetched further or committed.
   * See {@link RunOrgSyncOptions.onBecameEmpty}'s doc for why only the "skip"
   * outcome is reachable for project conversations.
   *
   * @param task - The project-conv task identifying the conversation.
   */
  async function runProjectConv(task: ProjectConvTask): Promise<void> {
    const skipEmpty = options.skipEmpty ?? true;

    let built: FetchAndBuildResult;
    if (skipEmpty) {
      const fetched = await fetchAndBuild(client, orgId, task.conv, {
        authorName,
        authorEmail,
        skipArtifacts: options.skipArtifacts,
        multiBranch: true,
        detectEmpty: true,
      });
      if ("empty" in fetched) {
        // Project conversations have no per-conversation persisted sync
        // state -- the project bundle is always rebuilt fully from the
        // conversations fetched this run -- so decideEmptyAction would
        // always resolve to "skip" here regardless of onBecameEmpty; see
        // RunOrgSyncOptions.onBecameEmpty's doc.
        skippedEmpty += 1;
        convCompleted += 1;
        emit({
          type: "conv-done",
          kind: "project",
          action: "skipped-empty",
          displayName: displayName(task.conv.name, task.conv.uuid),
          completed: convCompleted,
          total: convTotal,
        });
        await settleProjectConv(task.projectId);
        return;
      }
      built = fetched;
    } else {
      // skipEmpty: false bypasses empty handling entirely -- byte-identical
      // to the pre-existing fetch call (no detectEmpty key at all).
      built = await fetchAndBuild(client, orgId, task.conv, {
        authorName,
        authorEmail,
        skipArtifacts: options.skipArtifacts,
        multiBranch: true,
      });
    }

    convCompleted += 1;
    emit({
      type: "conv-done",
      kind: "project",
      action: "exported",
      displayName: built.displayName,
      completed: convCompleted,
      total: convTotal,
    });
    await settleProjectConv(task.projectId, {
      index: task.index,
      slug: accs.get(task.projectId)?.convSlugs.get(task.conv.uuid) ?? built.slug,
      commits: built.bundle.commits,
    });
  }

  /**
   * Sync one standalone conversation directly into its own
   * `conversations/<slug>` directory via {@link syncConversation}, which owns
   * the full persistence cycle (state file, changelog, swap, became-empty
   * policy), then emit `conv-done` carrying the action it chose
   * (full/incremental/skipped/skipped-empty/retained-stale/cleaned-empty) and
   * tally the three empty-related outcomes into the running counters.
   * Unlike project convs, standalone convs have no shared barrier to settle.
   *
   * @param task - The standalone task identifying the conversation.
   */
  async function runStandalone(task: StandaloneTask): Promise<void> {
    const convPath = resolve(
      outputRoot,
      "conversations",
      slugFor(standaloneSlugs, task.conv.name, task.conv.uuid)
    );
    const result = await syncConversation(client, orgId, task.conv, convPath, {
      format,
      authorName,
      authorEmail,
      skipSame: options.skipSame,
      skipExisting: options.skipExisting,
      skipArtifacts: options.skipArtifacts,
      preserve,
      skipEmpty: options.skipEmpty,
      onBecameEmpty: options.onBecameEmpty,
    });
    convCompleted += 1;
    if (result.action === "skipped-empty") skippedEmpty += 1;
    else if (result.action === "retained-stale") retainedStale += 1;
    else if (result.action === "cleaned-empty") cleanedEmpty += 1;
    emit({
      type: "conv-done",
      kind: "standalone",
      action: result.action,
      displayName: result.displayName,
      completed: convCompleted,
      total: convTotal,
    });
  }

  /**
   * Resolve a task that will not be retried (terminal failure). Each task kind
   * carries different bookkeeping that must be released so the run can still
   * make progress and terminate: discovery advances the standalone barrier;
   * project-conv resolves its project (writing a partial project if it was the
   * last outstanding conversation); standalone owns its own directory and needs
   * nothing beyond the error count already recorded.
   *
   * @param task - The task that has exhausted retries or hit a fatal error.
   */
  async function terminalFail(task: Task): Promise<void> {
    if (task.kind === "discovery") finishDiscovery();
    else if (task.kind === "project-conv")
      await settleProjectConv(task.projectId);
  }

  /**
   * Wrap a task as a {@link PoolTask}: dispatch by kind, then own all error
   * handling so a rejection never aborts the {@link WorkerPool}. RateLimitError
   * requeues at the same priority until `maxRetries` is exhausted (then counts
   * as a terminal failure); an abort mid-flight is swallowed; any other error
   * counts as a terminal failure. The `finally` block always releases the
   * per-project in-flight slot for project-conv tasks so the cap stays accurate
   * even on the throttle-requeue path.
   *
   * @param task - The task to execute.
   * @returns A pool task that resolves once the work (and its bookkeeping) settles.
   */
  const runTask =
    (task: Task): PoolTask =>
    async () => {
      try {
        if (task.kind === "discovery") await runDiscovery(task);
        else if (task.kind === "project-conv") await runProjectConv(task);
        else await runStandalone(task);
      } catch (err) {
        if (err instanceof RateLimitError) {
          // controller.onThrottle was already called by the client at throw time.
          emit({
            type: "throttle",
            limit: controller.limit,
            resumeInSec: err.sleepSeconds,
          });
          if (task.attempts < maxRetries) {
            task.attempts += 1;
            queue.push(task, priorityOf(task));
          } else {
            errors += 1;
            emit({
              type: "error",
              displayName: labelOf(task),
              message: `rate limited, gave up after ${maxRetries} retries`,
            });
            await terminalFail(task);
          }
        } else if (signal?.aborted) {
          // Aborted mid-flight: swallow, the pool is shutting down.
        } else {
          errors += 1;
          emit({
            type: "error",
            displayName: labelOf(task),
            message: err instanceof Error ? err.message : String(err),
          });
          await terminalFail(task);
        }
      } finally {
        if (task.kind === "project-conv") {
          const n = (inFlightByProject.get(task.projectId) ?? 1) - 1;
          inFlightByProject.set(task.projectId, n);
        }
      }
    };

  // Seed: all project-discovery tasks first.
  for (const project of projects) {
    queue.push({ kind: "discovery", project, attempts: 0 }, PRIORITY.discovery);
  }
  discoveryOutstanding = projects.length;
  if (discoveryOutstanding === 0) enqueueStandalone();

  /**
   * Pool pull callback: pop the highest-priority eligible task, honoring the
   * per-project concurrency `cap` (project-conv tasks are skipped, not removed,
   * when their project is at the cap), and increment the project's in-flight
   * counter before handing the task to {@link runTask}.
   *
   * @returns A runnable {@link PoolTask}, or undefined when nothing is runnable now.
   */
  const pull = (): PoolTask | undefined => {
    const task = queue.pop((t) =>
      t.kind === "project-conv"
        ? (inFlightByProject.get(t.projectId) ?? 0) < cap
        : true
    );
    if (!task) return undefined;
    if (task.kind === "project-conv") {
      inFlightByProject.set(
        task.projectId,
        (inFlightByProject.get(task.projectId) ?? 0) + 1
      );
    }
    return runTask(task);
  };

  // The pool reads the adaptive limit on every pump, pulls eligible work via
  // `pull`, and is done only once the standalone barrier has opened and the
  // queue has fully drained. In-flight tasks blocked in the limiter keep the
  // pool from declaring done prematurely.
  const pool = new WorkerPool({
    limit: () => controller.limit,
    pull,
    isDone: () => standaloneEnqueued && queue.size === 0,
    signal,
  });
  await pool.run();

  return {
    projects: projects.length,
    standalone: standaloneCount,
    errors,
    skippedEmpty,
    retainedStale,
    cleanedEmpty,
  };
}
