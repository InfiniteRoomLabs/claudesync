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

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

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

/** Build a `file://` ParsedUri from a (possibly relative) local path. */
export function fileUri(localPath: string): ParsedUri {
  return { scheme: "file", path: path.resolve(localPath), query: {} };
}

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
