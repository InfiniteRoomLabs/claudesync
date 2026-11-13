import { describe, expect, it } from "vitest";
import {
  buildDuetHeaders,
  DUET_DEFAULT_HEADERS,
  DUET_ENDPOINTS,
} from "@core/duet/endpoints.js";

describe("DUET_ENDPOINTS", () => {
  it("builds every endpoint path with encoded segments", () => {
    expect(DUET_ENDPOINTS.project).toBe("/v1/code/aibo/project");
    expect(DUET_ENDPOINTS.channels()).toBe(
      "/v1/code/channels?scope=joined&include_members=true&limit=100"
    );
    expect(DUET_ENDPOINTS.channels(25)).toContain("limit=25");
    expect(DUET_ENDPOINTS.timeline("chan_A")).toBe(
      "/v1/code/channels/chan_A/timeline?limit=200&include_replies=true"
    );
    expect(DUET_ENDPOINTS.timeline("chan_A", 50)).toContain("limit=50");
    expect(DUET_ENDPOINTS.thread("chan_A", "cmsg_B")).toBe(
      "/v1/code/channels/chan_A/threads/cmsg_B?limit=200"
    );
    expect(DUET_ENDPOINTS.messages("chan_A")).toBe(
      "/v1/code/channels/chan_A/messages"
    );
    expect(DUET_ENDPOINTS.tasks("chan_A")).toBe(
      "/v1/code/aibo/channels/chan_A/tasks?limit=200&include_adopted=true"
    );
    expect(DUET_ENDPOINTS.task("chan_A", "t1")).toBe(
      "/v1/code/aibo/channels/chan_A/tasks/t1"
    );
    // Identifiers are opaque, so anything unusual must be encoded, not trusted.
    expect(DUET_ENDPOINTS.timeline("a/b c")).toContain("/channels/a%2Fb%20c/");
  });
});

describe("Duet headers", () => {
  it("default headers carry the five static observed headers", () => {
    expect(DUET_DEFAULT_HEADERS).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "ccr-byoc-2025-07-29",
      "anthropic-client-app": "com.anthropic.aibo.web",
      "anthropic-client-feature": "ccr",
      "content-type": "application/json",
    });
  });

  it("buildDuetHeaders fills the org header", () => {
    const headers = buildDuetHeaders("org-123");
    expect(headers["x-organization-uuid"]).toBe("org-123");
    expect(headers["anthropic-beta"]).toBe("ccr-byoc-2025-07-29");
    expect(Object.keys(headers)).toHaveLength(6);
  });

  it("buildDuetHeaders applies overrides case-insensitively, and null removes a header", () => {
    const headers = buildDuetHeaders("org-123", {
      "Anthropic-Beta": "other-beta",
      "x-new": "1",
      "anthropic-client-feature": null,
    });
    expect(headers["anthropic-beta"]).toBe("other-beta");
    expect(headers["x-new"]).toBe("1");
    expect("anthropic-client-feature" in headers).toBe(false);
  });
});
