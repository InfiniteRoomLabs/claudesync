import { Command } from "commander";
import type { ClaudeSyncClient, ConversationSummary, ResolveNameCandidate } from "@infinite-room-labs/claudesync-core";
import {
  ClaudeSyncError,
  selectUnnamedConversations,
  planRename,
  classifyAmbiguousRename,
} from "@infinite-room-labs/claudesync-core";
import { createClient, resolveOrgId, outputJson } from "../utils.js";

/**
 * Fixed column width used when padding a conversation uuid for table
 * display. UUIDs are always 36 characters (8-4-4-4-12 hex, hyphenated), so
 * this never truncates -- it only controls alignment of the column that
 * follows.
 */
const UUID_COLUMN_WIDTH = 36;

/**
 * One resolvable candidate reduced to just the fields the apply/JSON/table
 * paths actually need: the conversation's identity and its derived title.
 *
 * @remarks
 * Narrower than {@link ResolveNameCandidate} (which also carries `status`
 * and an optional `reason`) because every consumer of this shape already
 * knows the candidate resolved -- `title` is guaranteed non-null here, unlike
 * on the wider type.
 */
interface ResolvableCandidate {
  /** The conversation's stable identifier. */
  uuid: string;
  /** The derived title that would be (or was) written to claude.ai. */
  title: string;
}

/**
 * One unresolved candidate reduced to just the fields the table/JSON paths
 * need: identity and the structural reason no title could be derived. Never
 * carries a title -- there isn't one.
 */
interface UnresolvedCandidate {
  /** The conversation's stable identifier. */
  uuid: string;
  /** The raw (un-mapped) reason from {@link ResolveNameCandidate.reason}. */
  reason: NonNullable<ResolveNameCandidate["reason"]>;
}

/**
 * One conversation whose hydration (`getConversation`) failed before
 * {@link planRename} ever ran on it -- distinct from {@link UnresolvedCandidate},
 * which reached `planRename` and was told there was no usable title.
 *
 * @remarks
 * Carries only identity and a coarse failure classifier, never the thrown
 * error's message -- an error message from a failed fetch could echo request
 * or response content, which the module's privacy rule forbids outside JSON
 * output. Items of this shape never enter `candidates`, so they can never
 * reach the apply phase.
 */
interface FetchFailedCandidate {
  /** The conversation's stable identifier. */
  uuid: string;
  /** HTTP status code from the failed fetch, when the failure came from a definite non-2xx response. */
  status?: number;
  /** The failing error's constructor name (e.g. `"TypeError"`), used when no HTTP status is available -- never the error's message. */
  errorClass?: string;
}

/**
 * Type predicate narrowing a {@link ResolveNameCandidate} to a
 * {@link ResolvableCandidate}-shaped value (`title` provably non-null).
 *
 * @param candidate - A candidate produced by {@link planRename}.
 * @returns `true` when `candidate.status` is `"resolvable"`.
 */
function isResolvable(
  candidate: ResolveNameCandidate,
): candidate is ResolveNameCandidate & { title: string } {
  return candidate.status === "resolvable";
}

/**
 * Type predicate narrowing a {@link ResolveNameCandidate} to one whose
 * `reason` is provably present (i.e. `status === "unresolved"`).
 *
 * @param candidate - A candidate produced by {@link planRename}.
 * @returns `true` when `candidate.status` is `"unresolved"`.
 */
function isUnresolved(
  candidate: ResolveNameCandidate,
): candidate is ResolveNameCandidate & { reason: NonNullable<ResolveNameCandidate["reason"]> } {
  return candidate.status === "unresolved";
}

/**
 * Maps an unresolved candidate's raw `reason` to the label shown in the
 * human-readable table.
 *
 * @remarks
 * `"empty-after-sanitize"` covers two structurally distinct causes that
 * {@link planRename} cannot tell apart from the caller's side: text that
 * sanitized to nothing (whitespace-only, markdown-only, code-only) AND the
 * "active branch has no human message even though the conversation has one
 * elsewhere" case (a Task 4 review finding) -- both leave `deriveConversationTitle`
 * returning `null` while {@link isEmptyConversation} still sees a human
 * message somewhere in the flat array, so `reason` can't distinguish them.
 * `"no usable opener"` is a label broad enough to cover both without
 * implying one specific cause. `"no-human-message"` has no ambiguity to
 * paper over, so it is shown as-is.
 *
 * @param reason - The raw reason from {@link ResolveNameCandidate.reason}.
 * @returns The table-display label for `reason`.
 */
