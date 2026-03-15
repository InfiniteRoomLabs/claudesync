import type { AuthProvider } from "./types.js";
import { AuthError } from "./errors.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export class EnvAuth implements AuthProvider {
  private readonly cookie: string;
  private readonly userAgent: string;
  private cachedOrgId: string | null = null;

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

  async getHeaders(): Promise<Record<string, string>> {
    return {
      Cookie: this.cookie,
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

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
