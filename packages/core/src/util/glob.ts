/**
 * Minimal POSIX-style glob matcher for relative paths.
 *
 * Supports:
 *   *      -- any sequence of non-slash chars
 *   **     -- any sequence including slashes
 *   ?      -- single non-slash char
 *   [abc]  -- character class
 *   literal segments
 *
 * Paths are normalized to forward slashes before matching. Patterns must use
 * forward slashes regardless of platform. Leading `./` is stripped.
 *
 * No brace expansion ({a,b}) and no extglob -- if you need those, swap in
 * minimatch. This helper exists so core can ship zero-dep glob matching for
 * the --preserve flag without dragging in a 30KB dependency.
 *
 * @packageDocumentation
 */

/**
 * Translate a glob pattern into an anchored {@link RegExp}.
 *
 * Walks the pattern character by character, expanding glob tokens (`*`, `**`,
 * `?`, `[...]`) and escaping regex metacharacters in literal segments. An
 * unterminated `[` is treated as a literal bracket rather than throwing. The
 * result is anchored with `^`/`$` so it matches the whole subject.
 *
 * @param pattern - Forward-slash glob pattern; leading `./` and duplicate
 *   slashes are normalized away first.
 * @returns A compiled regular expression matching the same paths as the glob.
 */
function globToRegExp(pattern: string): RegExp {
  // Normalize: strip leading ./ and any duplicate slashes.
  const norm = pattern.replace(/^\.\//, "").replace(/\/+/g, "/");

  let re = "^";
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        // **  -> match anything including /
        // **/ -> match zero or more path segments (consume the trailing /)
        if (norm[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        re += ".*";
        i += 2;
        continue;
      }
      // single * -> any sequence of non-/ chars
      re += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (ch === "[") {
      // copy character class verbatim until matching ]
      const close = norm.indexOf("]", i + 1);
      if (close === -1) {
        // unterminated class -- treat as literal [
        re += "\\[";
        i += 1;
        continue;
      }
      re += norm.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    // Escape regex metachars; keep slashes literal.
    if (/[.+^${}()|\\]/.test(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
    i += 1;
  }
  re += "$";
  return new RegExp(re);
}

/**
 * Compile a pattern once into a reusable matcher. Prefer this over
 * {@link matchGlob} when testing the same pattern against many subjects, since
 * the regex is built a single time. The returned predicate normalizes each
 * subject (backslashes to `/`, strips leading `./`) before testing.
 *
 * @param pattern - Forward-slash glob pattern.
 * @returns A predicate that returns true when a path matches the pattern.
 */
export function compileGlob(pattern: string): (subject: string) => boolean {
  const rx = globToRegExp(pattern);
  return (subject: string) => {
    const norm = subject.replace(/\\/g, "/").replace(/^\.\//, "");
    return rx.test(norm);
  };
}

/**
 * Match a relative path against a single pattern. Convenience wrapper that
 * compiles and discards the matcher in one call; use {@link compileGlob} in
 * hot loops.
 *
 * @param subject - Relative path to test (backslashes and leading `./` tolerated).
 * @param pattern - Forward-slash glob pattern.
 * @returns True when the path matches the pattern.
 */
export function matchGlob(subject: string, pattern: string): boolean {
  return compileGlob(pattern)(subject);
}

/**
 * Match a path against several patterns, returning true on the first match.
 * Normalizes the subject once, then compiles each pattern as needed.
 *
 * @param subject - Relative path to test (backslashes and leading `./` tolerated).
 * @param patterns - Glob patterns to try in order.
 * @returns True if any pattern matches the path.
 */
export function matchAnyGlob(subject: string, patterns: readonly string[]): boolean {
  const norm = subject.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const p of patterns) {
    if (globToRegExp(p).test(norm)) return true;
  }
  return false;
}
