# Extension — Agent Communication Hub

## Project Overview

Multi-agent communication hub that enables AI agents (Antigravity, Codex CLI) to collaborate on code review through a structured event-driven architecture.

**Status:** Phase 0 Spike — INCOMPLETE (needs rerun with corrected tests)

## Tech Stack

- **Runtime:** Node.js 20+
- **Language:** JavaScript (migrating to TypeScript in Phase 1)
- **Agent CLIs:**
  - `codex review "prompt"` — Codex reviewer
- **Encoding:** UTF-8 enforced end-to-end

## Project Structure

```
d:\extension\
├── docs/
│   ├── BRIEF.md          # Project brief v2 (post-critique)
│   ├── spike-report.md   # Phase 0 spike results
│   ├── spike-results.json # Automated test output (evidence)
│   └── ideas.md          # Brainstorm notes
├── scripts/
│   └── e2e-test.js       # E2E integration test
├── .feedback/
│   ├── inbox.md          # Codex critique round 1 (6 findings)
│   ├── inbox-v2.md       # Codex critique round 2 (8 findings)
│   ├── inbox-v3.md       # Codex critique round 3 — Phase 1 plan (10 findings)
│   ├── responses.md      # Antigravity responses round 1 (6/6 accepted)
│   ├── responses-v2.md   # Antigravity responses round 2 (8/8 accepted)
│   ├── responses-v3.md   # Antigravity responses round 3 (10/10 accepted)
│   ├── action-plan.md    # Actions from critique round 1
│   ├── action-plan-v2.md # Actions from critique round 2
│   └── action-plan-v3.md # Actions from critique round 3 — Phase 1 plan fixes
├── .agents/              # Agent run logs and prompts
├── AGENTS.md             # This file
└── README.md             # Project readme
```

## Current Task: Phase 0 — ✅ Complete

Spike v3 passed all gate tests. Evidence in `docs/spike-results-v3.json`.
Ready for Phase 1 — Event-Driven Hub.

## Key Decisions

- **Evidence in repo wins** — manual runs outside repo are weak evidence
- **UTF-8 enforcement** — explicit decode, not hope
- **Immutable snapshots** — reviewers run on read-only copies (Phase 1)
- **Codex output goes to stderr** — `stdoutBytes: 0, stderrBytes: 61838` (spike v3 evidence)
- **3-tier timeout** — `firstByte/idle/hard` (Codex: 45s/20s/90s)
- **`--skip-git-repo-check` does NOT exist** — removed from all commands
- **Use spawn(shell:false)** — not exec(); cross-spawn for Windows

## Conventions

- Vietnamese comments/docs are normal (bilingual project)
- Commit messages follow conventional commits
- All agent feedback goes in `.feedback/`
- Agent run logs go in `.agents/runs/`

### 🔪 File Splitting Rules (Auto-Enforced)

> **Workflow chi tiết:** `.agents/workflows/file-splitting.md`

| Metric | ⚠️ Warning | 🔴 Must Split |
|--------|-----------|---------------|
| Source lines | > 200 | > 300 |
| Test lines | > 250 | > 400 |
| File size | > 10 KB | > 15 KB |

**Bắt buộc:** Agent PHẢI kiểm tra file target trước khi thêm code. Nếu file đã ở mức ⚠️ → tách trước, code sau. KHÔNG BAO GIỜ tạo file mới > 300 lines.

## Important: Do NOT

- Modify `docs/spike-results.json` — this is evidence from automated test
- Count TIMEOUT as a passing test
- Use `--skip-git-repo-check` flag for Codex (doesn't exist)
- Use `exec()` for production — use `spawn(shell:false)` instead
- Use single timeout — use 3-tier `firstByte/idle/hard` strategy
- Check only `stdoutBytes` for pass/fail — use `combinedBytes` (stdout+stderr)
