/**
 * SQLite credential store using better-sqlite3.
 * Manages encrypted Canvas tokens and MCP session bindings.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

let _db;

/** Get (or lazily create) the singleton database connection. */
export function getDb() {
  if (_db) return _db;

  const dbPath = config.dbPath;
  mkdirSync(dirname(dbPath), { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS credentials (
      id               TEXT PRIMARY KEY,
      canvas_base_url  TEXT NOT NULL,
      access_token     TEXT NOT NULL,
      token_iv         TEXT NOT NULL,
      token_tag        TEXT NOT NULL,
      refresh_token    TEXT,
      refresh_iv       TEXT,
      refresh_tag      TEXT,
      canvas_user_id   INTEGER,
      canvas_user_name TEXT,
      source           TEXT NOT NULL DEFAULT 'manual',
      expires_at       INTEGER,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS session_bindings (
      mcp_session_id  TEXT PRIMARY KEY,
      credential_id   TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
      bound_at        INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  return _db;
}

// ---------------------------------------------------------------------------
// Credentials CRUD
// ---------------------------------------------------------------------------

/**
 * Insert a new credential row. Returns the generated credential ID.
 * @param {object} params
 * @param {string} params.canvasBaseUrl
 * @param {string} params.accessToken   - already encrypted (hex)
 * @param {string} params.tokenIv
 * @param {string} params.tokenTag
 * @param {string} [params.refreshToken] - already encrypted (hex)
 * @param {string} [params.refreshIv]
 * @param {string} [params.refreshTag]
 * @param {number} [params.canvasUserId]
 * @param {string} [params.canvasUserName]
 * @param {'oauth'|'manual'} [params.source]
 * @param {number} [params.expiresAt]    - unix seconds
 */
export function insertCredential(params) {
  const db = getDb();
  const id = randomUUID();
  db.prepare(`
    INSERT INTO credentials
      (id, canvas_base_url, access_token, token_iv, token_tag,
       refresh_token, refresh_iv, refresh_tag,
       canvas_user_id, canvas_user_name, source, expires_at)
    VALUES
      (@id, @canvasBaseUrl, @accessToken, @tokenIv, @tokenTag,
       @refreshToken, @refreshIv, @refreshTag,
       @canvasUserId, @canvasUserName, @source, @expiresAt)
  `).run({
    id,
    canvasBaseUrl: params.canvasBaseUrl,
    accessToken: params.accessToken,
    tokenIv: params.tokenIv,
    tokenTag: params.tokenTag,
    refreshToken: params.refreshToken ?? null,
    refreshIv: params.refreshIv ?? null,
    refreshTag: params.refreshTag ?? null,
    canvasUserId: params.canvasUserId ?? null,
    canvasUserName: params.canvasUserName ?? null,
    source: params.source ?? 'manual',
    expiresAt: params.expiresAt ?? null,
  });
  return id;
}

/** Retrieve a credential by its ID. Returns the row or undefined. */
export function getCredential(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
}

/**
 * Update the access token (and optionally refresh token) for a credential.
 * Used after an OAuth token refresh.
 */
export function updateTokens(id, { accessToken, tokenIv, tokenTag, refreshToken, refreshIv, refreshTag, expiresAt }) {
  const db = getDb();
  db.prepare(`
    UPDATE credentials SET
      access_token  = @accessToken,
      token_iv      = @tokenIv,
      token_tag     = @tokenTag,
      refresh_token = COALESCE(@refreshToken, refresh_token),
      refresh_iv    = COALESCE(@refreshIv, refresh_iv),
      refresh_tag   = COALESCE(@refreshTag, refresh_tag),
      expires_at    = @expiresAt,
      updated_at    = unixepoch()
    WHERE id = @id
  `).run({
    id,
    accessToken,
    tokenIv,
    tokenTag,
    refreshToken: refreshToken ?? null,
    refreshIv: refreshIv ?? null,
    refreshTag: refreshTag ?? null,
    expiresAt: expiresAt ?? null,
  });
}

/** Delete a credential and all its session bindings (cascade). */
export function deleteCredential(id) {
  const db = getDb();
  db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Session bindings
// ---------------------------------------------------------------------------

/** Bind an MCP session ID to a credential ID. */
export function bindSession(mcpSessionId, credentialId) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO session_bindings (mcp_session_id, credential_id)
    VALUES (?, ?)
  `).run(mcpSessionId, credentialId);
}

/** Look up a session binding. Returns { credential_id } or undefined. */
export function getSessionBinding(mcpSessionId) {
  const db = getDb();
  return db.prepare('SELECT credential_id FROM session_bindings WHERE mcp_session_id = ?').get(mcpSessionId);
}

/** Remove a session binding (called on MCP session close). */
export function unbindSession(mcpSessionId) {
  const db = getDb();
  db.prepare('DELETE FROM session_bindings WHERE mcp_session_id = ?').run(mcpSessionId);
}
