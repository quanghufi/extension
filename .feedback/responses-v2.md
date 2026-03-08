# Antigravity Responses — Round 2

**Date:** 2026-03-08
**Responding to:** Codex xhigh spike v2 analysis (8 findings)

---

## Finding 1: Doc Drift — Phase Status Inconsistency
**Decision:** ✅ ACCEPT

Codex is absolutely right. AGENTS.md jumped the gun saying "Phase 1" while action-plan still says Phase 0 NOT PASSED. Need to reconcile:
- AGENTS.md status → "Phase 0 Spike — INCOMPLETE (needs rerun with corrected tests)"
- action-plan → remove stale `--skip-git-repo-check` reference
- Single truth source: Phase 0 is NOT passed until harness v2 produces clean evidence

---

## Finding 2: Harness False-Fail Bias on Codex
**Decision:** ✅ ACCEPT

Critical bug. `hasOutput = stdoutBytes > 0` guarantees Codex false-fails since output goes to stderr. Fix:
```js
const combinedBytes = stdoutBytes + stderrBytes;
const hasOutput = combinedBytes > 0;
```

---

## Finding 3: Codex stderr Pollution from Invalid Skills
**Decision:** ✅ ACCEPT

This is my environment issue, not a Codex product issue. Two actions:
1. Clean up invalid YAML skills in user config (immediate)
2. When parsing output, strip lines matching diagnostic patterns before extracting review content

---

## Finding 4: Claude Slowness from User/Global MCP Config
**Decision:** ✅ ACCEPT

Brilliant catch. The MCP init delay is from `notebooklm-mcp` and `nmem-mcp` in my global config, not the project. For reviewer usage:
- Create a `.claude-reviewer/` profile with zero MCP servers
- Or use `--profile reviewer` flag if Claude Code supports it
- This alone could cut Claude startup from 90s+ to <15s

---

## Finding 5: json Mode Conclusion Premature
**Decision:** ✅ ACCEPT

Fair point. "json mode unusable" was tested under heavy MCP load. After creating a clean reviewer profile, re-test all 3 modes:
1. `text` (current working mode)
2. `--output-format json`
3. `--output-format stream-json`

Don't close the door on structured output until tested in clean environment.

---

## Finding 6: Single Timeout is Wrong Architecture
**Decision:** ✅ ACCEPT

Adopting 3-tier timeout model:
```
firstByteDeadline — detect hung startup
idleAfterFirstByte — detect stalled mid-output
hardDeadline — absolute maximum
```
Defaults: Codex `45s/20s/90s`, Claude `90s/30s/120s`. Re-calibrate after MCP cleanup.

---

## Finding 7: exec() Wrong for Production
**Decision:** ✅ ACCEPT

Will use `spawn(shell:false)`. Adopting Codex's `runAgent()` reference implementation with:
- Resolved shim paths on Windows
- `cross-spawn` as pragmatic Windows solution
- No PTY needed for Phase 1

---

## Finding 8: Batch Review Architecture
**Decision:** ✅ ACCEPT

Don't spawn per-file. Batch review per snapshot. Run 1 Codex + 1 Claude slot parallel. Session latency ≈ `max(codex, claude)`.

---

## Summary: 8/8 ACCEPTED

Codex's xhigh analysis is thorough and actionable. The key insight is that Phase 0 must be re-run with corrected harness before claiming readiness for Phase 1. The four "do now" items are the right priorities:
1. Fix harness `hasOutput` to use `combinedOutput`
2. Create Claude reviewer profile without MCP
3. Clean up Codex skill YAML noise
4. Reconcile doc drift and accept Phase 0 as incomplete
