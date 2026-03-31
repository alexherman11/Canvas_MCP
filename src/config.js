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

if (!CANVAS_BASE_URL || !CANVAS_API_TOKEN) {
  console.error(
    'Missing CANVAS_BASE_URL or CANVAS_API_TOKEN. ' +
    'Copy .env.example to .env and fill in your credentials.'
  );
  process.exit(1);
}

// Strip trailing slash
const baseUrl = CANVAS_BASE_URL.replace(/\/+$/, '');

export const config = {
  baseUrl,
  apiToken: CANVAS_API_TOKEN,
  apiBase: `${baseUrl}/api/v1`,
};
