# Extension — Agent Communication Hub

## Project Overview

Multi-agent communication hub that enables AI agents (Antigravity, Codex CLI, Claude Code CLI) to collaborate on code review through a structured event-driven architecture.

**Status:** Phase 0 Spike — INCOMPLETE (needs rerun with corrected tests)

## Tech Stack

- **Runtime:** Node.js 20+
- **Language:** JavaScript (migrating to TypeScript in Phase 1)
- **Agent CLIs:**
  - `codex review --skip-git-repo-check "prompt"` — Codex reviewer
  - `claude -p --no-session-persistence "prompt"` — Claude Code reviewer
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
│   └── spike-test.js     # Phase 0 test script (v1, needs fix)
├── .feedback/
│   ├── inbox.md          # Codex critique findings (6 findings)
│   ├── responses.md      # Antigravity responses (6/6 accepted)
│   └── action-plan.md    # Actions from critique
├── .agents/              # Agent run logs and prompts
├── AGENTS.md             # This file
└── README.md             # Project readme
```

## Current Task: Spike v2

The first spike test had flawed logic (TIMEOUT counted as pass, etc.). Need to:

1. Fix `spike-test.js` → `spike-test-v2.js`
2. Test exact production commands
3. TIMEOUT = FAIL, require non-empty stdout
4. Verify UTF-8 round-trip through JSON
5. Test parallel via Node.js spawn
6. Update spike report based on actual results

## Key Decisions

- **Evidence in repo wins** — manual runs outside repo are weak evidence
- **UTF-8 enforcement** — explicit decode, not hope
- **Immutable snapshots** — reviewers run on read-only copies (Phase 1)
- `--output-format json` hangs for Claude CLI → use text mode + parse

## Conventions

- Vietnamese comments/docs are normal (bilingual project)
- Commit messages follow conventional commits
- All agent feedback goes in `.feedback/`
- Agent run logs go in `.agents/runs/`

## Important: Do NOT

- Modify `docs/spike-results.json` — this is evidence from automated test
- Assume `--output-format json` works for Claude CLI (it hangs)
- Count TIMEOUT as a passing test
