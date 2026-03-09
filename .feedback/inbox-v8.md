# Feedback Inbox — Round 8 (Codex FullAuto — Adapter & Flow Fix)

**Date:** 2026-03-09
**Source:** `.agents/codex-feedback.md`
**Codex Model:** gpt-5.4-xhigh via 9Router
**Type:** FullAuto implementation (not critique-only)

---

## Entries

### FB-20260309-ADAPTER-001

- **Date:** 2026-03-09
- **From:** Codex
- **Module/Area:** scripts/run-codex-feedback.ps1
- **Severity:** High
- **Feedback:** PowerShell wrapper failed silently because it treated stderr warnings from `codex` CLI as errors. Fixed by switching to `Start-Process` + separate stdout/stderr redirect at lines 43 and 136.
- **Context/Logs:** `scripts/run-codex-feedback.ps1:43`, `scripts/run-codex-feedback.ps1:136`
- **Status:** New

### FB-20260309-ADAPTER-002

- **Date:** 2026-03-09
- **From:** Codex
- **Module/Area:** src/adapters/codex-adapter.js
- **Severity:** High
- **Feedback:** Adapter used stale CLI flags (`codex review --skip-git-repo-check --output-format stream-json --verbose`) that no longer exist in current CLI. Migrated to `codex exec review --skip-git-repo-check --json` at lines 39 and 46.
- **Context/Logs:** `src/adapters/codex-adapter.js:39`, `src/adapters/codex-adapter.js:46`
- **Status:** New

### FB-20260309-PARSER-003

- **Date:** 2026-03-09
- **From:** Codex
- **Module/Area:** src/adapters/codex-adapter-parsing.js (NEW)
- **Severity:** Medium
- **Feedback:** Parser/prompt helpers extracted from adapter into separate file to reduce adapter bloat. Includes prompt contract (line 25), chunk parser (line 45), result parser (line 85). Final answer forced to JSON array for stable findings parsing.
- **Context/Logs:** `src/adapters/codex-adapter-parsing.js:25,45,85`
- **Status:** New

### FB-20260309-TEST-004

- **Date:** 2026-03-09
- **From:** Codex
- **Module/Area:** Testing
- **Severity:** Low
- **Feedback:** Added smoke test for Codex adapter at `scripts/codex-smoke.js` + npm script `smoke:codex`. Unit tests updated at `src/adapters/codex-adapter.test.js:12`. Verification: 227 tests pass, smoke test pass (status=ok, ~6522ms). E2E full test not claimed — exceeded 184s timeout.
- **Context/Logs:** `scripts/codex-smoke.js`, `package.json:9`, `src/adapters/codex-adapter.test.js:12`
- **Status:** New

### FB-20260309-RISK-005

- **Date:** 2026-03-09
- **From:** Codex
- **Module/Area:** src/adapters/codex-adapter-parsing.js
- **Severity:** Medium
- **Feedback:** Parser relies on final `agent_message` being a JSON array. If prompt changes or model doesn't obey contract, findings may return empty despite run being `ok`. This is a controlled assumption, not an absolute guarantee. Recommendation: use `npm run smoke:codex` as CI gate. Do NOT revert to `--output-format stream-json`.
- **Context/Logs:** Prompt contract at `src/adapters/codex-adapter-parsing.js:25`
- **Status:** New
