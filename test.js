#!/usr/bin/env node

/**
 * Canvas MCP Server — standalone test script.
 *
 * Usage:  node test.js
 *
 * Tests:
 *   1. Verifies Canvas API connectivity using .env credentials
 *   2. Calls each tool handler and prints results
 *   3. Starts the MCP server and confirms it responds to tools/list
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Helpers ---------------------------------------------------------------

let passed = 0;
let failed = 0;

function header(msg) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${msg}`);
  console.log('='.repeat(60));
}

async function runTest(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    const { result, detail } = await fn();
    console.log(detail ? `OK ${detail}` : 'OK');
    passed++;
    return result;
  } catch (err) {
    console.log(`FAIL — ${err.message}`);
    failed++;
    return null;
  }
}

// ---- Part 1: Direct Canvas API tests --------------------------------------

header('Part 1 — Canvas API connectivity');

// Dynamic import so .env is loaded
const { config } = await import('./src/config.js');
console.log(`  Base URL : ${config.baseUrl}`);
console.log(`  Token    : ${config.apiToken.slice(0, 8)}...`);

const canvas = await import('./src/canvas-api.js');

let courses = [];
courses = await runTest('Fetch active courses', async () => {
  const result = await canvas.getAll('/courses', {
    enrollment_state: 'active',
    state: 'available',
    per_page: 5,
  });
  if (!Array.isArray(result)) throw new Error('Expected array');
  return { result, detail: `(${result.length} courses)` };
}) ?? [];

let testCourseId = courses[0]?.id;

if (testCourseId) {
  await runTest(`Fetch assignments for course ${testCourseId}`, async () => {
    const result = await canvas.getAll(
      `/courses/${testCourseId}/assignments`,
      { per_page: 5 },
    );
    if (!Array.isArray(result)) throw new Error('Expected array');
    return { result, detail: `(${result.length} assignments)` };
  });

  await runTest(`Fetch enrollments/grades for course ${testCourseId}`, async () => {
    const result = await canvas.getAll(
      `/courses/${testCourseId}/enrollments`,
      { user_id: 'self' },
    );
    if (!Array.isArray(result)) throw new Error('Expected array');
    const g = result[0]?.grades;
    return { result, detail: g ? `(score: ${g.current_score})` : '' };
  });

  await runTest(`Fetch announcements for course ${testCourseId}`, async () => {
    const result = await canvas.getAll('/announcements', {
      'context_codes[]': `course_${testCourseId}`,
      per_page: 3,
    });
    if (!Array.isArray(result)) throw new Error('Expected array');
    return { result, detail: `(${result.length} announcements)` };
  });

  await runTest(`Fetch course files for course ${testCourseId}`, async () => {
    const result = await canvas.getAll(`/courses/${testCourseId}/files`, {
      per_page: 5,
    });
    if (!Array.isArray(result)) throw new Error('Expected array');
    return { result, detail: `(${result.length} files)` };
  });
}

await runTest('Fetch upcoming planner items (7 days)', async () => {
  const now = new Date();
  const cutoff = new Date(now.getTime() + 7 * 86400000);
  const result = await canvas.getAll('/planner/items', {
    start_date: now.toISOString(),
    end_date: cutoff.toISOString(),
    per_page: 10,
  });
  if (!Array.isArray(result)) throw new Error('Expected array');
  return { result, detail: `(${result.length} items)` };
});

// ---- Part 2: MCP server protocol test --------------------------------------

header('Part 2 — MCP server protocol');

await runTest('MCP initialize + tools/list handshake', () => {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [join(__dirname, 'src', 'index.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    proc.stderr.on('data', () => {}); // suppress dotenv banner

    // Send initialize
    const init = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-runner', version: '1.0' },
      },
    });
    const notif = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    const listTools = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });

    proc.stdin.write(init + '\n');
    proc.stdin.write(notif + '\n');
    proc.stdin.write(listTools + '\n');

    setTimeout(() => {
      proc.kill();
      // Parse responses — each line is a JSON-RPC response
      const lines = output.trim().split('\n').filter(Boolean);
      const toolListResp = lines.find((l) => {
        try {
          const obj = JSON.parse(l);
          return obj.id === 2 && obj.result?.tools;
        } catch {
          return false;
        }
      });
      if (!toolListResp) {
        reject(new Error('No tools/list response received'));
        return;
      }
      const tools = JSON.parse(toolListResp).result.tools;

      const expectedNames = [
        'canvas_get_courses',
        'canvas_get_assignments',
        'canvas_get_grades',
        'canvas_get_announcements',
        'canvas_get_upcoming_due',
        'canvas_submit_text_entry',
        'canvas_get_course_files',
        'canvas_send_message',
      ];
      const registeredNames = tools.map((t) => t.name);
      for (const name of expectedNames) {
        if (!registeredNames.includes(name)) {
          reject(new Error(`Missing tool: ${name}`));
          return;
        }
      }
      resolve({ result: tools, detail: `(${tools.length} tools registered)` });
    }, 3000);
  });
});

// ---- Summary ---------------------------------------------------------------

header('Results');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log();
process.exit(failed > 0 ? 1 : 0);
