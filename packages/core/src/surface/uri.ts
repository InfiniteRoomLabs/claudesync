/**
 * Parse a location string into a {@link ParsedUri}.
 *
 * Grammar: `scheme://[user@][host][:port]/path[?k=v&k=v]`. A string with no
 * scheme is treated as a local path and sugared to `file://` (resolved to an
 * absolute path), preserving the current CLI where `--output ./x` is a local
 * directory. This is the "`--output ./x` is parsed to `file:///abs/x`
 * internally" behavior the PRD's Phase 0 acceptance describes.
 *
 * We parse manually rather than via WHATWG `URL` to keep custom schemes
 * (`claude://`, `cc://`, `s3://`) and `file://` paths predictable -- `URL`
 * special-cases `file:` host handling in ways that mangle relative paths.
 */

import path from "node:path";
import type { ParsedUri } from "./types.js";

/** Matches `scheme://rest`, capturing the scheme and everything after `://`. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

/**
 * Parse a location string into a {@link ParsedUri}.
 *
 * A string with no `scheme://` prefix is treated as a local path and sugared to
 * `file://` with an absolute path (so `--output ./x` keeps working). For an
 * explicit `file://` URI the entire remainder is the path; for any other scheme
 * the first `/` splits the authority (`[user@]host[:port]`) from the path.
 *
 * @param input - A `scheme://[user@][host][:port]/path[?k=v]` string, or a bare local path.
 * @returns The parsed components, with `query` decoded.
 */
export function parseLocationUri(input: string): ParsedUri {
  const m = SCHEME_RE.exec(input);
  if (!m) {
    // Bare path -> file:// sugar.
    return { scheme: "file", path: path.resolve(input), query: {} };
  }

  const scheme = m[1].toLowerCase();
  let rest = m[2];

  // Split off the query string.
  let query: Record<string, string> = {};
  const qIdx = rest.indexOf("?");
  if (qIdx >= 0) {
    query = parseQuery(rest.slice(qIdx + 1));
    rest = rest.slice(0, qIdx);
  }

  if (scheme === "file") {
    // Everything after `file://` is the path. `file:///abs` -> `/abs`.
    // A non-absolute remainder is resolved against cwd.
    const p = rest.startsWith("/") ? rest : path.resolve(rest);
    return { scheme, path: p, query };
  }

  // Authority-style schemes: first "/" splits authority from path.
  const slash = rest.indexOf("/");
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const p = slash >= 0 ? rest.slice(slash) : "";
  const { user, host, port } = parseAuthority(authority);
  return { scheme, user, host, port, path: p, query };
}

/**
 * Build a `file://` {@link ParsedUri} from a (possibly relative) local path.
 *
 * @param localPath - A local path, resolved against cwd to an absolute path.
 * @returns A `file` URI pointing at the resolved absolute path.
 */
export function fileUri(localPath: string): ParsedUri {
  return { scheme: "file", path: path.resolve(localPath), query: {} };
}

/**
 * Split an authority component into its userinfo, host, and port parts.
 *
 * @param authority - The `[user@]host[:port]` substring (no scheme, no path).
 * @returns The parsed pieces; a trailing `:digits` is only treated as a port.
 */
function parseAuthority(authority: string): {
  user?: string;
  host?: string;
  port?: number;
} {
  let rest = authority;
  let user: string | undefined;
  const at = rest.indexOf("@");
  if (at >= 0) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let host: string | undefined = rest || undefined;
  let port: number | undefined;
  const colon = rest.lastIndexOf(":");
  if (colon >= 0) {
    const maybePort = rest.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) {
      port = Number.parseInt(maybePort, 10);
      host = rest.slice(0, colon) || undefined;
    }
  }
  return { user, host, port };
}

/**
 * Decode an `&`-separated query string into a key/value map.
 *
 * @param q - The raw query string (the part after `?`).
 * @returns Decoded parameters; a bare key with no `=` maps to an empty string.
 */
function parseQuery(q: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of q.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = decodeURIComponent(eq >= 0 ? pair.slice(0, eq) : pair);
    const val = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : "";
    out[key] = val;
  }
  return out;
}
