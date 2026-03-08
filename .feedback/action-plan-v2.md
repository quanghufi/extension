# Action Plan — Round 2 (Codex xhigh Analysis)

**Date:** 2026-03-08
**Source:** `.feedback/inbox-v2.md` (8 findings, 8/8 accepted)

---

## Priority 1: Immediate (Block Phase 1)

### 1.1 Fix AGENTS.md Doc Drift
- [x] Change status to "Phase 0 Spike — INCOMPLETE (needs rerun with corrected tests)"
- [ ] Remove stale `--skip-git-repo-check` references from action-plan.md

### 1.2 Fix Harness False-Fail
- [x] Change `hasOutput` from `stdoutBytes > 0` to `combinedBytes > 0`
- [x] Add `stderrBytes` metric to test output
- [x] Add `combinedOutput` and `combinedBytes` to results JSON
- [x] Re-run harness → `spike-results-v3.json` ✅ GATE PASS

---

## Priority 2: Before Phase 1 Implementation

### 2.1 Claude Reviewer Profile & Output Modes
- [x] Re-test `--output-format json` → ✅ WORKS (was MCP overhead)
- [x] Re-test `--output-format stream-json` → ❌ requires `--verbose` flag
- [ ] Create minimal Claude config with zero MCP servers (for even faster startup)
- [ ] Document working modes for reviewer use case

### 2.2 Clean Codex Skill Environment
- [ ] Identify and fix/remove invalid YAML skills
- [ ] Measure startup time improvement
- [ ] Document clean stderr baseline

---

## Priority 3: Phase 1 Architecture Decisions

### 3.1 Process Management
- [x] Replace `exec()` with `spawn(shell:false)` — done in spike-test-v3.js
- [x] Use `cross-spawn` for Windows compatibility
- [x] Resolve CLI shim paths before spawn

### 3.2 Timeout Strategy
- [x] Implement 3-tier timeout: `firstByte/idle/hard` — done in spike-test-v3.js
- [x] Default: Codex `45s/20s/90s`, Claude `90s/30s/120s`
- [ ] Re-calibrate after MCP cleanup

### 3.3 Batch Architecture
- [ ] 1 Codex + 1 Claude slot parallel, not per-file
- [ ] Session latency = `max(codex, claude)`
