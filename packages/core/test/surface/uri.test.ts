import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseLocationUri } from "@core/surface/uri.js";

describe("parseLocationUri", () => {
  it("sugars a bare path to file:// (resolved to absolute)", () => {
    const u = parseLocationUri("./out");
    expect(u.scheme).toBe("file");
    expect(u.path).toBe(path.resolve("./out"));
    expect(u.query).toEqual({});
  });

  it("parses claude://me/conversations", () => {
    const u = parseLocationUri("claude://me/conversations");
    expect(u).toMatchObject({ scheme: "claude", host: "me", path: "/conversations" });
  });

  it("parses cc://local/projects", () => {
    const u = parseLocationUri("cc://local/projects");
    expect(u).toMatchObject({ scheme: "cc", host: "local", path: "/projects" });
  });

  it("parses s3 with a query (format is a sink property)", () => {
    const u = parseLocationUri("s3://garage/claude-archive?format=git");
    expect(u).toMatchObject({ scheme: "s3", host: "garage", path: "/claude-archive" });
    expect(u.query.format).toBe("git");
  });

  it("parses file:///abs/path with query", () => {
    const u = parseLocationUri("file:///abs/path?format=files");
    expect(u).toMatchObject({ scheme: "file", path: "/abs/path" });
    expect(u.query.format).toBe("files");
  });

  it("parses a user@host:port authority", () => {
    const u = parseLocationUri("rsync://user@host.example:873/module/path");
    expect(u).toMatchObject({
      scheme: "rsync",
      user: "user",
      host: "host.example",
      port: 873,
      path: "/module/path",
    });
  });
});
