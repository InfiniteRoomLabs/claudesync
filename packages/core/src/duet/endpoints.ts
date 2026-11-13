/**
 * Path builders for the Claude Duet API, grouped by resource.
 *
 * Duet is served from the `/v1/code/` path family of claude.ai (its wire name is
 * `aibo`), which is distinct from the `/api/organizations/...` family that
 * {@link ENDPOINTS} covers. Values are root-relative paths; pass them through
 * `buildUrl` to prepend the claude.ai origin. Identifiers are opaque strings, so
 * every interpolated segment is percent-encoded rather than trusted.
 *
 * Observed from a browser capture of the Duet web client; not documented by
 * Anthropic.
 */
export const DUET_ENDPOINTS = {
  /** Find (never create) the account's Duet project. Called with `POST`. */
  project: "/v1/code/aibo/project",
  /**
   * Channels the account has joined, with members included.
   * @param limit - Maximum channels to return.
   */
  channels: (limit = 100) =>
    `/v1/code/channels?scope=joined&include_members=true&limit=${limit}`,
  /**
   * The newest messages of a channel, replies included. The API returns at most
   * `limit` entries and exposes no pagination cursor.
   * @param channelId - Channel id (`chan_...`).
   * @param limit - Maximum timeline entries to return.
   */
  timeline: (channelId: string, limit = 200) =>
    `/v1/code/channels/${encodeURIComponent(channelId)}/timeline?limit=${limit}&include_replies=true`,
  /**
   * One thread: a root message and its replies.
   * @param channelId - Channel id (`chan_...`).
   * @param messageId - Thread root message id (`cmsg_...`).
   * @param limit - Maximum messages to return.
   */
  thread: (channelId: string, messageId: string, limit = 200) =>
    `/v1/code/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(messageId)}?limit=${limit}`,
  /**
   * Message collection of a channel. Called with `POST` to send a message.
   * @param channelId - Channel id (`chan_...`).
   */
  messages: (channelId: string) =>
    `/v1/code/channels/${encodeURIComponent(channelId)}/messages`,
  /**
   * Task list of a channel, adopted suggestions included.
   * @param channelId - Channel id (`chan_...`).
   * @param limit - Maximum tasks to return.
   */
  tasks: (channelId: string, limit = 200) =>
    `/v1/code/aibo/channels/${encodeURIComponent(channelId)}/tasks?limit=${limit}&include_adopted=true`,
  /**
   * One task. Called with `POST` to update it.
   * @param channelId - Channel id (`chan_...`).
   * @param taskId - Task id.
   */
  task: (channelId: string, taskId: string) =>
    `/v1/code/aibo/channels/${encodeURIComponent(channelId)}/tasks/${encodeURIComponent(taskId)}`,
} as const;

/**
 * The static request headers the Duet web client sent besides the session
 * cookie. The sixth observed header, `x-organization-uuid`, depends on the
 * client and is added by {@link buildDuetHeaders}. Which headers the server
 * actually enforces is unknown, so this set is the first suspect if a live
 * request is rejected.
 */
export const DUET_DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "ccr-byoc-2025-07-29",
  "anthropic-client-app": "com.anthropic.aibo.web",
  "anthropic-client-feature": "ccr",
  "content-type": "application/json",
};

/**
 * Assemble the full Duet header set for one organization.
 *
 * Starts from {@link DUET_DEFAULT_HEADERS}, adds `x-organization-uuid`, then
 * applies `overrides`. The merge is case-insensitive and the result has
 * lowercase keys. An override value of `null` removes the header, so a header
 * the server turns out to reject can be dropped without a release.
 *
 * @param orgId - Organization UUID sent as `x-organization-uuid`.
 * @param overrides - Headers to replace, add or (with `null`) remove.
 * @returns The merged headers as a plain object with lowercase keys.
 */
export function buildDuetHeaders(
  orgId: string,
  overrides?: Readonly<Record<string, string | null>>
): Record<string, string> {
  const merged = new Headers(DUET_DEFAULT_HEADERS as Record<string, string>);
  merged.set("x-organization-uuid", orgId);
  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === null) {
      merged.delete(name);
    } else {
      merged.set(name, value);
    }
  }
  const out: Record<string, string> = {};
  merged.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
