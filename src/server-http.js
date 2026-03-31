#!/usr/bin/env node

/**
 * Remote HTTP entry point for the Canvas MCP server.
 * Uses Streamable HTTP transport (SSE) for deployment on Railway or similar.
 *
 * Clients connect via POST/GET/DELETE on /mcp.
 * Canvas credentials come per-request via headers:
 *   x-canvas-api-token  — Canvas API token
 *   x-canvas-base-url   — Canvas instance URL (e.g. https://canvas.school.edu)
 *
 * Or via environment variables for single-tenant mode.
 */

import './config.js'; // Load .env if present
import express from 'express';
import cors from 'cors';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { allTools } from './tools/index.js';
import { handleConnect, handleCallback, handleConfigure, handleAuthStatus } from './auth.js';
import * as db from './db.js';

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Accept',
    'mcp-session-id',
    'mcp-protocol-version',
    'x-canvas-api-token',
    'x-canvas-base-url',
    'x-credential-id',
  ],
  exposedHeaders: ['mcp-session-id'],
}));

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/** Map of session ID → { transport, server } */
const sessions = new Map();

/** Create a fresh McpServer with all tools registered. */
function createServer() {
  const server = new McpServer({
    name: 'canvas-lms',
    version: '1.0.0',
  });

  for (const tool of allTools) {
    server.tool(tool.name, tool.config.description, tool.config.inputSchema, async (args, extra) => {
      try {
        return await tool.handler(args, extra);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  return server;
}

// ---------------------------------------------------------------------------
// Initialize credential database
// ---------------------------------------------------------------------------

db.getDb();

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

app.get('/connect', handleConnect);
app.get('/callback', handleCallback);
app.post('/configure', handleConfigure);
app.get('/auth/status/:credentialId', handleAuthStatus);

// ---------------------------------------------------------------------------
// MCP endpoint — POST (JSON-RPC requests), GET (SSE stream), DELETE (close)
// ---------------------------------------------------------------------------

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  // Existing session
  if (sessionId && sessions.has(sessionId)) {
    const { transport } = sessions.get(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Stale session ID — tell the client to re-initialize instead of silently
  // creating a new transport that will reject non-initialize requests with 400.
  if (sessionId) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Session not found. The server may have restarted — please reconnect.' },
      id: null,
    });
    return;
  }

  // Capture credential ID from the initial request for session binding
  const credentialId = req.headers['x-credential-id'];

  // New session — create server + transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, server });
      // Bind this MCP session to the credential if provided
      if (credentialId) {
        try { db.bindSession(id, credentialId); } catch { /* non-fatal */ }
      }
    },
  });

  transport.onclose = () => {
    const id = transport.sessionId;
    if (id) {
      sessions.delete(id);
      try { db.unbindSession(id); } catch { /* non-fatal */ }
    }
  };

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(400).json({ error: 'Invalid or missing session ID' });
    return;
  }
  const { transport } = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Canvas MCP server (HTTP) listening on 0.0.0.0:${PORT}`);
  console.log(`  MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`  Health check: http://0.0.0.0:${PORT}/health`);
});
