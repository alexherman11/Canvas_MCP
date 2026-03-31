import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, appendFileSync } from 'fs';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');

// Only load .env if it exists; Claude Desktop passes env vars directly.
// quiet: true suppresses dotenv's stdout banner which corrupts MCP stdio.
if (existsSync(envPath)) {
  dotenv.config({ path: envPath, quiet: true });
}

const CANVAS_BASE_URL = process.env.CANVAS_BASE_URL;
const CANVAS_API_TOKEN = process.env.CANVAS_API_TOKEN;

// Warn instead of crashing — in remote multi-tenant mode these may not be set.
if (!CANVAS_BASE_URL || !CANVAS_API_TOKEN) {
  console.error(
    'CANVAS_BASE_URL or CANVAS_API_TOKEN not set. ' +
    'Stdio mode requires these in .env or environment. ' +
    'Remote mode reads credentials from request headers or stored credentials instead.'
  );
}

// Auto-generate ENCRYPTION_KEY if missing (local dev convenience).
// On Railway / production, set it as an environment variable.
let encryptionKey = process.env.ENCRYPTION_KEY;
if (!encryptionKey) {
  encryptionKey = randomBytes(32).toString('base64');
  console.error(
    'ENCRYPTION_KEY not set — auto-generated for this session. ' +
    'Set ENCRYPTION_KEY in your environment for persistent credential storage.',
  );
  // Persist to .env so the key survives restarts during local dev
  try {
    appendFileSync(envPath, `\nENCRYPTION_KEY=${encryptionKey}\n`);
    console.error(`ENCRYPTION_KEY written to ${envPath}`);
  } catch {
    // Non-fatal: in read-only environments we just keep the in-memory key
  }
}

// Strip trailing slash if present
const baseUrl = CANVAS_BASE_URL ? CANVAS_BASE_URL.replace(/\/+$/, '') : '';
const PORT = process.env.PORT || 3000;

export const config = {
  baseUrl,
  apiToken: CANVAS_API_TOKEN ?? '',
  apiBase: baseUrl ? `${baseUrl}/api/v1` : '',

  // Encryption
  encryptionKey,

  // OAuth 2.0
  oauthClientId: process.env.OAUTH_CLIENT_ID ?? '',
  oauthClientSecret: process.env.OAUTH_CLIENT_SECRET ?? '',
  oauthRedirectUri: process.env.OAUTH_REDIRECT_URI || `http://localhost:${PORT}/callback`,

  // Database
  dbPath: process.env.DB_PATH || join(__dirname, '..', 'data', 'credentials.db'),
};
