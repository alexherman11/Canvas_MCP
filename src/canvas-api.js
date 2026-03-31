import { config } from './config.js';

/**
 * Lightweight Canvas REST API client.
 * Handles auth headers, pagination, and rate-limit / error retries.
 */

const HEADERS = {
  Authorization: `Bearer ${config.apiToken}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse the Link header and return the URL for rel="next", or null. */
function getNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

/** Sleep for ms milliseconds. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Core request
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Canvas API.
 * Retries on 429 (rate-limit) and transient 5xx errors.
 */
async function request(url, options = {}, retries = 3) {
  const res = await fetch(url, {
    ...options,
    headers: { ...HEADERS, ...options.headers },
  });

  // Rate-limited — back off and retry
  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get('Retry-After') || '5');
    await sleep(retryAfter * 1000);
    return request(url, options, retries - 1);
  }

  // Transient server error — retry with exponential back-off
  if (res.status >= 500 && retries > 0) {
    await sleep(2000 * (4 - retries));
    return request(url, options, retries - 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Canvas API ${res.status}: ${body}`);
  }

  return res;
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * GET a single JSON object from Canvas.
 */
export async function get(path, params = {}) {
  const url = new URL(`${config.apiBase}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await request(url.toString());
  return res.json();
}

/**
 * GET all pages of a paginated Canvas endpoint. Returns a flat array.
 * Canvas uses Link-header pagination with per_page up to 100.
 */
export async function getAll(path, params = {}) {
  const items = [];
  const url = new URL(`${config.apiBase}${path}`);
  url.searchParams.set('per_page', '100');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  let next = url.toString();
  while (next) {
    const res = await request(next);
    const data = await res.json();
    if (Array.isArray(data)) {
      items.push(...data);
    } else {
      items.push(data);
    }
    next = getNextLink(res.headers.get('Link'));
  }
  return items;
}

/**
 * POST JSON to Canvas.
 */
export async function post(path, body = {}) {
  const url = `${config.apiBase}${path}`;
  const res = await request(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * PUT JSON to Canvas.
 */
export async function put(path, body = {}) {
  const url = `${config.apiBase}${path}`;
  const res = await request(url, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return res.json();
}
