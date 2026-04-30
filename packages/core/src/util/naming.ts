/**
 * Filesystem-safe slug from a free-text name. Lowercases, strips anything
 * non-alphanumeric to dashes, trims edges, caps at 60 chars. Returns "" for
 * empty/null input -- callers should pair with `safeSlug()` if they need a
 * fallback.
 */
export function slugify(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * Slug guaranteed non-empty. If `name` slugifies to "", returns
 * `unnamed-<uuid>`. Use this anywhere a path segment must be unique even when
 * the source object has no name.
 */
export function safeSlug(name: string | null | undefined, uuid: string): string {
  return slugify(name) || `unnamed-${uuid}`;
}

/**
 * Human-readable label. Returns the trimmed name when present, else
 * `<unnamed <uuid>>`. For log lines and progress output.
 */
export function displayName(name: string | null | undefined, uuid: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed || `<unnamed ${uuid}>`;
}
