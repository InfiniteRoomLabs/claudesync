import { describe, expect, it } from "vitest";
import { buildUrl, ENDPOINTS } from "../endpoints.js";

describe("buildUrl", () => {
  it("builds organizations URL", () => {
    expect(buildUrl(ENDPOINTS.organizations)).toBe(
      "https://claude.ai/api/organizations"
    );
  });

  it("builds conversations list URL", () => {
    expect(buildUrl(ENDPOINTS.conversations("org-123"))).toBe(
      "https://claude.ai/api/organizations/org-123/chat_conversations"
    );
  });

  it("builds single conversation URL", () => {
    expect(buildUrl(ENDPOINTS.conversation("org-123", "chat-456"))).toBe(
      "https://claude.ai/api/organizations/org-123/chat_conversations/chat-456"
    );
  });

  it("builds search URL", () => {
    expect(buildUrl(ENDPOINTS.search("org-123", "hello", 10))).toBe(
      "https://claude.ai/api/organizations/org-123/conversation/search?query=hello&n=10"
    );
  });

  it("builds projects URL", () => {
    expect(buildUrl(ENDPOINTS.projects("org-123"))).toBe(
      "https://claude.ai/api/organizations/org-123/projects"
    );
  });

  it("builds wiggle list-files URL", () => {
    expect(
      buildUrl(ENDPOINTS.artifactListFiles("org-123", "conv-456"))
    ).toBe(
      "https://claude.ai/api/organizations/org-123/conversations/conv-456/wiggle/list-files"
    );
  });

  it("builds wiggle download-file URL", () => {
    expect(
      buildUrl(
        ENDPOINTS.artifactDownloadFile(
          "org-123",
          "conv-456",
          "/mnt/user-data/outputs/file.md"
        )
      )
    ).toBe(
      "https://claude.ai/api/organizations/org-123/conversations/conv-456/wiggle/download-file?path=%2Fmnt%2Fuser-data%2Foutputs%2Ffile.md"
    );
  });
});
