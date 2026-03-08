# Codex Critique — Spike V2 Analysis (Round 2)

**Date:** 2026-03-08
**Model:** gpt-5.4 (reasoning: xhigh)
**Tokens:** 317,963
**Findings:** 8

---

## Finding 1: Doc Drift — Phase Status Inconsistency
**Severity:** HIGH
**Files:** `AGENTS.md`, `docs/BRIEF.md`, `.feedback/action-plan.md`

AGENTS.md L38 says "Phase 1 — Event-Driven Hub" and "Spike v2 completed", but:
- `docs/BRIEF.md` treats Phase 0 as a hard gate
- `.feedback/action-plan.md` L44 still says "Phase 0 NOT PASSED yet"
- `action-plan.md` L16 still references `--skip-git-repo-check` (doesn't exist)

**Conclusion:** Repo truth source is inconsistent. Phase 0 is **incomplete**, not ready for Phase 1.

---

## Finding 2: Harness False-Fail Bias on Codex
**Severity:** HIGH
**Files:** `scripts/spike-test-v2.js`

Harness v2 uses `stdoutBytes > 0` for pass/fail (L61, L73, L100), but Codex outputs to **stderr**, not stdout. This directly contradicts the AGENTS.md decision "capture both stdout+stderr as output" (L49).

**Fix:** `hasOutput` must check `combinedBytes = stdoutBytes + stderrBytes`, not just `stdoutBytes`.

---

## Finding 3: Codex stderr Pollution from Invalid Skills
**Severity:** MEDIUM
**Files:** `docs/spike-results-v2.json` (L28), `.agents/runs/20260308-114423.md`

Codex stderr is flooded with 100+ "invalid YAML" errors from broken skill files. This:
1. Slows startup by 20-30s
2. Pollutes stderr, mixing diagnostics with actual review output

**Fix:** Clean up or isolate the global skill set. Parser should filter out lines matching `timestamp ERROR codex_core` pattern.

---

## Finding 4: Claude Slowness from User/Global MCP Config
**Severity:** HIGH
**Files:** `.agents/runs/20260308-121325.md` (L220-224)

No `.mcp.json` or `.claude/` in project, but run logs show `notebooklm-mcp` and `nmem-mcp` loading. Startup tax comes from **user/global config**, not project.

**Fix:** Create a **reviewer profile** with minimal/empty MCP config. Don't load neural-memory or notebooklm for code review tasks.

---

## Finding 5: json Mode Conclusion Premature
**Severity:** MEDIUM

"json mode unusable" conclusion was reached under heavy MCP load environment. After cutting MCP, should re-test `--output-format json` and `--output-format stream-json` — both are documented by Anthropic as of 2026-03-08.

---

## Finding 6: Single Timeout is Wrong Architecture
**Severity:** MEDIUM

Using one timeout number is insufficient. Need 3-tier deadline:
- `firstByteDeadline` — detect hung startup
- `idleAfterFirstByte` — detect stalled mid-output
- `hardDeadline` — absolute maximum

Suggested defaults: Codex `45s/20s/90s`, Claude `90s/30s/120s`.

---

## Finding 7: exec() Wrong for Production
**Severity:** HIGH

`exec()` buffers all output (no streaming), can't cleanly cancel, and has quoting issues. Production should use `spawn(shell:false)` with:
- Resolved absolute shim paths (`codex.cmd`, `claude.cmd`)
- Or use `cross-spawn` / `execa` to avoid Windows PATH/PATHEXT pain
- PTY not needed at Phase 1; stdio capture is sufficient

**Code reference:** See `runAgent()` function in codex output.

---

## Finding 8: Batch Review Architecture
**Severity:** LOW

Don't spawn 1 process per file — startup cost dominates. Batch review per snapshot/repo slice. Run 1 Codex + 1 Claude slot in parallel. Session latency ≈ `max(codex, claude)`, not sum.

---

## Sources
- Anthropic Claude Code SDK: https://docs.anthropic.com/en/docs/claude-code/sdk
- Anthropic Claude Code settings: https://docs.anthropic.com/en/docs/claude-code/settings
- OpenAI Codex issue #6432: https://github.com/openai/codex/issues/6432