function formatUnresolvedReason(reason: NonNullable<ResolveNameCandidate["reason"]>): string {
  return reason === "empty-after-sanitize" ? "no usable opener" : reason;
}

/**
 * Outcome of attempting to apply one resolved rename, tagged by
 * `outcome` so callers can branch without re-deriving it.
 *
 * @remarks
 * `title` is carried on every variant so JSON output (the only place a
 * per-item outcome's title is allowed to surface -- see the module's privacy
 * note) doesn't need a second lookup against the resolvable list. Non-JSON
 * progress output never reads `title` off this type.
 */
type ApplyOutcome =
  | {
      /** The conversation's stable identifier. */
      uuid: string;
      /** The title that was written to claude.ai. */
      title: string;
      /** The write (or an ambiguous-retry re-read) confirmed the new title landed. */
      outcome: "renamed";
    }
  | {
      /** The conversation's stable identifier. */
      uuid: string;
      /** The title that was attempted; never written because the conversation was gone. */
      title: string;
      /** The write (or an ambiguous-retry re-read) 404'd -- the conversation was deleted out from under this batch. */
      outcome: "skipped-deleted";
    }
  | {
      /** The conversation's stable identifier. */
      uuid: string;
      /** The title that was attempted; not applied because someone/something else changed the name first. */
      title: string;
      /** An ambiguous-retry re-read found a name that landed on neither the old nor the attempted title -- left alone, reported. */
      outcome: "concurrent-edit";
    }
  | {
      /** The conversation's stable identifier. */
      uuid: string;
      /** The title that was attempted; its fate is unconfirmed. */
      title: string;
      /** The write (or an ambiguous-retry re-read) failed outright, with no further signal available to disambiguate. */
      outcome: "failed";
      /** HTTP status from the failed write, when the failure came from a definite non-2xx response. Omitted when no definite response was ever received, or when the failure came from the ambiguous-retry re-read path. */
      status?: number;
    };

/**
 * Attempts one rename write and classifies the result.
 *
 * @remarks
 * Three broad paths, matching the design's error taxonomy:
 *
 * 1. The write succeeds -> `"renamed"`.
 * 2. The write throws a {@link ClaudeSyncError} (a definite non-2xx HTTP
 *    response was received) -> `404` maps to `"skipped-deleted"` (the
 *    conversation was deleted out from under this batch); any other status
 *    maps to `"failed"`, carrying only the status code (never the response
 *    body or a message that could echo the title).
 * 3. The write throws anything else -- no definite HTTP response was ever
 *    received (timeout, connection reset, DNS failure, etc.) -- the outcome
 *    is genuinely ambiguous: the write may have landed anyway. This re-reads
 *    the conversation exactly once and hands the fresh name to
 *    {@link classifyAmbiguousRename}: `"applied"` maps to `"renamed"`,
 *    `"concurrent-edit"` passes through unchanged (left alone, reported),
 *    and `"failed"` passes through unchanged. If the re-read itself throws,
 *    a `404` there is still recognized as `"skipped-deleted"`; any other
 *    re-read failure gives up and reports `"failed"` -- there is no further
 *    signal available to disambiguate.
 *
 * @param client - The authenticated client to write and (if needed) re-read through.
 * @param orgId - Organization UUID.
 * @param candidate - The resolvable candidate to rename.
 * @returns The classified {@link ApplyOutcome} for this candidate.
 */
async function applyOneRename(
  client: ClaudeSyncClient,
  orgId: string,
  candidate: ResolvableCandidate,
): Promise<ApplyOutcome> {
  const { uuid, title } = candidate;

  try {
    await client.renameConversation(orgId, uuid, title);
    return { uuid, title, outcome: "renamed" };
  } catch (err) {
    if (err instanceof ClaudeSyncError) {
      if (err.statusCode === 404) {
        return { uuid, title, outcome: "skipped-deleted" };
      }
      return { uuid, title, outcome: "failed", status: err.statusCode };
    }

    // Not a ClaudeSyncError: the write never got a definite HTTP response.
    // Re-read once to find out whether it landed anyway.
    try {
      const fresh = await client.getConversation(orgId, uuid);
      const classification = classifyAmbiguousRename(fresh.name, title);
      if (classification === "applied") {
        return { uuid, title, outcome: "renamed" };
      }
      if (classification === "concurrent-edit") {
        return { uuid, title, outcome: "concurrent-edit" };
      }
      return { uuid, title, outcome: "failed" };
    } catch (rereadErr) {
      if (rereadErr instanceof ClaudeSyncError && rereadErr.statusCode === 404) {
        return { uuid, title, outcome: "skipped-deleted" };
      }
      return { uuid, title, outcome: "failed" };
    }
  }
}

