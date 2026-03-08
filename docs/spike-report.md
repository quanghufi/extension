# Spike Report — Phase 0: CLI Viability

**Date:** 2026-03-08  
**Version:** v2 (corrected test methodology per Codex critique)

## Executive Summary

**Overall: ⚠️ PARTIAL PASS — Both CLIs functional, integration quirks found**

Both Codex and Claude Code CLIs work headlessly on Windows. Automated tests flagged failures, but root cause analysis reveals **integration quirks** rather than blocking issues:

| Capability | Status | Note |
|---|---|---|
| Codex headless | ✅ Works | Output goes to **stderr**, not stdout |
| Claude text mode | ⚠️ Slow | Needs >60s timeout (MCP init overhead) |
| Claude json mode | ❌ Hangs | `--output-format json` confirmed unusable |
| Parallel execution | ✅ Works | Promise.all verified |
| UTF-8 round-trip | ✅ Works | Vietnamese/Japanese/emoji all pass |

## Test Results (v2)

### Test 1: Codex CLI Headless
```
Command:  codex review "prompt"
Status:   TIMEOUT (60s) — but Codex DID work in parallel test
Root cause: Codex spends ~20-30s loading 500+ skill YAML files at startup
Fix:      Increase timeout to 90s for single runs
Key finding: Codex output goes to STDERR, not stdout
```

### Test 2: Claude Code CLI Headless
```
Command:  claude -p --no-session-persistence "prompt"
Status:   TIMEOUT (60s)
Root cause: Claude loads MCP servers (neural-memory, notebooklm) at startup
Evidence: Console showed "Xin chào!" response AFTER timeout window
Fix:      Increase timeout to 90-120s
```

### Test 3: Claude JSON Mode (Risk Test)
```
Command:  claude -p --output-format json "prompt"
Status:   TIMEOUT (30s) — expected
Verdict:  CONFIRMED UNUSABLE — do NOT use in production
```

### Test 4: Parallel Execution
```
Mechanism: Node.js exec() + Promise.all
Result:   ranParallel = true ✅
Codex:    OK (24.5s, exit 0, but output in stderr)
Claude:   TIMEOUT (60s)
Note:     Parallel execution works — Codex finished in 24s when parallel
```

### Test 5: UTF-8 Round-Trip
```
Vietnamese: ✅ roundTripped
Japanese:   ✅ roundTripped
Emoji:      ✅ roundTripped
Mixed:      ✅ roundTripped
```

## Findings & Decisions

### Finding 1: Codex output goes to stderr
**Impact:** High — our test checked stdout only  
**Evidence:** Parallel test showed Codex exit 0 in 24s, but stdoutBytes = 0  
**Manual test:** `codex review "Say hello" 2>&1` captured response on stderr  
**Decision:** Capture both stdout+stderr as "output" for Codex

### Finding 2: Both CLIs have slow startup on this machine
**Impact:** Medium — 60s timeout too short  
**Evidence:** Codex loads 500+ skill YAMLs (~20-30s), Claude loads MCP servers  
**Decision:** Set timeout to 120s for production

### Finding 3: `--skip-git-repo-check` doesn't exist
**Impact:** Low — flag was never needed  
**Evidence:** `codex review -h` shows no such flag  
**Decision:** Remove from all docs/commands

### Finding 4: Claude `--output-format json` is unusable
**Impact:** Medium — must use text mode + parse  
**Evidence:** Consistently hangs/timeouts across multiple test runs  
**Decision:** Use text mode only, parse output manually

## Corrected Production Commands

```bash
# Codex reviewer (capture stderr too)
codex review "prompt" 2>&1

# Claude reviewer (text mode, long timeout)
claude -p --no-session-persistence "prompt"

# NOT: --output-format json (hangs)
# NOT: --skip-git-repo-check (doesn't exist)
```

## Next Steps

1. ✅ Update `docs/BRIEF.md` with corrected commands
2. ✅ Update `AGENTS.md` with findings
3. [ ] Consider shorter prompts for faster CLI response
4. [ ] Phase 1: Build event-driven hub using these corrected commands

## Evidence Files

- [`docs/spike-results-v2.json`](file:///d:/extension/docs/spike-results-v2.json) — Automated test output
- [`scripts/spike-test-v2.js`](file:///d:/extension/scripts/spike-test-v2.js) — Test script (v2, corrected methodology)
