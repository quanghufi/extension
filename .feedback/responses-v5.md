# Responses — Round 5 (Phase 1 Code Review)

**Date:** 2026-03-08
**Triaged by:** Antigravity

---

### FB-20260308-CLAUDE-001

- **Summary:** Claude adapter silently returns 0 findings for JSON-wrapped text responses
- **Assessment:** **Valid and critical.** Spike v3 evidence confirms Claude's `--output-format json` wraps output in `{"type":"result","result":"...text..."}`. `_tryParseJson()` sees valid JSON but no array → returns `[]`, bypassing `_parseTextOutput()`. This is a real, reproducible data-loss bug.
- **Decision:** Accept
- **Response To Antigravity:** Add check: if `parsed.result` is a string (not array), pass it through `_parseTextOutput()`. This handles the known Claude envelope format.
- **Owner:** Antigravity
- **ETA:** 2026-03-08

### FB-20260308-BASE-002

- **Summary:** UTF-8 multibyte split across `data` events causes false garble detection
- **Assessment:** **Valid.** Node.js `data` events split at arbitrary byte boundaries. A 3-byte Vietnamese char split across two chunks produces `U+FFFD` on both ends. The garble check then drops the chunk. `StringDecoder` or `TextDecoder` with `stream: true` is the correct fix.
- **Decision:** Accept
- **Response To Antigravity:** Replace `data.toString('utf-8')` with `new StringDecoder('utf-8')` instance per stream. Feed each buffer through it. This handles partial characters across chunks.
- **Owner:** Antigravity
- **ETA:** 2026-03-08

### FB-20260308-DEDUP-003

- **Summary:** Raw file paths not normalized before dedupe key creation
- **Assessment:** **Valid.** `normalizeFindingPath()` exists specifically for this purpose but is only imported in `codex-adapter.js` (not called at finding creation time) and not imported at all in `claude-adapter.js`. Both adapters should normalize paths before creating findings.
- **Decision:** Accept
- **Response To Antigravity:** In both adapters' `parseResult()`, call `normalizeFindingPath(rawPath, snapshotRoot)` before passing `file` to `createFinding()`. Need to pass `snapshotRoot` through to `parseResult`.
- **Owner:** Antigravity
- **ETA:** 2026-03-08

### FB-20260308-GROUP-004

- **Summary:** Agent attribution always empty due to mismatched finding IDs
- **Assessment:** **Valid.** The current approach generates fresh UUIDs in `parseResult()` which don't match the IDs from streamed events. Fix: track which agent reported each finding by `dedupe_key` (stable across agents) instead of by finding ID (UUID, unique per creation).
- **Decision:** Accept
- **Response To Antigravity:** Refactor `_findAgentForFinding()` to match on `dedupe_key` instead of `id`. Since `dedupe_key` is deterministic (hash of file+line+summary), it correctly links findings to their streaming events.
- **Owner:** Antigravity
- **ETA:** 2026-03-08

### FB-20260308-SNAP-005

- **Summary:** Git worktree metadata not cleaned up on snapshot removal
- **Assessment:** **Valid.** `git worktree add` registers the path under `.git/worktrees/`. Just deleting the directory leaves stale entries. Fix: call `git worktree remove <path>` before `fs.rmSync`, or call `git worktree prune` after.
- **Decision:** Accept
- **Response To Antigravity:** In `remove()`, try `git worktree remove <path> --force` first (catches worktree-created snapshots). Fall through to `fs.rmSync` for robocopy-created snapshots or if git command fails.
- **Owner:** Antigravity
- **ETA:** 2026-03-08
