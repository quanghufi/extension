# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This project is a multi-agent communication hub that enables AI agents (like Antigravity, Codex CLI, and Claude Code CLI) to collaborate on tasks, particularly code review, through a structured event-driven architecture. The core of the application is a Node.js server that provides a REST API for managing sessions and a WebSocket interface for real-time event streaming.

## High-Level Architecture

- **`src/server.js`**: The main entry point. It sets up an HTTP server for the REST API and a WebSocket server for real-time communication.
- **`src/api-routes.js`**: Handles all HTTP requests for the REST API, managing session lifecycle (create, get, list, delete).
- **`src/ws-handler.js`**: Manages WebSocket connections, subscriptions, and broadcasting events to clients.
- **`src/hub/session.js`**: Defines the `Session` class, which represents a single agent interaction, including its state, events, and associated agents.
- **`src/hub/session-store.js`**: Manages the persistence of session data to the filesystem.
- **`src/adapters/`**: Contains the logic for interacting with different AI agent CLIs (e.g., `codex`, `claude`). It handles process spawning, I/O, and translating agent output into structured events.

## Common Development Tasks

### Running the server
```bash
npm start
```

### Running tests
- To run all tests:
  ```bash
  npm test
  ```
- To run unit tests:
  ```bash
  npm run test:unit
  ```
- To run end-to-end tests:
  ```bash
  npm run e2e
  ```
  You can also specify an agent:
  ```bash
  npm run e2e:codex
  npm run e2e:claude
  ```

## Key Conventions & Important Notes

- **Bilingual Project**: The codebase contains both English and Vietnamese. This is expected.
- **Event-Driven**: The system is fundamentally event-driven. Agents communicate by producing and consuming events within a session.
- **Immutable Snapshots**: Reviewers operate on read-only copies of the code to ensure consistency.
- **Agent I/O**: Be aware that agent output can be directed to either `stdout` or `stderr`. Always consider combined output.
- **File Splitting**: There are strict rules for file sizes. Before adding code to a file, check if it's approaching the warning limit (200 lines for source, 250 for tests). If it is, refactor and split the file *before* adding new code.

## Workflow Orchestration

### 1. Plan Node Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update tasks/lessons.md with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
