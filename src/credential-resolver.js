/**
 * Unified credential resolution for Canvas API access.
 *
 * Priority chain:
 *  1. Explicit headers (x-canvas-api-token + x-canvas-base-url) — backward compatible
 *  2. x-credential-id header — look up encrypted token in DB
 *  3. Session binding (MCP sessionId → DB) — for persistent sessions
 *  4. Environment variables — stdio / single-tenant fallback
 */

import * as db from './db.js';
import { decrypt } from './crypto.js';
import { refreshAccessToken } from './auth.js';

/**
 * Resolve Canvas API credentials from the MCP request context.
 * Returns { apiBase: string, apiToken: string }.
 */
export async function resolveCredentials(extra) {
  const headers = extra?.requestInfo?.headers;

  // 1. Explicit headers (backward compatible)
  const headerToken = headers?.['x-canvas-api-token'];
  const headerBaseUrl = headers?.['x-canvas-base-url'];
  if (headerToken && headerBaseUrl) {
    const baseUrl = String(headerBaseUrl).replace(/\/+$/, '');
    return { apiBase: `${baseUrl}/api/v1`, apiToken: String(headerToken) };
  }

  // 2. Credential ID header → DB lookup
  const credentialId = headers?.['x-credential-id'];
  if (credentialId) {
    return lookupCredential(String(credentialId));
  }

  // 3. Session-bound credentials
  const sessionId = extra?.sessionId;
  if (sessionId) {
    const binding = db.getSessionBinding(sessionId);
    if (binding) {
      return lookupCredential(binding.credential_id);
    }
  }

  // 3b. Stdio-only fallback: use the most recent stored credential.
  //     SECURITY: In remote (HTTP) mode, skip this — each client must identify
  //     themselves via x-credential-id header, session binding, or canvas_resume_session.
  //     extra.requestInfo is set by StreamableHTTPServerTransport but absent in stdio.
  if (!extra?.requestInfo) {
    const latest = db.getLatestCredential();
    if (latest) {
      if (sessionId) {
        try { db.bindSession(sessionId, latest.id); } catch { /* non-fatal */ }
      }
      return lookupCredential(latest.id);
    }
  }

  // 4. Environment variables
  const apiToken = process.env.CANVAS_API_TOKEN;
  const baseUrl = process.env.CANVAS_BASE_URL?.replace(/\/+$/, '');
  if (apiToken && baseUrl) {
    return { apiBase: `${baseUrl}/api/v1`, apiToken };
  }

  throw new Error(
    'No Canvas credentials found. ' +
    'If you have a Canvas credential_id saved in memory from a prior conversation, ' +
    'call canvas_resume_session with it. ' +
    'Otherwise, ask the user for their Canvas URL and API token, then call canvas_configure.',
  );
}

/**
 * Look up and decrypt a credential from the database.
 * Automatically refreshes expired OAuth tokens.
 */
async function lookupCredential(credentialId) {
  const cred = db.getCredential(credentialId);
  if (!cred) {
    throw new Error('Credential not found. Please reconnect via /connect or /configure.');
  }

  // Auto-refresh if token expires within 5 minutes
  const now = Math.floor(Date.now() / 1000);
  if (cred.expires_at && now > cred.expires_at - 300 && cred.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(credentialId);
      const baseUrl = cred.canvas_base_url.replace(/\/+$/, '');
      return { apiBase: `${baseUrl}/api/v1`, apiToken: refreshed };
    } catch (err) {
      // If refresh fails but token hasn't actually expired yet, try the old one
      if (now < cred.expires_at) {
        console.error(`Token refresh failed (using existing token): ${err.message}`);
      } else {
        throw new Error(`Token expired and refresh failed: ${err.message}. Please reconnect via /connect.`);
      }
    }
  }

  const apiToken = decrypt(cred.access_token, cred.token_iv, cred.token_tag);
  const baseUrl = cred.canvas_base_url.replace(/\/+$/, '');
  return { apiBase: `${baseUrl}/api/v1`, apiToken };
}
