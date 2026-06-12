import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { ClaudeSyncClient } from "../client/client.js";
import { RateLimitError } from "../client/errors.js";
import type {
  ConversationSummary,
  Project,
  ProjectDoc,
} from "../models/types.js";
import { fetchAndBuild } from "./fetch.js";
import { syncConversation, type ExportFormat } from "./incremental.js";
import {
  assembleProjectBundle,
  writeProjectBundle,
  type ProjectConvBuilt,
} from "./project-sync.js";
import { safeSlug, displayName, disambiguateSlugs } from "../util/naming.js";
import { MinPriorityQueue } from "../concurrency/priority-queue.js";
import { WorkerPool, type PoolTask } from "../concurrency/worker-pool.js";
import type { AdaptiveController } from "../concurrency/controller.js";

export type ProgressEvent =
  | { type: "org-start"; projectCount: number; conversationCount: number }
  | {
      type: "project-start";
      project: string;
      docs: number;
      conversations: number;
    }
  | { type: "project-done"; project: string }
  | { type: "project-skipped"; project: string }
  | {
      type: "conv-done";
      kind: "project" | "standalone";
      action: string;
      displayName: string;
      completed: number;
      total: number;
    }
  | { type: "throttle"; limit: number; resumeInSec: number }
  | { type: "error"; displayName: string; message: string };

export interface RunOrgSyncOptions {
  outputRoot: string;
  format: ExportFormat;
  authorName: string;
  authorEmail: string;
  skipArtifacts?: boolean;
  skipExisting?: boolean;
  skipSame?: boolean;
  preserve?: string[];
  /** Shared adaptive controller. MUST be the same instance the client uses. */
  controller: AdaptiveController;
  /** Optional per-project concurrency cap. Unset = no cap. */
  projectConcurrency?: number;
  /** Requeue attempts on RateLimitError before giving up on a task. */
  maxRetries: number;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
}

export interface RunOrgSyncResult {
  projects: number;
  standalone: number;
  errors: number;
}

const PRIORITY = { discovery: 0, projectConv: 1, standalone: 2 } as const;

interface DiscoveryTask {
  kind: "discovery";
  project: Project;
  attempts: number;
}
interface ProjectConvTask {
  kind: "project-conv";
  projectId: string;
  conv: ConversationSummary;
  index: number;
  attempts: number;
}
interface StandaloneTask {
  kind: "standalone";
  conv: ConversationSummary;
  attempts: number;
}
type Task = DiscoveryTask | ProjectConvTask | StandaloneTask;

interface ProjectAccumulator {
  project: Project;
  docs: ProjectDoc[];
  built: ProjectConvBuilt[];
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
  const cap = options.projectConcurrency ?? Number.POSITIVE_INFINITY;
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
  let standaloneSlugs = new Map<string, string>();
  const slugFor = (m: Map<string, string>, name: string | null | undefined, uuid: string) =>
    m.get(uuid) ?? safeSlug(name, uuid);
  emit({
    type: "org-start",
    projectCount: projects.length,
    conversationCount: allConversations.length,
  });

  const queue = new MinPriorityQueue<Task>();
  const projectConvUuids = new Set<string>();
  const inFlightByProject = new Map<string, number>();
  const accs = new Map<string, ProjectAccumulator>();

  let discoveryOutstanding = 0;
  let standaloneEnqueued = false;
  let convCompleted = 0;
  let convTotal = 0;
  let standaloneCount = 0;
  let errors = 0;

  const priorityOf = (task: Task): number =>
    task.kind === "discovery"
      ? PRIORITY.discovery
      : task.kind === "project-conv"
        ? PRIORITY.projectConv
        : PRIORITY.standalone;

  const labelOf = (task: Task): string =>
    task.kind === "discovery"
      ? displayName(task.project.name, task.project.uuid)
      : displayName(task.conv.name, task.conv.uuid);

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

  function finishDiscovery(): void {
    discoveryOutstanding -= 1;
    if (discoveryOutstanding === 0 && !standaloneEnqueued) {
      enqueueStandalone();
    }
  }

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

  async function runProjectConv(task: ProjectConvTask): Promise<void> {
    const built = await fetchAndBuild(client, orgId, task.conv, {
      authorName,
      authorEmail,
      skipArtifacts: options.skipArtifacts,
      multiBranch: true,
    });
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
    });
    convCompleted += 1;
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
   */
  async function terminalFail(task: Task): Promise<void> {
    if (task.kind === "discovery") finishDiscovery();
    else if (task.kind === "project-conv")
      await settleProjectConv(task.projectId);
  }

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
  };
}
