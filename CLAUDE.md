# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity

Extension Hub is a multi-agent communication hub enabling AI agents (Antigravity, Codex CLI, Claude Code CLI) to collaborate on code review via an event-driven architecture. It exposes functionality through REST API, WebSocket, and MCP (stdio transport).

## Commands

```bash
# Install dependencies
npm install

# Start hub server (HTTP + WebSocket on port 3849)
npm start

# Run unit tests
npm test

# Run e2e integration tests
npm run e2e

# Pack as tarball for distribution
npm run pack:smoke

# Run MCP hub server (stdio transport)
npm run mcp:hub

# Run MCP Codex adapter (requires Python 3.10+)
npm run mcp:codex
```

## Architecture

```
┌─────────────────────────────────────────────┐
│  MCP Server (stdio)  ──  src/mcp-server.js  │
│  MCP Tools: hub_create_review, hub_get_     │
│  status, hub_get_findings, hub_evaluate,   │
│  hub_rerun, hub_post_message, hub_list,   │
│  hub_claim, hub_assign, hub_advance,      │
│  hub_start_debate, hub_create_+_debate    │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  HubServer  ──  src/server.js              │
│  • REST API + WebSocket                     │
│  • Session lifecycle                        │
│  • Snapshot management                       │
│  • Agent routing                            │
└──────┬─────────────────────┬────────────────┘
       │                     │
┌──────▼──────┐       ┌─────▼────────────┐
│  src/hub/   │       │  src/adapters/   │
│  Session    │       │  BaseAdapter      │
│  Session-   │       │  CodexAdapter     │
│  Store      │       │  ClaudeCode-      │
│  Session-   │       │  Adapter         │
│  Collab     │       │  GenericAdapter  │
│  Debate-    │       │  (PTystdiospawn) │
│  Orchestrator      │                   │
└──────┬──────┘       └─────────────────┘
       │
┌──────▼──────────────────────────────┐
│  src/schema/events.js  — Event types │
│  Finding schema, message schema       │
└──────────────────────────────────────┘
```

### Key Patterns

- **Dual state machines**: Each `Session` has both an execution state (`pending → reviewing → completed`) and a collaboration state (`draft → awaiting_turn → reviewing → resolved → closed`). These evolve independently.
- **Agent adapters**: All CLI agents (Codex, Claude Code) are wrapped through `BaseAdapter`. Each adapter spawns the CLI subprocess, captures stdout/stderr, and emits structured events.
- **HubManager**: MCP server uses a lazy `HubManager` singleton. The first `hub_create_review` call initializes the `HubServer`. Concurrent callers share the same startup promise.
- **MCP transport**: The MCP server uses `@modelcontextprotocol/sdk` with `StdioServerTransport`. Tools return `{ content: [...], isError?: boolean }` format.

### Session Flow

1. `hub_create_review` → creates `Session`, persists to disk, starts `runSession` in background
2. Adapter spawns CLI subprocess → emits events → session collects findings
3. Client polls `hub_get_status` or subscribes WebSocket
4. On completion, collab tools activate: assign agents → claim turn → post messages → advance state
5. Optional: `hub_start_debate` triggers automated multi-round debate between agents

## Non-Negotiable Rules

- **UTF-8 enforcement**: Always decode raw bytes as UTF-8 explicitly. CLI adapters must set `PYTHONIOENCODING: 'utf-8'` in env.
- **Use `spawn(shell:false)`**: Never `exec()`. Use `cross-spawn` for cross-platform support.
- **3-tier timeout**: `firstByte / idle / hard` — never single timeout.
- **Check `combinedBytes`**: Codex outputs primarily to stderr. Pass/fail is never determined by `stdoutBytes` alone.
- **`--skip-git-repo-check` does NOT exist**: Never use this flag.
- **Immutable snapshots**: Reviewers run on read-only copies (Phase 1). Not just policy — technical enforcement via worktree/permissions.
- **Evidence in repo wins**: Automated test results in `docs/spike-results*.json` are canonical evidence. Manual runs outside repo are weak.

## MCP Tool Reference

### Core tools (src/mcp-server.js) — 7 tools
| Tool | Purpose |
|------|---------|
| `hub_list_sessions` | List all review sessions with status |
| `hub_create_review` | Create session + start review (optionally wait for completion) |
| `hub_create_review_and_start_dual_debate` | Create + wait review + start debate in one call |
| `hub_get_status` | Session details, storage metadata, watchdog status, collab/debate fields |
| `hub_get_findings` | Grouped + merged findings with rebuttal outcomes |
| `hub_evaluate_findings` | Accept/reject/dispute findings (blocked during active debate) |
| `hub_rerun_review` | Retry on terminal or stalled sessions |

### Collab tools (src/mcp-collab-tools.js) — 6 tools
| Tool | Purpose |
|------|---------|
| `hub_post_message` | Post message to session thread |
| `hub_list_messages` | List messages with filtering |
| `hub_claim_turn` | Claim current turn (blocked during debate) |
| `hub_assign_agent` | Assign agent to role |
| `hub_advance_session` | Advance collab state machine |
| `hub_start_debate` | Start automated multi-agent debate |

## Key Files

- `src/server.js` — `HubServer` class: HTTP/WebSocket, session store, snapshot manager
- `src/hub/session.js` — `Session` class: execution state, findings, messages, debate state
- `src/hub/session-collab.js` — collab state machine
- `src/hub/debate-orchestrator.js` — `DebateExecutor`: multi-round debate logic
- `src/adapters/base-adapter.js` — base class for agent CLI adapters
- `src/schema/events.js` — event types + finding schema
- `src/snapshot/snapshot-manager.js` — immutable snapshot creation for reviewers
- `src/ws-handler.js` — WebSocket connection + broadcast handling
- `bin/extension-hub.js` — CLI entry point for global install
