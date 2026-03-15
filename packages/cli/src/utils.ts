import {
  EnvAuth,
  ClaudeSyncClient,
  AuthError,
} from "@infinite-room-labs/claudesync-core";
import { search } from "@metrichor/jmespath";
import type { JSONValue } from "@metrichor/jmespath";

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
 * Outputs JSON data, optionally filtered by a JMESPath query.
 * Used by all commands that support --json and --query flags.
 *
 * Usage in commands:
 *   .option("--json", "Output as JSON")
 *   .option("--query <expression>", "JMESPath query to filter JSON output (implies --json)")
 *
 * When --query is provided without --json, it implies --json automatically.
 */
// Zod's passthrough() creates objectOutputType<...> which doesn't structurally
// match JSONValue, even though the data is always JSON-serializable (it came
// from JSON.parse via the API client). This cast bridges that gap.
function asJsonValue(data: unknown): JSONValue {
  return data as JSONValue;
}

export function outputJson(data: unknown, query?: string): void {
  if (query) {
    try {
      const result = search(asJsonValue(data), query);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(
        `Invalid JMESPath query: ${err instanceof Error ? err.message : String(err)}`
      );
      console.error("  See https://jmespath.org/tutorial.html for syntax help.");
      process.exit(1);
    }
  } else {
    console.log(JSON.stringify(data, null, 2));
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
