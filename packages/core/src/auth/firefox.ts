import type { AuthProvider } from "./types.js";
import { AuthError } from "./errors.js";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { platform } from "node:process";

/**
 * Default browser User-Agent sent with Firefox-sourced sessions. claude.ai sits
 * behind Cloudflare, which blocks non-browser clients, so a plausible
 * desktop-browser string is required; the exact value is not validated.
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * Candidate Firefox root directories, in priority order. The first one that
 * exists wins. On Linux the Snap location is checked early because it is the
 * default packaging on Ubuntu 24.04, ahead of native and Flatpak paths.
 *
 * @returns Absolute paths to probe for a Firefox installation, most-likely first.
 */
function getFirefoxRootCandidates(): string[] {
  const home = homedir();

  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "Firefox")];
  }

  // Linux: Snap is default on Ubuntu 24.04, so check it first
  return [
    join(home, ".mozilla", "firefox"),
    join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
  ];
}

/**
 * Parse `profiles.ini` to find the default profile directory.
 *
 * The INI file contains `[Profile0]`, `[Profile1]`, etc. sections. The first
 * profile with `Default=1` wins; if none is marked default, the first profile
 * encountered is used as a fallback. A profile's `Path` is joined onto
 * `firefoxRoot` when `IsRelative=1`, otherwise treated as absolute.
 *
 * @param firefoxRoot - Absolute path to the Firefox root that contains `profiles.ini`.
 * @returns Absolute path to the resolved profile directory.
 * @throws {@link AuthError} if `profiles.ini` is missing or contains no profile entries.
 */
function resolveProfileDir(firefoxRoot: string): string {
  const iniPath = join(firefoxRoot, "profiles.ini");
  if (!existsSync(iniPath)) {
    throw new AuthError(
      `Firefox profiles.ini not found at ${iniPath}. ` +
        "Is Firefox installed?"
    );
  }

  const content = readFileSync(iniPath, "utf-8");
  const lines = content.split(/\r?\n/);

  let currentPath: string | null = null;
  let currentIsRelative = true;
  let currentIsDefault = false;
  let fallbackPath: string | null = null;
  let fallbackIsRelative = true;
  let inProfileSection = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Section header
    if (trimmed.startsWith("[")) {
      // Before moving to a new section, check if the previous section was the default
      if (inProfileSection && currentIsDefault && currentPath) {
        return currentIsRelative
          ? join(firefoxRoot, currentPath)
          : currentPath;
      }

      inProfileSection = /^\[Profile\d+\]$/i.test(trimmed);
      if (inProfileSection) {
        // Reset per-section state
        currentPath = null;
        currentIsRelative = true;
        currentIsDefault = false;

        // Track the very first profile as fallback
        if (fallbackPath === null) {
          // We'll set fallbackPath when we encounter the Path key
        }
      }
      continue;
    }

    if (!inProfileSection) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (key === "Path") {
      currentPath = value;
      if (fallbackPath === null) {
        fallbackPath = value;
        fallbackIsRelative = currentIsRelative;
      }
    } else if (key === "IsRelative") {
      currentIsRelative = value === "1";
      // Update fallback if this is the first profile section
      if (fallbackPath === null) {
        fallbackIsRelative = currentIsRelative;
      }
    } else if (key === "Default" && value === "1") {
      currentIsDefault = true;
    }
  }

  // Check the last section (loop may have ended inside a profile section)
  if (inProfileSection && currentIsDefault && currentPath) {
    return currentIsRelative
      ? join(firefoxRoot, currentPath)
      : currentPath;
  }

  // No explicit default found -- use the first profile
  if (fallbackPath) {
    return fallbackIsRelative
      ? join(firefoxRoot, fallbackPath)
      : fallbackPath;
  }

  throw new AuthError(
    `No profile entries found in ${iniPath}. ` +
      "The profiles.ini file may be corrupted."
  );
}

/**
 * Auto-discover the Firefox profile directory by probing the standard install
 * locations from {@link getFirefoxRootCandidates} and resolving the default
 * profile of the first one that exists.
 *
 * @returns Absolute path to the discovered profile directory.
 * @throws {@link AuthError} if no Firefox installation is found; the message
 * lists every path checked and points to the explicit `profilePath` option.
 */
