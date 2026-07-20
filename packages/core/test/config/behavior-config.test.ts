import { describe, it, expect } from "vitest";
import { resolveBehaviorConfig, envBool } from "@core/config/index.js";
import type { OnBecameEmpty } from "@core/sync/empty.js";

const noEnv = {} as NodeJS.ProcessEnv;

describe("resolveBehaviorConfig", () => {
  it("returns built-in defaults with no sources", () => {
    const c = resolveBehaviorConfig({}, noEnv, {});
    expect(c.skipEmptyConversations).toBe(true);
    expect(c.onBecameEmpty).toBe("sync");
  });

  it("applies config-file values", () => {
    const c = resolveBehaviorConfig(
      {},
      noEnv,
      { skipEmptyConversations: false, onBecameEmpty: "retain" }
    );
    expect(c.skipEmptyConversations).toBe(false);
    expect(c.onBecameEmpty).toBe("retain");
  });

  it("env overrides file", () => {
    const c = resolveBehaviorConfig(
      {},
      {
        CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: "false",
        CLAUDESYNC_ON_BECAME_EMPTY: "clean",
      } as NodeJS.ProcessEnv,
      { skipEmptyConversations: true, onBecameEmpty: "retain" }
    );
    expect(c.skipEmptyConversations).toBe(false);
    expect(c.onBecameEmpty).toBe("clean");
  });

  it("flag overrides env and file", () => {
    const c = resolveBehaviorConfig(
      { skipEmptyConversations: true, onBecameEmpty: "sync" },
      {
        CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: "false",
        CLAUDESYNC_ON_BECAME_EMPTY: "clean",
      } as NodeJS.ProcessEnv,
      { skipEmptyConversations: false, onBecameEmpty: "retain" }
    );
    expect(c.skipEmptyConversations).toBe(true);
    expect(c.onBecameEmpty).toBe("sync");
  });

  it("EXPLICIT false flag beats env/file true", () => {
    const c = resolveBehaviorConfig(
      { skipEmptyConversations: false },
      { CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: "true" } as NodeJS.ProcessEnv,
      { skipEmptyConversations: true }
    );
    expect(c.skipEmptyConversations).toBe(false);
  });

  it("explicit env false beats file true", () => {
    const c = resolveBehaviorConfig(
      {},
      { CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: "false" } as NodeJS.ProcessEnv,
      { skipEmptyConversations: true }
    );
    expect(c.skipEmptyConversations).toBe(false);
  });

  it("absent flag (undefined) does not override env", () => {
    const c = resolveBehaviorConfig(
      { skipEmptyConversations: undefined },
      { CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: "false" } as NodeJS.ProcessEnv,
      { skipEmptyConversations: true }
    );
    expect(c.skipEmptyConversations).toBe(false);
  });

  describe("onBecameEmpty enum validation", () => {
    it("accepts a valid value from the file", () => {
      const c = resolveBehaviorConfig({}, noEnv, { onBecameEmpty: "clean" });
      expect(c.onBecameEmpty).toBe("clean");
    });

    it("accepts a valid value from env", () => {
      const c = resolveBehaviorConfig(
        {},
        { CLAUDESYNC_ON_BECAME_EMPTY: "retain" } as NodeJS.ProcessEnv,
        {}
      );
      expect(c.onBecameEmpty).toBe("retain");
    });

    it("accepts a valid value from flags", () => {
      const c = resolveBehaviorConfig({ onBecameEmpty: "clean" }, noEnv, {});
      expect(c.onBecameEmpty).toBe("clean");
    });

    it("throws on an invalid file value", () => {
      expect(() =>
        resolveBehaviorConfig({}, noEnv, { onBecameEmpty: "explode" })
      ).toThrow();
    });

    it("throws on an invalid env value", () => {
      expect(() =>
        resolveBehaviorConfig(
          {},
          { CLAUDESYNC_ON_BECAME_EMPTY: "explode" } as NodeJS.ProcessEnv,
          {}
        )
      ).toThrow();
    });

    it("throws on an invalid flag value", () => {
      expect(() =>
        resolveBehaviorConfig(
          // Cast through unknown: exercises runtime validation of an
          // out-of-band value that the OnBecameEmpty type would otherwise
          // reject at compile time.
          { onBecameEmpty: "explode" as unknown as OnBecameEmpty },
          noEnv,
          {}
        )
      ).toThrow();
    });
  });
});

describe("envBool", () => {
  it("returns undefined when the key is unset", () => {
    expect(envBool(noEnv, "CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS")).toBeUndefined();
  });

  it.each(["1", "true", "TRUE", "True", "yes", "YES"])(
    "parses %s as true",
    (value) => {
      expect(
        envBool(
          { CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: value } as NodeJS.ProcessEnv,
          "CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS"
        )
      ).toBe(true);
    }
  );

  it.each(["0", "false", "FALSE", "False", "no", "NO"])(
    "parses %s as false",
    (value) => {
      expect(
        envBool(
          { CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: value } as NodeJS.ProcessEnv,
          "CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS"
        )
      ).toBe(false);
    }
  );

  it("throws on garbage values", () => {
    expect(() =>
      envBool(
        { CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS: "maybe" } as NodeJS.ProcessEnv,
        "CLAUDESYNC_SKIP_EMPTY_CONVERSATIONS"
      )
    ).toThrow();
  });
});