/**
 * Renders one {@link ApplyOutcome} as a title-free progress label, safe for
 * the advisory (stderr) stream per the module's privacy rule.
 *
 * @param outcome - The outcome to describe.
 * @returns A short, title-free status string.
 */
function describeOutcome(outcome: ApplyOutcome): string {
  switch (outcome.outcome) {
    case "renamed":
      return "renamed";
    case "skipped-deleted":
      return "skipped-deleted (404)";
    case "concurrent-edit":
      return "concurrent-edit";
    case "failed":
      return outcome.status !== undefined ? `failed (status ${outcome.status})` : "failed";
  }
}

/**
 * Counts of apply outcomes, matching the five categories the design
 * requires in the final apply summary.
 */
interface ApplyCounts {
  /** Candidates whose write (or ambiguous-retry re-read) confirmed the new title landed. */
  renamed: number;
  /** Candidates {@link planRename} could not derive a title for -- never attempted. */
  unresolved: number;
  /** Candidates whose write 404'd -- the conversation was deleted out from under this batch. */
  skipped: number;
  /** Candidates whose write (or ambiguous-retry re-read) failed outright. */
  failed: number;
  /** Candidates left renamed by someone/something else during an ambiguous retry -- left alone, reported. */
  concurrentEdit: number;
}

/**
 * Serially applies renames for every candidate in `resolvable`, at write
 * concurrency 1 (one `renameConversation` in flight at a time -- reads
 * during the earlier resolve phase use the client's existing limiter and are
 * not affected by this).
 *
 * @remarks
 * Installs a `SIGINT` handler for the duration of the loop: on interrupt, the
 * in-flight write (if any) is allowed to finish, but the loop starts no
 * further writes and returns with `interrupted: true`. The handler is always
 * removed before this function returns (success, interruption, or a thrown
 * error), restoring Node's default `SIGINT` behavior for the rest of the
 * process.
 *
 * Per-item progress is printed to stderr as each write settles (unless
 * `json` is set, where per-item output would be redundant with the final
 * JSON payload) -- title-free, per the module's privacy rule.
 *
 * @param opts.client - The authenticated client.
 * @param opts.orgId - Organization UUID.
 * @param opts.resolvable - Candidates to rename, in the order they will be attempted.
 * @param opts.json - Whether JSON output was requested; suppresses per-item stderr progress lines.
 * @returns Every candidate's {@link ApplyOutcome}, in attempt order (a prefix
 * of `resolvable` if interrupted), plus whether the batch was interrupted.
 */
