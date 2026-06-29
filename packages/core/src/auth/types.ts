/**
 * Strategy for authenticating against the undocumented claude.ai web API.
 *
 * Implementations differ only in where the session cookie comes from (an env
 * var, a Firefox profile, etc.); every API client in the SDK depends on this
 * interface rather than a concrete source so the cookie origin stays swappable.
 *
 * @see {@link EnvAuth} for the env-var implementation.
 * @see {@link FirefoxProfileAuth} for the Firefox-profile implementation.
 */
export interface AuthProvider {
  /**
   * Build the HTTP headers needed for claude.ai API requests, including the
   * session `Cookie` and a browser-like `User-Agent` (Cloudflare rejects
   * non-browser fingerprints).
   *
   * @returns A fresh header map suitable for passing to `fetch`.
   */
  getHeaders(): Promise<Record<string, string>>;

  /**
   * Resolve the organization UUID for this session. Most claude.ai endpoints
   * are scoped under an organization, so callers need this id before issuing
   * other requests.
   *
   * The first call hits `/api/organizations`; the result is cached for the
   * lifetime of the provider.
   *
   * @returns The UUID of the session's first organization.
   * @throws {@link AuthError} if the request fails or no organization is found.
   */
  getOrganizationId(): Promise<string>;
}
