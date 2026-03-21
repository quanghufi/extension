# Extension Hub

Multi-agent communication hub for code review. It exposes:

- `extension-hub`: HTTP/WebSocket dashboard server
- `extension-hub-mcp`: stdio MCP server for MCP clients

## Features

- REST API for session lifecycle management
- WebSocket real-time event streaming
- Dashboard UI at `http://localhost:3849/`
- MCP server for Hub tools over stdio
- Codex-backed review flow through the bundled Python bridge

## Requirements

- Node.js 20+ is required
- Python 3.10+ is required if you want real Codex review execution
- `codex` CLI in `PATH` is required for `mcp-codex` review runs

## Installation

### Global install

```bash
# From npm (when published)
npm install -g extension-hub

# From local folder
npm install -g .

# From tarball (copy to another machine)
npm pack
npm install -g extension-hub-1.0.0.tgz
```

### Install directly from GitHub

```bash
# Public repo
npm install -g github:<owner>/<repo>

# Equivalent git URL form
npm install -g git+https://github.com/<owner>/<repo>.git

# Pin a branch or tag
npm install -g github:<owner>/<repo>#main
npm install -g github:<owner>/<repo>#v1.0.0
```

For a private repo, either clone the repo and run `npm install -g .`, or install with a GitHub token-enabled git URL.

### Local development

```bash
npm install
npm start
```

## Commands

```bash
# Start the dashboard server
extension-hub

# Start the dashboard server on a custom port
extension-hub --port 4000

# Start the stdio MCP server
extension-hub-mcp

# Help and version
extension-hub --help
extension-hub --version
```

## MCP Client Config

Example `mcpServers` entry for a client that supports stdio MCP servers:

```json
{
  "mcpServers": {
    "extension-hub": {
      "command": "extension-hub-mcp"
    }
  }
}
```

If your client does not inherit `PATH` correctly on Windows, point to the global npm shim explicitly:

```json
{
  "mcpServers": {
    "extension-hub": {
      "command": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\extension-hub-mcp.cmd"
    }
  }
}
```

The MCP server can start with Node.js only. However, review tools such as `hub_create_review` and `hub_create_review_and_start_dual_debate` need Python + `codex` CLI to execute real reviews.

For client-specific setup steps, see [docs/INSTALL-MCP.md](/d:/extension/docs/INSTALL-MCP.md).

## Antigravity Registration Helpers

The package ships PowerShell helpers in `src/mcp/`:

```powershell
# Register the current working directory as the review workspace
powershell -ExecutionPolicy Bypass -File .\src\mcp\register_antigravity_codex_review.ps1

# Register a specific repo/workspace
powershell -ExecutionPolicy Bypass -File .\src\mcp\register_antigravity_codex_review_global.ps1 -RepoPath D:\my-repo
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sessions` | List all sessions |
| POST | `/api/sessions` | Create new review session |
| GET | `/api/sessions/:id` | Get session details |
| DELETE | `/api/sessions/:id` | Delete session |
| GET | `/api/sessions/:id/events` | Get session events |
| GET | `/api/sessions/:id/findings` | Get review findings |
| POST | `/api/sessions/:id/findings/evaluate` | Evaluate findings |
| POST | `/api/sessions/:id/rerun` | Rerun session |
| WS | `ws://localhost:3849` | WebSocket event stream |

## Direct Python Bridge

Run the bundled Python bridge directly if you only want the Codex review MCP bridge without the Node Hub MCP server:

```bash
python src/mcp/codex_review_mcp.py
```

## Development

```bash
npm test
npm run e2e
npm run pack:smoke
```

## License

MIT
