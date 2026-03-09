# Feedback Responses — Round 8

**Date:** 2026-03-09
**Source:** `.feedback/inbox-v8.md` (5 findings)

---

## Response Log

### FB-20260309-ADAPTER-001

- **Summary:** PowerShell wrapper treated stderr warnings as errors, causing false failures
- **Assessment:** Valid fix. PowerShell `$ErrorActionPreference = "Stop"` combined with stderr output from Codex CLI caused premature exits. Using `Start-Process` with separate redirect is the correct pattern.
- **Decision:** Accept
- **Response To Antigravity:** Verify the fix in `scripts/run-codex-feedback.ps1` — confirm stderr no longer kills the process.
- **Owner:** Antigravity
- **ETA:** 2026-03-10

### FB-20260309-ADAPTER-002

- **Summary:** Codex adapter used stale CLI flags that no longer exist
- **Assessment:** Critical correctness fix. The old `--output-format stream-json --verbose` flags were removed from Codex CLI. Migration to `exec review --json` is the correct path.
- **Decision:** Accept
- **Response To Antigravity:** Verify adapter works with current CLI version. Run smoke test.
- **Owner:** Antigravity
- **ETA:** 2026-03-10

### FB-20260309-PARSER-003

- **Summary:** Parser/prompt helpers extracted to separate file
- **Assessment:** Good refactoring. Reduces adapter complexity. New file structure (prompt contract, chunk parser, result parser) is well-organized.
- **Decision:** Accept
- **Response To Antigravity:** Review the extracted file for correctness and ensure imports are clean.
- **Owner:** Antigravity
- **ETA:** 2026-03-10

### FB-20260309-TEST-004

- **Summary:** Smoke test added, unit tests updated, E2E not claimed
- **Assessment:** Adequate for current phase. 227 tests passing. E2E timeout (184s) is a known issue, not a blocker for adapter correctness.
- **Decision:** Accept
- **Response To Antigravity:** Adopt `npm run smoke:codex` as CI gate. Investigate E2E timeout separately if needed.
- **Owner:** Antigravity
- **ETA:** 2026-03-10

### FB-20260309-RISK-005

- **Summary:** JSON contract assumption — parser may return empty findings if model deviates
- **Assessment:** Controlled risk. Prompt contract at line 25 enforces JSON array output. Not a guarantee but acceptable with smoke test as safety net.
- **Decision:** Accept
- **Response To Antigravity:** Add a warning log when findings are empty despite `ok` status, to surface contract violations early.
- **Owner:** Antigravity
- **ETA:** 2026-03-12
