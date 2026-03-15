export interface AuthProvider {
  /** Build the HTTP headers needed for claude.ai API requests */
  getHeaders(): Promise<Record<string, string>>;

  /**
   * Resolve the organization UUID for this session.
   * Makes an API call to /api/organizations on first call, caches the result.
   */
  getOrganizationId(): Promise<string>;
}
