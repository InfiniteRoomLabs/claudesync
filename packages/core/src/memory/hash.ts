import { createHash } from "node:crypto";

/**
 * Lowercase hex SHA-256 of a string's UTF-8 encoding. Used to fingerprint
 * canonicalized memory content and edit entries for the sidecar merge base and
 * the idempotency no-op check.
 *
 * @param data - The content to hash.
 * @returns The 64-character lowercase hex digest.
 */
export function hashContent(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}
