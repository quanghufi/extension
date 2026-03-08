Doc context trong repo hien tai va critique spike report duoi day.

Yeu cau:
- Tra loi bang tieng Viet.
- Thang than, khong dua hoi.
- Tim assumption yeu, rui ro, missing verification, over-confidence.
- Neu co finding, dua finding truoc, theo muc do severity (Critical > High > Medium > Low).
- Tham chieu file/line neu co the.
- Dac biet chu y:
  1. Claude Code `--output-format json` hang la risk lon hay nho?
  2. Parallel test chi dung PowerShell Jobs, khong phai Node.js spawn — ket qua co tin cay?
  3. Co missing test case nao quan trong?
  4. Architecture recommendation o cuoi report co hop ly?

File can doc:
- docs/BRIEF.md (BRIEF v2 cua project)
- docs/spike-report.md (spike report can review)
- scripts/spike-test.js (test script da dung)

Spike Report:

# Phase 0 Spike Report — CLI Headless Integration

**Date:** 2026-03-08
**Overall Result:** SPIKE PASS (with known limitations)

## Test Results

### Test 1: Codex CLI Headless — PASS
- Command: `codex review "prompt"`
- Mode: Non-interactive (`review` subcommand)
- Exit code: 0
- Output capture: stdout captured, structured text
- UTF-8: No garbling

Known issues:
- MCP skill loading warnings (benign, some SKILL.md files missing `description` field)
- In PowerShell Jobs: "Not inside a trusted directory" error → needs `--skip-git-repo-check` flag
- `codex exec` cung co, nhung `codex review` phu hop hon cho use case review

### Test 2: Claude Code CLI Headless — PASS
- Command: `claude -p "prompt" --no-session-persistence`
- Mode: Print mode (`-p` flag)
- Exit code: 0
- Output capture: stdout captured as plain text
- UTF-8: "Xin chao Viet Nam" — diacritics perfect

Known issues:
- `--output-format json` HANGS — process goes silent, no output, must be killed
- `--output-format text` or no format flag → works correctly
- Workaround: capture text output, parse manually
- `--no-session-persistence` recommended cho headless

### Test 3: UTF-8 Vietnamese Capture — PASS
- Codex output encoding: Clean UTF-8
- Claude output encoding: "Xin chao Viet Nam." — perfect diacritics
- Vietnamese diacritics: captured correctly
- PowerShell capture: No garbling when using UTF-8 env vars

### Test 4: Parallel Execution — PASS (with caveat)
- Method: PowerShell `Start-Job` (2 concurrent jobs)
- Total time: 12.8s (ran in parallel)
- Codex job: "Not inside trusted directory" in job context
- Claude job: Completed successfully
- Conflict: None — both read-only operations

Caveat: Codex in PowerShell Jobs loses directory trust context. In production, se dung Node.js `child_process.spawn` thay vi PowerShell Jobs → se inherit cwd correctly.

## Recommended adapter commands:
```
# Codex reviewer
codex review --skip-git-repo-check "review prompt here"

# Claude Code reviewer
claude -p --no-session-persistence "review prompt here"
```

## Architecture recommendation:
```
Agent Adapter (Node.js)
  - spawn('codex', ['review', '--skip-git-repo-check', prompt])
  - spawn('claude', ['-p', '--no-session-persistence', prompt])
  - capture stdout as UTF-8 stream
  - emit structured events to Hub
```

## Verdict: SPIKE PASS — Proceed to Phase 1
