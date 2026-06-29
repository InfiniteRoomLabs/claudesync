/**
 * Error raised when authentication setup or org resolution fails -- a missing
 * session cookie, an unreadable Firefox profile, or a rejected/empty response
 * from claude.ai. Carries a `name` of `"AuthError"` so callers can distinguish
 * auth failures from generic errors without `instanceof` plumbing.
 */
export class AuthError extends Error {
  /**
   * @param message - Human-readable explanation, typically including remediation
   * guidance (e.g. how to obtain the session cookie).
   */
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