function discoverProfilePath(): string {
  const candidates = getFirefoxRootCandidates();

  for (const root of candidates) {
    if (existsSync(root)) {
      return resolveProfileDir(root);
    }
  }

  throw new AuthError(
    "Could not find a Firefox installation. Checked:\n" +
      candidates.map((c) => `  - ${c}`).join("\n") +
      "\n\nProvide the profile path explicitly via the profilePath option."
  );
}

/**
 * Read the `sessionKey` cookie for claude.ai from Firefox's `cookies.sqlite`.
 *
 * Opens the database read-only with the `immutable=1` URI flag so the read does
 * not contend with Firefox's WAL journal while the browser is running. The
 * connection is always closed in a `finally` block.
 *
 * @param profilePath - Absolute path to the Firefox profile directory.
 * @returns The raw `sessionKey` cookie value.
 * @throws {@link AuthError} if `cookies.sqlite` is missing or holds no
 * claude.ai `sessionKey` (typically: not logged in to claude.ai in Firefox).
 */
function readSessionCookie(profilePath: string): string {
  const cookiesPath = join(profilePath, "cookies.sqlite");
  if (!existsSync(cookiesPath)) {
    throw new AuthError(
      `cookies.sqlite not found at ${cookiesPath}. ` +
        "Make sure the Firefox profile path is correct and Firefox has been used at least once."
    );
  }

  const uri = `file:${cookiesPath}?immutable=1`;
  let db: Database.Database | null = null;

  try {
    db = new Database(uri, { readonly: true, fileMustExist: true });

    const row = db
      .prepare(
        "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name = 'sessionKey'"
      )
      .get() as { value: string } | undefined;

    if (!row) {
      throw new AuthError(
        "No sessionKey cookie found for claude.ai in Firefox. " +
          "Make sure you are logged in to claude.ai in Firefox."
      );
    }

    return row.value;
  } finally {
    if (db) {
      db.close();
    }
  }
}

/**
 * {@link AuthProvider} that reads the claude.ai `sessionKey` directly from a
 * local Firefox profile's cookie store, no env var or manual copy-paste needed.
 *
 * Used when the SDK runs on the same host as the user's Firefox (e.g. the CLI
 * outside a container). The profile is auto-discovered unless an explicit path
 * is given. The cookie is read once at construction.
 */
export class FirefoxProfileAuth implements AuthProvider {
  /** Raw `sessionKey` cookie value read from the Firefox profile. */
  private readonly sessionKey: string;
  /** User-Agent header; always {@link DEFAULT_USER_AGENT} for this provider. */
  private readonly userAgent: string;
  /** Memoized organization UUID; `null` until the first {@link FirefoxProfileAuth.getOrganizationId} call. */
  private cachedOrgId: string | null = null;

  /**
   * @param options - Optional settings.
   * @param options.profilePath - Absolute path to a Firefox profile directory.
   * When omitted, the profile is auto-discovered via {@link discoverProfilePath}.
   * @throws {@link AuthError} if the profile cannot be found or the `sessionKey`
   * cookie cannot be read.
   */
  constructor(options?: { profilePath?: string }) {
    const profilePath = options?.profilePath ?? discoverProfilePath();
    this.sessionKey = readSessionCookie(profilePath);
    this.userAgent = DEFAULT_USER_AGENT;
  }

  /** {@inheritDoc AuthProvider.getHeaders} */
  async getHeaders(): Promise<Record<string, string>> {
    return {
      Cookie: `sessionKey=${this.sessionKey}`,
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  /** {@inheritDoc AuthProvider.getOrganizationId} */
  async getOrganizationId(): Promise<string> {
    if (this.cachedOrgId) {
      return this.cachedOrgId;
    }

    const headers = await this.getHeaders();
    const response = await fetch("https://claude.ai/api/organizations", {
      headers,
    });

    if (!response.ok) {
      throw new AuthError(
        `Failed to fetch organizations: ${response.status} ${response.statusText}`
      );
    }

    const orgs = await response.json();
    if (!Array.isArray(orgs) || orgs.length === 0 || !orgs[0].uuid) {
      throw new AuthError("No organizations found for this session");
    }

    this.cachedOrgId = orgs[0].uuid as string;
    return this.cachedOrgId;
  }
}
