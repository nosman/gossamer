#!/usr/bin/env node
/**
 * Gossamer MCP stdio wrapper — for MCP clients that only support stdio transport.
 *
 * For clients that support the MCP streamable-HTTP transport, connect directly
 * to the Gossamer server's /mcp endpoint instead of using this wrapper.
 *
 * Usage: gossamer-mcp --port <gossamer-server-port>   (default: 3000)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";

const args = process.argv.slice(2);
let port = 3000;
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  }
}

const server    = createMcpServer(port);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`Gossamer MCP server running (stdio → http://localhost:${port})\n`);
