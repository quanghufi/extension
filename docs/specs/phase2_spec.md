# Phase 2 Spec: Agent Hub Polish

Created: 2026-03-08
Status: Approved
Prerequisites: Phase 1 complete (172/172 tests, 6 Codex reviews)

---

## Executive Summary

Phase 2 biến Agent Communication Hub từ proof-of-concept thành daily-use tool.
5 tính năng cốt lõi: Agent Registry, Smart Merge, Side-by-Side UI, Code Annotation, Resilient Sessions.

## User Stories

### US-01: Configurable Agents
**As** a developer, **I want** to add new review agents via config file,
**so that** I can evaluate new AI CLI tools without modifying hub code.

### US-02: Merged Findings
**As** a reviewer, **I want** duplicate findings auto-merged across agents,
**so that** I see unique issues, not repeated noise.

### US-03: Comparative View
**As** a reviewer, **I want** to compare findings side-by-side between agents,
**so that** I understand each agent's strengths and blind spots.

### US-04: Code Context
**As** a developer, **I want** to click a finding and see the actual code,
**so that** I can understand the issue without switching to my IDE.

### US-05: Recovery
**As** a user, **I want** to cancel a stuck review and retry cleanly,
**so that** I don't lose my session or leave orphaned processes.

## Architecture Changes

```
Phase 1 (existing):                 Phase 2 (additions):
                                    
src/adapters/                       src/adapters/
  base-adapter.js                     registry.js          ★ NEW
  codex-adapter.js                    generic-adapter.js   ★ NEW
  claude-adapter.js                 
                                    src/hub/
src/hub/                              merge.js             ★ NEW
  session.js                          session.js           (cancel/retry)
  session-store.js                  
                                    src/utils/
src/schema/events.js                  similarity.js        ★ NEW
src/server.js                         paths.js             (existing)
src/ui/index.html                   
                                    src/server.js          (file API, retry API)
                                    src/ui/index.html      (side-by-side, code viewer)
```

New files: **5** | Modified files: **4** | Total new tests: **~30+**

## API Contract (New Endpoints)

### File Content API
```
GET /api/files?path=<relative>&snapshot=<snapshotId>
→ 200 { path, content, lines, size }
→ 403 Path traversal blocked
→ 404 File not found
→ 413 File too large (>500KB)
```

### Session Retry
```
POST /api/sessions/:id/retry
Body: { prompt?: string }
→ 201 { retrySessionId, attempt, parentSessionId }
→ 409 Session not in terminal state
→ 429 Max retries exceeded
```

### Session Cancel
```
DELETE /api/sessions/:id
→ 200 { cancelled: true, reason }
→ 409 Already in terminal state
```

### WebSocket Reconnect Protocol
```
Client → { type: 'reconnect', sessionId, lastSeq }
Server → { type: 'replay_start', fromSeq, count }
Server → { type: 'event', seq, ... } × N
Server → { type: 'replay_end' }
```

## Build Checklist

- [ ] Phase 01: Agent Registry — config + factory + generic adapter
- [ ] Phase 02: Smart Merge — similarity + merge engine
- [ ] Phase 03: Side-by-Side UI — dual view + filters
- [ ] Phase 04: Code Annotation — file API + syntax HL + viewer
- [ ] Phase 05: Resilient Sessions — cancel + retry + reconnect
- [ ] Full regression: all Phase 1 tests still green
- [ ] Codex review: at least 1 round before Phase 2 close
- [ ] Update AGENTS.md with Phase 2 status
- [ ] Update KI artifact with Phase 2 architecture