async function applyRenames(opts: {
  client: ClaudeSyncClient;
  orgId: string;
  resolvable: readonly ResolvableCandidate[];
  json: boolean | undefined;
}): Promise<{ outcomes: ApplyOutcome[]; interrupted: boolean }> {
  const { client, orgId, resolvable, json } = opts;
  const outcomes: ApplyOutcome[] = [];
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
  };
  process.on("SIGINT", onSigint);

  try {
    for (const candidate of resolvable) {
      if (interrupted) {
        break;
      }
      const outcome = await applyOneRename(client, orgId, candidate);
      outcomes.push(outcome);
      if (!json) {
        console.error(`  ${candidate.uuid}  ${describeOutcome(outcome)}`);
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }

  return { outcomes, interrupted };
}

/**
 * Prints the human-readable dry-run/plan report: the resolvable table
 * (`uuid -> proposed title`) and, if any exist, the unresolved section
 * (`uuid` + display reason only -- see {@link formatUnresolvedReason} --
 * with fetch-failed items appended under the fixed label `"fetch failed"`),
 * followed by the resolvable/unresolved/fetch-failed/total counts line.
 *
 * @remarks
 * Titles appear here and nowhere else in the non-JSON output path -- no
 * other function in this module prints a title. This is the module's
 * privacy boundary made concrete.
 *
 * @param resolvable - Candidates with a derived title.
 * @param unresolved - Candidates with no derivable title.
 * @param fetchFailed - Conversations whose hydration failed before {@link planRename} ran.
 */
function printPlanTable(
  resolvable: readonly ResolvableCandidate[],
  unresolved: readonly UnresolvedCandidate[],
  fetchFailed: readonly FetchFailedCandidate[],
): void {
  console.log(`  ${"UUID".padEnd(UUID_COLUMN_WIDTH)}  ->  Proposed title`);
  for (const candidate of resolvable) {
    console.log(`  ${candidate.uuid.padEnd(UUID_COLUMN_WIDTH)}  ->  ${candidate.title}`);
  }

  if (unresolved.length > 0 || fetchFailed.length > 0) {
    console.log(`\n  Unresolved:`);
    console.log(`  ${"UUID".padEnd(UUID_COLUMN_WIDTH)}  Reason`);
    for (const candidate of unresolved) {
      console.log(`  ${candidate.uuid.padEnd(UUID_COLUMN_WIDTH)}  ${formatUnresolvedReason(candidate.reason)}`);
    }
    for (const candidate of fetchFailed) {
      console.log(`  ${candidate.uuid.padEnd(UUID_COLUMN_WIDTH)}  fetch failed`);
    }
  }

  const fetchFailedSuffix = fetchFailed.length > 0 ? `, ${fetchFailed.length} fetch failed` : "";
  console.log(
    `\n  ${resolvable.length} resolvable, ${unresolved.length} unresolved${fetchFailedSuffix} ` +
      `(${resolvable.length + unresolved.length + fetchFailed.length} total)`,
  );
}

/** Verbatim advisory line printed before any hydration begins (both dry-run and `--apply`). */
const FETCH_COST_LINE_TEMPLATE = (count: number): string =>
  `Resolving ${count} unnamed conversation(s) -- this fetches each one in full.`;

/** Verbatim advisory line printed above the plan table. */
const CONTENT_WARNING_LINE = "Proposed titles are derived from conversation content -- review before applying.";

/** Verbatim trailer printed at the end of a dry run (no `--apply`). */
const DRY_RUN_TRAILER = "Nothing renamed -- re-run with --apply to push these names to claude.ai.";

/** Verbatim caveat printed after any apply run that renamed at least one conversation. */
const RENAME_ORPHAN_WARNING =
  "Renamed conversations will re-export under new directory names on next sync; previous unnamed-<uuid> directories are left behind.";

/**
 * `conversations resolve-names` -- derives titles for unnamed conversations
 * from their opening human message and, with `--apply`, writes them to
 * claude.ai.
 *
 * @remarks
 * Dry run by default: resolves and reports a plan but sends nothing. The
 * resolve phase (list -> {@link selectUnnamedConversations} -> hydrate each
 * via `getConversation` -> {@link planRename}) is identical whether or not
 * `--apply` is given -- `--apply` only adds a write phase afterward, so the
 * plan a dry run shows is exactly what `--apply` would act on if re-run
 * immediately after (modulo concurrent changes on claude.ai in between).
 * Hydration is per-item: one conversation's `getConversation` failing is
 * recorded as a {@link FetchFailedCandidate} and does not abort the rest of
 * the batch or the plan report, but it does keep that conversation out of
 * `candidates` entirely, so it can never reach the apply phase.
 *
 * Advisory/progress lines (fetch-cost, content warning, per-item apply
 * progress, interruption notice, rename-orphan warning) always go to
 * stderr, regardless of `--json`. The "content" -- the plan table or, with
 * `--json`, the JSON payload -- goes to stdout. This keeps `--json` output on
 * stdout parseable while still surfacing progress to a human watching.
 */
export const resolveNamesCommand = new Command("resolve-names")
  .description(
    "Derive titles for unnamed conversations from their opening message, and optionally apply them (dry run by default)",
  )
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option(
    "--id <uuid>",
    "Restrict to this conversation uuid (repeatable). Omit to consider every unnamed conversation in the org.",
    (value: string, previous: string[] = []) => previous.concat(value),
    [] as string[],
  )
  .option("--limit <n>", "Cap the number of unnamed conversations considered")
  .option("--apply", "Actually write the derived titles to claude.ai (default is a dry run that sends nothing)")
  .option(
    "--json",
    "Output the plan (and, with --apply, per-item outcomes) as JSON -- includes proposed titles; this is content-bearing output",
  )
  .option("--query <expression>", "JMESPath query to filter JSON output (implies --json)")
  .action(async (options: {
    org?: string;
    id: string[];
    limit?: string;
    apply?: boolean;
    json?: boolean;
    query?: string;
  }) => {
    let limit: number | undefined;
    if (options.limit !== undefined) {
      limit = parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit < 0) {
        console.error(`--limit must be a non-negative integer; got "${options.limit}".`);
        process.exitCode = 1;
        return;
      }
    }

    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    const summaries: ConversationSummary[] = await client.listConversationsAll(orgId);
    const selected = selectUnnamedConversations(summaries, {
      ids: options.id.length > 0 ? options.id : undefined,
      limit,
    });

    console.error(FETCH_COST_LINE_TEMPLATE(selected.length));

    // Hydrate each candidate individually: a single failed getConversation
    // must not abort the whole command before any plan prints. Failures are
    // recorded as fetch-failed rows (uuid + status/error class only -- never
    // content) and excluded from `candidates`, so they can never reach the
    // apply phase below.
    const candidates: ResolveNameCandidate[] = [];
    const fetchFailed: FetchFailedCandidate[] = [];
    for (const summary of selected) {
      try {
        const conversation = await client.getConversation(orgId, summary.uuid);
        candidates.push(planRename(conversation));
      } catch (err) {
        if (err instanceof ClaudeSyncError) {
          fetchFailed.push({ uuid: summary.uuid, status: err.statusCode });
        } else {
          fetchFailed.push({
            uuid: summary.uuid,
            errorClass: err instanceof Error ? err.constructor.name : typeof err,
          });
        }
      }
    }

    const resolvable: ResolvableCandidate[] = candidates.filter(isResolvable).map((c) => ({
      uuid: c.uuid,
      title: c.title,
    }));
    const unresolved: UnresolvedCandidate[] = candidates.filter(isUnresolved).map((c) => ({
      uuid: c.uuid,
      reason: c.reason,
    }));

    console.error(CONTENT_WARNING_LINE);

    if (!options.json && !options.query) {
      printPlanTable(resolvable, unresolved, fetchFailed);
    }

    const planJson = {
      resolvable,
      unresolved,
      fetchFailed,
      counts: {
        resolvable: resolvable.length,
        unresolved: unresolved.length,
        fetchFailed: fetchFailed.length,
        total: resolvable.length + unresolved.length + fetchFailed.length,
      },
    };

    if (!options.apply) {
      if (options.json || options.query) {
        outputJson(planJson, options.query);
      } else {
        console.log(`\n${DRY_RUN_TRAILER}`);
      }
      return;
    }

    const { outcomes, interrupted } = await applyRenames({
      client,
      orgId,
      resolvable,
      json: options.json || Boolean(options.query),
    });

    if (interrupted) {
      console.error("Interrupted -- finished the in-flight write and started no new ones.");
    }

    const applyCounts: ApplyCounts = {
      renamed: outcomes.filter((o) => o.outcome === "renamed").length,
      unresolved: unresolved.length,
      skipped: outcomes.filter((o) => o.outcome === "skipped-deleted").length,
      failed: outcomes.filter((o) => o.outcome === "failed").length,
      concurrentEdit: outcomes.filter((o) => o.outcome === "concurrent-edit").length,
    };

    if (options.json || options.query) {
      outputJson(
        {
          ...planJson,
          outcomes,
          applyCounts,
          interrupted,
        },
        options.query,
      );
    } else {
      console.log(
        `\n  Renamed: ${applyCounts.renamed}, Unresolved: ${applyCounts.unresolved}, ` +
          `Skipped: ${applyCounts.skipped}, Failed: ${applyCounts.failed}, ` +
          `Concurrent-edit: ${applyCounts.concurrentEdit}`,
      );
    }

    if (applyCounts.renamed > 0) {
      console.error(RENAME_ORPHAN_WARNING);
    }

    if (applyCounts.failed > 0 || applyCounts.concurrentEdit > 0) {
      process.exitCode = 1;
    }
  });

/**
 * `conversations` -- parent command grouping conversation-level utilities.
 *
 * @remarks
 * Currently has one subcommand, {@link resolveNamesCommand}. Structured as a
 * namespace (rather than a top-level `resolve-names` command) so future
 * conversation-level utilities have a natural home, mirroring the existing
 * `projects` namespace command.
 */
export const conversationsCommand = new Command("conversations").description("Conversation-level utilities");

conversationsCommand.addCommand(resolveNamesCommand);
