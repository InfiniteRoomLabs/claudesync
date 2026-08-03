import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Absolute path to the mcp-server package root (parent of `test/`). */
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The server process must exit when its stdin closes -- i.e. when the MCP
 * client disconnects. stdin EOF is the only shutdown signal a stdio MCP
 * server reliably gets; if the process lingers (stray handles, keep-alive
 * sockets), its `docker run --rm` container lingers with it and squats on
 * resources after the session that spawned it is gone.
 */
describe("stdin EOF", () => {
  it("exits the server process when stdin closes", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      cwd: pkgRoot,
      env: { ...process.env, CLAUDE_AI_COOKIE: "sk-ant-test-dummy" },
      // stderr is piped so a crashing child produces a diagnosable failure
      // instead of a bare nonzero exit code (this hid an unbuilt-dist crash
      // on CI for two releases).
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(`server did not exit within 10s of stdin EOF\nstderr:\n${stderr}`)
        );
      }, 10_000);
      child.on("exit", (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      child.on("error", reject);
    });
    expect(code, `server exited ${code}, expected 0\nstderr:\n${stderr}`).toBe(0);
  }, 15_000);
});
