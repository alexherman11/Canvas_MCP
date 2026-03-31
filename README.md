# Canvas LMS MCP Server

An MCP (Model Context Protocol) server that connects Claude to the Canvas LMS API. Lets Claude read your courses, assignments, grades, announcements, files, and more — directly from Canvas.

Works **remotely** (hosted on Railway, no local setup) or **locally** (stdio transport for Claude Desktop).

## Tools

| Tool | Description |
|------|-------------|
| `canvas_get_courses` | List all active courses |
| `canvas_get_assignments` | Assignments for a course (due dates, points, submission status) |
| `canvas_get_grades` | Current grades for a course |
| `canvas_get_announcements` | Recent announcements for a course |
| `canvas_get_upcoming_due` | Assignments due in the next N days across all courses |
| `canvas_submit_text_entry` | Submit a text-based assignment |
| `canvas_get_course_files` | List files in a course |
| `canvas_send_message` | Send a Canvas inbox message |

## Quick Start — Remote (Recommended)

No installation needed. Just add this to your Claude Desktop config:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "canvas-lms": {
      "url": "https://YOUR_RAILWAY_URL/mcp",
      "headers": {
        "x-canvas-api-token": "YOUR_CANVAS_API_TOKEN",
        "x-canvas-base-url": "https://canvas.yourschool.edu"
      }
    }
  }
}
```

Replace `YOUR_RAILWAY_URL` with the deployed server URL, and fill in your Canvas credentials.

Then **restart Claude Desktop** (fully quit, not just close the window).

## Local Setup (Development)

### 1. Get a Canvas API Token

1. Log in to your Canvas instance (e.g. `https://canvas.yourschool.edu`)
2. Go to **Account** > **Settings**
3. Scroll to **Approved Integrations**
4. Click **+ New Access Token**
5. Give it a name (e.g. "Claude MCP"), set expiry as desired, click **Generate Token**
6. **Copy the token immediately** — you won't be able to see it again

### 2. Clone and Install

```bash
git clone https://github.com/alexherman11/Canvas_MCP.git
cd Canvas_MCP
npm install
```

### 3. Configure Credentials

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```
CANVAS_BASE_URL=https://canvas.yourschool.edu
CANVAS_API_TOKEN=your_token_here
```

### 4. Test

```bash
node test.js
```

This will:
- Verify your Canvas API credentials work
- Call each API endpoint
- Start both the stdio and HTTP MCP servers and confirm they work

### 5. Register with Claude Desktop (Local)

```json
{
  "mcpServers": {
    "canvas-lms": {
      "command": "node",
      "args": ["/absolute/path/to/Canvas_MCP/src/index.js"],
      "env": {
        "CANVAS_BASE_URL": "https://canvas.yourschool.edu",
        "CANVAS_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

> **Important:** Replace the path in `args` with the absolute path to `src/index.js` on your machine.

## Self-Hosting on Railway

1. Fork this repo
2. Create a new project on [Railway](https://railway.app) and connect your fork
3. Railway auto-detects Node.js — no Dockerfile needed
4. Optionally set `CANVAS_BASE_URL` and `CANVAS_API_TOKEN` in Railway's environment variables for single-tenant mode
5. Deploy — the server starts on the assigned `PORT` automatically
6. Use the Railway-provided URL in your Claude Desktop config (see Quick Start above)

The server exposes:
- `POST/GET/DELETE /mcp` — MCP Streamable HTTP endpoint
- `GET /health` — health check (returns `200 OK`)

## Verify in Claude Desktop

After restarting, try asking Claude:
- "What courses am I taking this quarter?"
- "What assignments are due this week?"
- "What's my grade in [course name]?"

## Project Structure

```
Canvas_MCP/
  src/
    index.js        — MCP server entry point (stdio transport, local dev)
    server-http.js  — MCP server entry point (HTTP transport, remote)
    tools.js        — All 8 tool definitions and handlers
    canvas-api.js   — Canvas REST API client (pagination, retries)
    config.js       — Environment configuration
  test.js           — Standalone test script
  .env.example      — Template for credentials
  .gitignore        — Excludes .env and node_modules
  package.json
  README.md
```

## Architecture

```
Remote mode:
  Claude Desktop/claude.ai → HTTPS → Railway → Streamable HTTP → MCP server → Canvas API
                                                                    ↑
                                                      reads x-canvas-api-token &
                                                      x-canvas-base-url from headers

Local mode:
  Claude Desktop → spawns process → stdio → MCP server → Canvas API
                                               ↑
                                    reads CANVAS_API_TOKEN &
                                    CANVAS_BASE_URL from env vars
```

## License

[MIT](LICENSE)
