#!/usr/bin/env node

/**
 * ClaudeSync MCP Server
 *
 * SECURITY NOTE: This server uses stdio transport ONLY.
 * Network transports (SSE, HTTP) would expose the claude.ai session
 * cookie to any network client and are explicitly unsafe. Do not add
 * network transport support without implementing proper auth isolation.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
const transport = new StdioServerTransport();

// Guarantee process exit when the client disconnects: stdin EOF is the only
// shutdown signal a stdio MCP server reliably gets, and any stray handle
// (e.g. a keep-alive socket) would otherwise keep the event loop -- and the
// `docker run --rm` container wrapping us -- alive indefinitely.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

await server.connect(transport);
