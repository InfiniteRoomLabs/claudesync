import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuthError } from "../errors.js";

// Mock node:fs before importing the module under test
vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock better-sqlite3
const mockGet = vi.fn();
const mockPrepare = vi.fn(() => ({ get: mockGet }));
const mockClose = vi.fn();

vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn(() => ({
      prepare: mockPrepare,
      close: mockClose,
    })),
  };
});

// Import after mocks are set up
import { existsSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { FirefoxProfileAuth } from "../firefox.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const MockedDatabase = vi.mocked(Database);

const PROFILES_INI = `[General]
StartWithLastProfile=1

[Profile0]
Name=default-release
IsRelative=1
Path=abcd1234.default-release
Default=1
`;

const PROFILES_INI_NO_DEFAULT = `[General]
StartWithLastProfile=1

[Profile0]
Name=default
IsRelative=1
Path=wxyz5678.default
`;

const PROFILES_INI_ABSOLUTE = `[General]
StartWithLastProfile=1

[Profile0]
Name=custom
IsRelative=0
Path=/opt/firefox-profiles/custom
Default=1
`;

describe("FirefoxProfileAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("profile path discovery", () => {
    it("throws AuthError when no Firefox installation is found", () => {
      mockedExistsSync.mockReturnValue(false);

      expect(() => new FirefoxProfileAuth()).toThrow(AuthError);
      expect(() => new FirefoxProfileAuth()).toThrow(
        /Could not find a Firefox installation/
      );
    });

    it("uses explicitly provided profilePath without discovery", () => {
      // The profilePath itself must exist (cookies.sqlite check)
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        return path.endsWith("cookies.sqlite");
      });

      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      const auth = new FirefoxProfileAuth({
        profilePath: "/custom/firefox/profile",
      });
      expect(auth).toBeDefined();

      // Should NOT have tried to read profiles.ini
      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe("profiles.ini parsing", () => {
    it("resolves the default profile from profiles.ini", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        // Firefox root exists
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        // profiles.ini exists
        if (path.endsWith("profiles.ini")) return true;
        // cookies.sqlite exists
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI);
      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      const auth = new FirefoxProfileAuth();
      expect(auth).toBeDefined();

      // Verify profiles.ini was read
      expect(mockedReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining("profiles.ini"),
        "utf-8"
      );
    });

    it("falls back to first profile when no Default=1 is set", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI_NO_DEFAULT);
      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      // Should not throw -- falls back to Profile0
      const auth = new FirefoxProfileAuth();
      expect(auth).toBeDefined();
    });

    it("handles absolute paths in profiles.ini", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI_ABSOLUTE);
      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      const auth = new FirefoxProfileAuth();
      expect(auth).toBeDefined();

      // Database should have been opened with the absolute path
      expect(MockedDatabase).toHaveBeenCalledWith(
        expect.stringContaining("/opt/firefox-profiles/custom/cookies.sqlite"),
        expect.any(Object)
      );
    });

    it("throws AuthError when profiles.ini is missing", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        // Firefox root exists but profiles.ini does not
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        return false;
      });

      expect(() => new FirefoxProfileAuth()).toThrow(AuthError);
      expect(() => new FirefoxProfileAuth()).toThrow(/profiles\.ini not found/);
    });
  });

  describe("cookie reading", () => {
    it("throws AuthError when cookies.sqlite is missing", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        // cookies.sqlite does NOT exist
        if (path.endsWith("cookies.sqlite")) return false;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI);

      expect(() => new FirefoxProfileAuth()).toThrow(AuthError);
      expect(() => new FirefoxProfileAuth()).toThrow(
        /cookies\.sqlite not found/
      );
    });

    it("throws AuthError when sessionKey cookie is not found", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI);
      mockGet.mockReturnValue(undefined); // No cookie found

      expect(() => new FirefoxProfileAuth()).toThrow(AuthError);
      expect(() => new FirefoxProfileAuth()).toThrow(
        /No sessionKey cookie found/
      );
    });

    it("queries only sessionKey cookie for claude.ai", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI);
      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      new FirefoxProfileAuth();

      expect(mockPrepare).toHaveBeenCalledWith(
        "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai%' AND name = 'sessionKey'"
      );
    });
  });

  describe("database handling", () => {
    it("opens the database with immutable=1 URI flag and readonly mode", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI);
      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      new FirefoxProfileAuth();

      expect(MockedDatabase).toHaveBeenCalledWith(
        expect.stringMatching(/^file:.*cookies\.sqlite\?immutable=1$/),
        { readonly: true, fileMustExist: true }
      );
    });

    it("closes the database connection after reading", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI);
      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      new FirefoxProfileAuth();

      expect(mockClose).toHaveBeenCalledOnce();
    });

    it("closes the database even when the cookie is not found", () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("/firefox") || path.endsWith("/.mozilla/firefox"))
          return true;
        if (path.endsWith("profiles.ini")) return true;
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockedReadFileSync.mockReturnValue(PROFILES_INI);
      mockGet.mockReturnValue(undefined);

      try {
        new FirefoxProfileAuth();
      } catch {
        // expected
      }

      expect(mockClose).toHaveBeenCalledOnce();
    });
  });

  describe("getHeaders()", () => {
    it("returns headers with sessionKey cookie and Chrome User-Agent", async () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      const auth = new FirefoxProfileAuth({
        profilePath: "/mock/profile",
      });

      const headers = await auth.getHeaders();

      expect(headers["Cookie"]).toBe("sessionKey=sk-test-session-key");
      expect(headers["User-Agent"]).toContain("Chrome/");
      expect(headers["Accept"]).toBe("application/json");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("caches the session key and does not re-read the database", async () => {
      mockedExistsSync.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("cookies.sqlite")) return true;
        return false;
      });

      mockGet.mockReturnValue({ value: "sk-test-session-key" });

      const auth = new FirefoxProfileAuth({
        profilePath: "/mock/profile",
      });

      // Database was opened once during construction
      expect(MockedDatabase).toHaveBeenCalledOnce();

      // Multiple getHeaders calls should NOT re-open the database
      await auth.getHeaders();
      await auth.getHeaders();
      await auth.getHeaders();

      expect(MockedDatabase).toHaveBeenCalledOnce();
    });
  });
});
