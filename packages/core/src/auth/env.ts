import type { AuthProvider } from "./types.js";
import { AuthError } from "./errors.js";

/**
 * Default browser User-Agent sent when none is supplied. claude.ai sits behind
 * Cloudflare, which blocks non-browser clients, so any plausible desktop-browser
 * string works (the exact value is not validated by the API).
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * {@link AuthProvider} backed by the `CLAUDE_AI_COOKIE` environment variable.
 *
 * This is the primary auth path for the MCP server and CLI: the host harvests
 * the `sessionKey` cookie and passes the full `Cookie` header value via the env
 * var. The constructor reads it once and then deletes it from `process.env` to
 * keep the secret out of `/proc/<pid>/environ` and `docker inspect`.
 */
export class EnvAuth implements AuthProvider {
  /** Full `Cookie` header value read from `CLAUDE_AI_COOKIE`. */
  private readonly cookie: string;
  /** User-Agent header, from `CLAUDE_AI_USER_AGENT` or {@link DEFAULT_USER_AGENT}. */
  private readonly userAgent: string;
  /** Memoized organization UUID; `null` until the first {@link EnvAuth.getOrganizationId} call. */
  private cachedOrgId: string | null = null;

  /**
   * Read the session cookie from the environment and scrub it from
   * `process.env` immediately afterward.
   *
   * @throws {@link AuthError} if `CLAUDE_AI_COOKIE` is unset or empty.
   */
  constructor() {
    const cookie = process.env.CLAUDE_AI_COOKIE;
    if (!cookie) {
      throw new AuthError(
        "CLAUDE_AI_COOKIE environment variable is required. " +
          "Get it from browser DevTools: Application > Cookies > claude.ai > sessionKey"
      );
    }
    this.cookie = cookie;
    this.userAgent = process.env.CLAUDE_AI_USER_AGENT ?? DEFAULT_USER_AGENT;

    // Security: clear the cookie from process.env to minimize exposure
    // via /proc/<pid>/environ and docker inspect
    delete process.env.CLAUDE_AI_COOKIE;
  }

  /** {@inheritDoc AuthProvider.getHeaders} */
  async getHeaders(): Promise<Record<string, string>> {
    return {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  /** {@inheritDoc AuthProvider.getOrganizationId} */
  async getOrganizationId(): Promise<string> {
    if (this.cachedOrgId) {
      return this.cachedOrgId;
    }

    const headers = await this.getHeaders();
    const response = await fetch("https://claude.ai/api/organizations", {
      headers,
    });

    if (!response.ok) {
      throw new AuthError(
        `Failed to fetch organizations: ${response.status} ${response.statusText}`
      );
    }

    const orgs = await response.json();
    if (!Array.isArray(orgs) || orgs.length === 0 || !orgs[0].uuid) {
      throw new AuthError("No organizations found for this session");
    }

    this.cachedOrgId = orgs[0].uuid as string;
    return this.cachedOrgId;
  }
}
