/**
 * Authentication module: OAuth 2.0 flow, manual /configure endpoint,
 * and token refresh logic for Canvas LMS.
 */

import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';
import * as db from './db.js';

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

/** Pending OAuth state tokens → { canvasBaseUrl, createdAt } */
const pendingOAuth = new Map();

/** Concurrency guard: credentialId → Promise<string> for in-flight refreshes */
const refreshInFlight = new Map();

// Clean up expired OAuth states every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, data] of pendingOAuth) {
    if (data.createdAt < cutoff) pendingOAuth.delete(state);
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// OAuth 2.0 endpoints (mounted as Express route handlers)
// ---------------------------------------------------------------------------

/**
 * GET /connect?canvas_url=https://canvas.school.edu
 * Initiates the Canvas OAuth 2.0 authorization flow.
 */
export function handleConnect(req, res) {
  const canvasUrl = req.query.canvas_url;
  if (!canvasUrl) {
    return res.status(400).json({ error: 'Missing canvas_url query parameter' });
  }

  if (!config.oauthClientId) {
    return res.status(500).json({ error: 'OAUTH_CLIENT_ID is not configured on the server' });
  }

  const baseUrl = String(canvasUrl).replace(/\/+$/, '');
  const state = randomUUID();
  pendingOAuth.set(state, { canvasBaseUrl: baseUrl, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: config.oauthClientId,
    response_type: 'code',
    redirect_uri: config.oauthRedirectUri,
    state,
  });

  const authUrl = `${baseUrl}/login/oauth2/auth?${params}`;
  res.redirect(authUrl);
}

/**
 * GET /callback?code=AUTH_CODE&state=STATE
 * Handles the Canvas OAuth 2.0 callback, exchanges code for tokens.
 */
export async function handleCallback(req, res) {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    return res.status(400).json({ error: `OAuth error: ${oauthError}` });
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state parameter' });
  }

  const pending = pendingOAuth.get(state);
  if (!pending) {
    return res.status(400).json({ error: 'Invalid or expired state token. Please restart the connection flow.' });
  }

  // Check TTL (10 minutes)
  if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
    pendingOAuth.delete(state);
    return res.status(400).json({ error: 'State token expired. Please restart the connection flow.' });
  }

  pendingOAuth.delete(state);

  try {
    // Exchange authorization code for tokens
    const tokenRes = await fetch(`${pending.canvasBaseUrl}/login/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.oauthClientId,
        client_secret: config.oauthClientSecret,
        code,
        redirect_uri: config.oauthRedirectUri,
      }),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      return res.status(502).json({ error: `Canvas token exchange failed: ${tokenRes.status} ${body}` });
    }

    const tokenData = await tokenRes.json();
    const { access_token, refresh_token, expires_in, user } = tokenData;

    // Encrypt tokens
    const accessEnc = encrypt(access_token);
    const refreshEnc = refresh_token ? encrypt(refresh_token) : {};

    // Store in database
    const credentialId = db.insertCredential({
      canvasBaseUrl: pending.canvasBaseUrl,
      accessToken: accessEnc.ciphertext,
      tokenIv: accessEnc.iv,
      tokenTag: accessEnc.tag,
      refreshToken: refreshEnc.ciphertext ?? null,
      refreshIv: refreshEnc.iv ?? null,
      refreshTag: refreshEnc.tag ?? null,
      canvasUserId: user?.id ?? null,
      canvasUserName: user?.name ?? null,
      source: 'oauth',
      expiresAt: expires_in ? Math.floor(Date.now() / 1000) + expires_in : null,
    });

    res.json({
      credential_id: credentialId,
      canvas_user: user ?? null,
      expires_in: expires_in ?? null,
      message: 'Connected successfully. Use this credential_id in the x-credential-id header for MCP requests.',
    });
  } catch (err) {
    res.status(500).json({ error: `OAuth callback failed: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Manual token configuration
// ---------------------------------------------------------------------------

/**
 * POST /configure
 * Body: { canvas_base_url, canvas_api_token }
 * Stores a manually-provided Canvas API token encrypted in the database.
 */
export async function handleConfigure(req, res) {
  const { canvas_base_url, canvas_api_token } = req.body ?? {};

  if (!canvas_base_url || !canvas_api_token) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['canvas_base_url', 'canvas_api_token'],
    });
  }

  const baseUrl = String(canvas_base_url).replace(/\/+$/, '');

  // Verify the token works
  try {
    const testRes = await fetch(`${baseUrl}/api/v1/users/self`, {
      headers: { Authorization: `Bearer ${canvas_api_token}` },
    });
    if (!testRes.ok) {
      const body = await testRes.text();
      return res.status(400).json({ error: `Token verification failed: ${testRes.status} ${body}` });
    }
    var userData = await testRes.json();
  } catch (err) {
    return res.status(400).json({ error: `Could not reach Canvas: ${err.message}` });
  }

  // Encrypt and store
  const accessEnc = encrypt(canvas_api_token);
  const credentialId = db.insertCredential({
    canvasBaseUrl: baseUrl,
    accessToken: accessEnc.ciphertext,
    tokenIv: accessEnc.iv,
    tokenTag: accessEnc.tag,
    canvasUserId: userData.id ?? null,
    canvasUserName: userData.name ?? null,
    source: 'manual',
  });

  res.json({
    credential_id: credentialId,
    canvas_user: { id: userData.id, name: userData.name },
    message: 'Token stored successfully. Use this credential_id in the x-credential-id header for MCP requests.',
  });
}

