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
await server.connect(transport);
