# Extension Hub

Multi-agent communication hub — AI agents (Antigravity, Codex) collaborate on code review via event-driven architecture.

## Features

- 🚀 **REST API** for session lifecycle management
- 🔌 **WebSocket** real-time event streaming
- 📊 **Dashboard UI** at `http://localhost:3849/`
- 🤖 **MCP Adapter** for Codex integration
- 🔄 **Review Loop** with evaluate/rerun feedback chain

## Requirements

- **Node.js 20+** (required)
- **Python 3.10+** (optional — only for MCP Codex adapter)

## Installation

### Global install (recommended)

```bash
# From npm (when published)
npm install -g extension-hub

# From local folder
npm install -g .

# From tarball (copy to another machine)
npm pack                              # creates extension-hub-1.0.0.tgz
npm install -g extension-hub-1.0.0.tgz  # install on any machine
```

### Local development

```bash
npm install
npm start
```

## Usage

```bash
# Start with default port (3849)
extension-hub

# Start with custom port
extension-hub --port 4000

# Show help
extension-hub --help

# Show version
extension-hub --version
```

### Endpoints

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

### MCP Codex Adapter (optional)

Requires Python 3.10+ and `codex` CLI:

```bash
python src/mcp/codex_review_mcp.py
```

## Development

```bash
# Run unit tests
npm test

# Run e2e tests
npm run e2e

# Pack and verify tarball
npm run pack:smoke
```

## License

MIT