// ---------------------------------------------------------------------------
// Auth status check
// ---------------------------------------------------------------------------

/**
 * GET /auth/status/:credentialId
 * Returns whether a credential is valid and its metadata.
 */
export function handleAuthStatus(req, res) {
  const cred = db.getCredential(req.params.credentialId);
  if (!cred) {
    return res.status(404).json({ status: 'not_found' });
  }

  const now = Math.floor(Date.now() / 1000);
  const expired = cred.expires_at ? now > cred.expires_at : false;
  const expiresIn = cred.expires_at ? Math.max(0, cred.expires_at - now) : null;

  res.json({
    status: expired ? 'expired' : 'active',
    source: cred.source,
    canvas_base_url: cred.canvas_base_url,
    canvas_user: cred.canvas_user_name ?? null,
    expires_in: expiresIn,
    has_refresh_token: !!cred.refresh_token,
    created_at: cred.created_at,
  });
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh the access token for a credential using its stored refresh token.
 * Returns the new plaintext access token.
 * Uses a concurrency guard to prevent duplicate refresh requests.
 */
export async function refreshAccessToken(credentialId) {
  // Concurrency guard: if a refresh is already in flight, await it
  if (refreshInFlight.has(credentialId)) {
    return refreshInFlight.get(credentialId);
  }

  const promise = doRefresh(credentialId);
  refreshInFlight.set(credentialId, promise);

  try {
    return await promise;
  } finally {
    refreshInFlight.delete(credentialId);
  }
}

async function doRefresh(credentialId) {
  const cred = db.getCredential(credentialId);
  if (!cred || !cred.refresh_token) {
    throw new Error('No refresh token available for this credential.');
  }

  if (!config.oauthClientId || !config.oauthClientSecret) {
    throw new Error('OAuth client credentials not configured — cannot refresh token.');
  }

  const refreshToken = decrypt(cred.refresh_token, cred.refresh_iv, cred.refresh_tag);

  const res = await fetch(`${cred.canvas_base_url}/login/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: config.oauthClientId,
      client_secret: config.oauthClientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Canvas refresh failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  const newAccessEnc = encrypt(data.access_token);

  // Canvas may or may not return a new refresh token
  const newRefreshEnc = data.refresh_token ? encrypt(data.refresh_token) : {};

  db.updateTokens(credentialId, {
    accessToken: newAccessEnc.ciphertext,
    tokenIv: newAccessEnc.iv,
    tokenTag: newAccessEnc.tag,
    refreshToken: newRefreshEnc.ciphertext ?? null,
    refreshIv: newRefreshEnc.iv ?? null,
    refreshTag: newRefreshEnc.tag ?? null,
    expiresAt: data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : null,
  });

  return data.access_token;
}
