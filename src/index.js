#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { allTools } from './tools.js';

const server = new McpServer({
  name: 'canvas-lms',
  version: '1.0.0',
});

// Register every tool from tools.js
for (const tool of allTools) {
  server.tool(tool.name, tool.config.description, tool.config.inputSchema, async (args) => {
    try {
      return await tool.handler(args);
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  });
}

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
