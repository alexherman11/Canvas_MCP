# Canvas LMS MCP Server

A local MCP (Model Context Protocol) server that connects Claude Desktop to the Canvas LMS API. Lets Claude read your courses, assignments, grades, announcements, files, and more — directly from Canvas.

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

## Setup

### 1. Get a Canvas API Token

1. Log in to your Canvas instance (e.g. `https://canvas.yourschool.edu`)
2. Go to **Account** > **Settings**
3. Scroll to **Approved Integrations**
4. Click **+ New Access Token**
5. Give it a name (e.g. "Claude MCP"), set expiry as desired, click **Generate Token**
6. **Copy the token immediately** — you won't be able to see it again

### 2. Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/Canvas-MCP.git
cd Canvas-MCP
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
- Start the MCP server and confirm all 8 tools are registered

### 5. Register with Claude Desktop

Add the following to your Claude Desktop config file:

**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "canvas-lms": {
      "command": "node",
      "args": ["/absolute/path/to/Canvas-MCP/src/index.js"],
      "env": {
        "CANVAS_BASE_URL": "https://canvas.yourschool.edu",
        "CANVAS_API_TOKEN": "your_token_here"
      }
    }
  }
}
```

> **Important:** Replace the path in `args` with the absolute path to `src/index.js` on your machine, and fill in your Canvas URL and API token. The `env` block in the config means you don't need to rely on the `.env` file when running through Claude Desktop.

Then **restart Claude Desktop** (fully quit, not just close the window). You should see Canvas tools available in the tools menu.

## Verify in Claude Desktop

After restarting, try asking Claude:
- "What courses am I taking this quarter?"
- "What assignments are due this week?"
- "What's my grade in [course name]?"

## Project Structure

```
Canvas-MCP/
  src/
    index.js        — MCP server entry point (stdio transport)
    tools.js        — All 8 tool definitions and handlers
    canvas-api.js   — Canvas REST API client (pagination, retries)
    config.js       — Environment configuration
  test.js           — Standalone test script
  .env.example      — Template for credentials
  .gitignore        — Excludes .env and node_modules
  package.json
  README.md
```

## License

[MIT](LICENSE)
