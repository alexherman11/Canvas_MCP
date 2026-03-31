import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

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
    'Remote mode reads credentials from request headers instead.'
  );
}

// Strip trailing slash if present
const baseUrl = CANVAS_BASE_URL ? CANVAS_BASE_URL.replace(/\/+$/, '') : '';

export const config = {
  baseUrl,
  apiToken: CANVAS_API_TOKEN ?? '',
  apiBase: baseUrl ? `${baseUrl}/api/v1` : '',
};
