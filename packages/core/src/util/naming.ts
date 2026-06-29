/**
 * Filesystem-safe slug from a free-text name. Lowercases, collapses any run of
 * non-alphanumeric characters to a single dash, trims leading/trailing dashes,
 * and caps the result at 60 chars. Returns "" for empty/null input -- pair with
 * {@link safeSlug} when a non-empty result is required.
 *
 * @param name - Source name; null/undefined are treated as empty.
 * @returns A lowercase dash-separated slug, possibly "".
 */
export function slugify(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

/**
 * {@link slugify} guaranteed non-empty. When `name` slugifies to "", falls back
 * to `unnamed-<uuid>`. Use anywhere a path segment must exist even when the
 * source object has no name.
 *
 * @param name - Source name; null/undefined are treated as empty.
 * @param uuid - Entity UUID used to build the fallback slug.
 * @returns A non-empty slug.
 */
export function safeSlug(name: string | null | undefined, uuid: string): string {
  return slugify(name) || `unnamed-${uuid}`;
}

/**
 * Human-readable label for log lines and progress output. Returns the trimmed
 * name when present, otherwise `<unnamed <uuid>>`. Unlike {@link safeSlug} the
 * output is for display only and is not filesystem-safe.
 *
 * @param name - Source name; null/undefined are treated as empty.
 * @param uuid - Entity UUID used in the fallback label.
 * @returns The trimmed name, or a bracketed unnamed placeholder.
 */
export function displayName(name: string | null | undefined, uuid: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed || `<unnamed ${uuid}>`;
}

/**
 * Collision-safe slugs for a set of entities sharing one directory namespace.
 *
 * {@link safeSlug} alone maps every same-named entity to the same slug, so the
 * last one synced overwrites the rest (data loss). Given the FULL list for a
 * namespace, this returns a `uuid -> slug` map where any slug shared by more
 * than one uuid gets disambiguated: EVERY member of a colliding group is
 * suffixed with the first block of its uuid (e.g. `casual-greeting-099ff180`).
 * Unique slugs are left bare, so non-colliding entities keep their existing
 * directory. Suffixing all members (not "keep one bare") makes the result
 * independent of list order -- the property that prevents re-corruption.
 *
 * @param items - The complete set of entities in the namespace, each with a
 *   name and uuid. Must be the full set, or collisions can be missed.
 * @returns A map from each entity's uuid to its final, collision-safe slug.
 */
export function disambiguateSlugs(
  items: ReadonlyArray<{ name: string | null | undefined; uuid: string }>
): Map<string, string> {
  /** uuid -> bare (pre-disambiguation) slug. */
  const bare = new Map<string, string>();
  /** bare slug -> number of uuids that produced it. */
  const counts = new Map<string, number>();
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
