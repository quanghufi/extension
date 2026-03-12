# Require Codex Review Before Completion

When working in Antigravity agent mode in this workspace:

- After making code changes that affect behavior, call the MCP tool `run_codex_review`.
- Treat `critical` and `high` findings as blocking unless you have a concrete reason to defer them.
- Fix findings in severity order before asking the user to review the work.
- After applying fixes, rerun `run_codex_review`.
- Stop after three review loops and escalate to the user if the same issue keeps reappearing.
- Use `get_last_codex_review` if you need to reload the latest structured findings or handoff artifacts.
