import { resolveCredentials } from '../credential-resolver.js';

// ---------------------------------------------------------------------------
// Shared helpers for tool responses
// ---------------------------------------------------------------------------

export function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

export function error(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

/**
 * Build a Canvas API context from the MCP request.
 * Checks: headers → stored credentials (DB) → environment variables.
 */
export async function getCanvasContext(extra) {
  return resolveCredentials(extra);
}
