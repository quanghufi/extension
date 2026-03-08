# Feedback Inbox — Round 5 (Phase 1 Code Review)

**Date:** 2026-03-08
**Source:** Codex `gpt-5.4` / `reasoning: xhigh`
**Scope:** Phase 1 commit `a37e7a0` (13,683 insertions)

---

## Entries

### FB-20260308-CLAUDE-001

- **Date:** 2026-03-08
- **From:** Codex
- **Module/Area:** `src/adapters/claude-adapter.js`
- **Severity:** Critical
- **Feedback:** `_tryParseJson()` returns `[]` when Claude's JSON output wraps results in a `result` text field (confirmed by spike evidence `docs/spike-results-v3.json`). This prevents fallback to `_parseTextOutput()`, silently disabling the Claude reviewer for any review that reports issues inside a `result` text payload.
- **Context/Logs:** Line 149 — the `return []` path executes for valid Claude output that is JSON but doesn't contain array findings.
- **Status:** New

### FB-20260308-BASE-002

- **Date:** 2026-03-08
- **From:** Codex
- **Module/Area:** `src/adapters/base-adapter.js`
- **Severity:** High
- **Feedback:** `data.toString('utf-8')` on each subprocess `data` event can split multibyte UTF-8 codepoints across chunks, inserting `�` (U+FFFD). The garble detection then drops the entire chunk — silently losing valid Vietnamese/Japanese findings. Should use `StringDecoder` or `TextDecoder` for streaming decode.
- **Context/Logs:** Line 206 — `const chunk = data.toString('utf-8');`
- **Status:** New

### FB-20260308-DEDUP-003

- **Date:** 2026-03-08
- **From:** Codex
- **Module/Area:** `src/adapters/codex-adapter.js`, `src/adapters/claude-adapter.js`
- **Severity:** High
- **Feedback:** Both adapters pass raw file paths (e.g., `raw.file`, `raw.path`) directly to `createFinding()` without calling `normalizeFindingPath()`. On Windows, `src\\server.js`, `./src/server.js`, and `src/server.js` hash to different `dedupe_key` values, preventing cross-agent dedup of the same issue.
- **Context/Logs:** `codex-adapter.js:112`, `claude-adapter.js:175,210,230`
- **Status:** New

### FB-20260308-GROUP-004

- **Date:** 2026-03-08
- **From:** Codex
- **Module/Area:** `src/hub/session.js`
- **Severity:** Medium
- **Feedback:** `_findAgentForFinding()` compares `event.payload?.raw?.id` to `finding.id`, but adapters create findings with fresh UUIDs during `parseResult()` that differ from the IDs assigned during streaming. This means `groupedFindings.agents` is always empty, breaking the "found by Codex/Claude" UI attribution.
- **Context/Logs:** Line 230 — the ID comparison logic.
- **Status:** New

### FB-20260308-SNAP-005

- **Date:** 2026-03-08
- **From:** Codex
- **Module/Area:** `src/snapshot/snapshot-manager.js`
- **Severity:** Medium
- **Feedback:** `remove()` deletes git worktree snapshots with `fs.rmSync()` but doesn't call `git worktree remove` first. This leaks stale entries under `.git/worktrees/`, requiring manual `git worktree prune` after repeated review cycles.
- **Context/Logs:** Line 118 — `fs.rmSync(resolved, { recursive: true, force: true });`
- **Status:** New
