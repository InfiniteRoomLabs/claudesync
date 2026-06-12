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

/**
 * Collision-safe slugs for a set of entities sharing one directory namespace.
 *
 * `safeSlug` alone maps every same-named entity to the same slug, so the last
 * one synced overwrites the rest (data loss). Given the FULL list for a
 * namespace, this returns a `uuid -> slug` map where any slug shared by more
 * than one uuid gets disambiguated: EVERY member of a colliding group is
 * suffixed with the first block of its uuid (e.g. `casual-greeting-099ff180`).
 * Unique slugs are left bare, so non-colliding entities keep their existing
 * directory. Suffixing all members (not "keep one bare") makes the result
 * independent of list order -- the property that prevents re-corruption.
 */
export function disambiguateSlugs(
  items: ReadonlyArray<{ name: string | null | undefined; uuid: string }>
): Map<string, string> {
  const bare = new Map<string, string>(); // uuid -> bare slug
  const counts = new Map<string, number>(); // bare slug -> count
  for (const it of items) {
    const slug = safeSlug(it.name, it.uuid);
    bare.set(it.uuid, slug);
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [uuid, slug] of bare) {
    out.set(uuid, (counts.get(slug) ?? 0) > 1 ? `${slug}-${uuid.split("-")[0]}` : slug);
  }
  return out;
}
