import {
  EnvAuth,
  ClaudeSyncClient,
  AuthError,
} from "@claudesync/core";

/**
 * Creates an authenticated ClaudeSyncClient from environment variables.
 * Exits with a user-friendly message if CLAUDE_AI_COOKIE is not set.
 */
export function createClient(): { auth: EnvAuth; client: ClaudeSyncClient } {
  try {
    const auth = new EnvAuth();
    const client = new ClaudeSyncClient(auth);
    return { auth, client };
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(`Auth error: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Resolves the organization ID from the provided option or auto-detects it
 * from the authenticated session.
 */
export async function resolveOrgId(
  auth: EnvAuth,
  orgIdOption?: string
): Promise<string> {
  if (orgIdOption) {
    return orgIdOption;
  }
  try {
    return await auth.getOrganizationId();
  } catch (error) {
    if (error instanceof AuthError) {
      console.error(`Failed to auto-detect organization: ${error.message}`);
      console.error("Specify --org <orgId> manually.");
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Truncates a string to the given max length, appending an ellipsis if needed.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + "...";
}
