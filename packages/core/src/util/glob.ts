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

/** Compile a pattern once for repeated matching. */
export function compileGlob(pattern: string): (subject: string) => boolean {
  const rx = globToRegExp(pattern);
  return (subject: string) => {
    const norm = subject.replace(/\\/g, "/").replace(/^\.\//, "");
    return rx.test(norm);
  };
}

/** Match a relative path against a single pattern. Convenience wrapper. */
export function matchGlob(subject: string, pattern: string): boolean {
  return compileGlob(pattern)(subject);
}

/** True if any pattern matches. Compiles each pattern once per call. */
export function matchAnyGlob(subject: string, patterns: readonly string[]): boolean {
  const norm = subject.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const p of patterns) {
    if (globToRegExp(p).test(norm)) return true;
  }
  return false;
}
