# Plan: Phase 2 — Agent Hub Polish

Created: 2026-03-08T19:59:00+07:00
Status: 🟡 In Progress
Parent: Phase 1 Core Hub (✅ Complete — 172/172 tests)

## Overview

Nâng cấp Agent Communication Hub từ "chạy được" → "dùng thật được hàng ngày".
Tập trung vào UX dashboard, agent linh hoạt, và khả năng phục hồi.

## Tech Stack (giữ nguyên từ Phase 1)

- **Runtime:** Node.js 20+ ESM
- **Testing:** `node --test` (built-in)
- **Types:** JSDoc (no build step)
- **UI:** Vanilla JS single-file dashboard
- **WebSocket:** `ws` library
- **Snapshot:** git worktree + attrib/icacls

## Phases

| Phase | Name | Status | Progress | Est. |
|-------|------|--------|----------|------|
| 01 | Agent Registry | ⬜ Pending | 0% | 1 session |
| 02 | Smart Auto-Merge | ⬜ Pending | 0% | 1 session |
| 03 | Side-by-Side Findings UI | ⬜ Pending | 0% | 1 session |
| 04 | Code Annotation Viewer | ⬜ Pending | 0% | 2 sessions |
| 05 | Resilient Sessions | ⬜ Pending | 0% | 1 session |

**Tổng:** 5 phases, ~6 sessions

## Dependencies

```
Phase 01 (Registry) ──┐
                      ├──→ Phase 03 (Side-by-Side UI)
Phase 02 (Merge) ─────┤
                      └──→ Phase 04 (Code Annotation)
Phase 05 (Resilient) ← independent, can run in parallel
```

## Quick Commands

- Start Phase 1: `/code phase-01`
- Check progress: `/next`
- Run tests: `node --test src/**/*.test.js`
- Run E2E: `npm run e2e -- --auto-exit`

## Verification Gate (Phase 2 Complete When)

- [ ] Agent registry loads from config file
- [ ] 3rd-party agent (e.g. Gemini stub) can be added without code changes
- [ ] Duplicate findings auto-merged with multi-agent badges
- [ ] Side-by-side UI shows per-agent findings with diff highlighting
- [ ] Click finding → opens code viewer with highlighted line
- [ ] Cancel mid-review → cleanup snapshots + processes
- [ ] Retry creates fresh session with new snapshot
- [ ] WebSocket auto-reconnects after disconnect
- [ ] All existing 172 tests still pass
- [ ] New Phase 2 tests: target ≥200 total
