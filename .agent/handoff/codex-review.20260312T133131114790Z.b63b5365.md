# Codex Review

## Overview
- Status: has_findings
- Summary: The registry and generic adapter have several correctness regressions: reset does not restore all built-ins, path normalization is anchored to the wrong directory, and the advertised ESLint/Semgrep presets do not parse their native JSON formats correctly. There are also input-validation and parser edge cases that are currently untested.
- Findings: 6

## Key Findings

### 1. [HIGH] `resetRegistry()` silently drops the `mcp-codex` built-in adapter
- Location: src/adapters/adapter-registry.js:141
- Why it matters: The module pre-registers both `codex` and `mcp-codex`, but every test `beforeEach()` and any runtime reset leaves only `codex` available. That creates order-dependent failures and makes the registry state after reset inconsistent with initial module state.
- Recommended fix: Refactor built-in registration into a shared helper that registers both `new CodexAdapter()` and `new McpCodexAdapter()`, and call that helper both at module initialization and inside `resetRegistry()`. Add a test asserting `resetRegistry()` restores both built-ins.
- Confidence: high

### 2. [HIGH] `ESLINT_PRESET` cannot extract findings from real ESLint JSON output
- Location: src/adapters/adapter-registry.js:154
- Why it matters: The preset is exported as ready-to-use, but ESLint's `--format json` returns file result objects with `filePath` and nested `messages[]`. The generic parser only understands flat finding-like objects, so this preset will usually return zero findings even when ESLint reports errors.
- Recommended fix: Add a custom `parseOutput` for `ESLINT_PRESET` that iterates ESLint's top-level file entries and flattens each `messages[]` item into hub findings, mapping `filePath`, `line`, `severity`, and message text. Add an integration-style test using a real ESLint JSON sample.
- Confidence: high

### 3. [HIGH] `GenericAdapter.parseResult()` normalizes paths against `process.cwd()` instead of the snapshot root
- Location: src/adapters/generic-adapter.js:352
- Why it matters: Agent processes are spawned with `cwd: snapshotPath`, so relative file paths in CLI output are relative to the snapshot copy, not the workspace root. Using `process.cwd()` causes false traversal failures, wrong normalized paths, and unstable dedupe keys whenever reviews run against an isolated snapshot.
- Recommended fix: Thread the actual `snapshotPath` through the adapter parsing path instead of reading `process.cwd()`. Update the execute/parseResult contract so `GenericAdapter` receives the same snapshot root the child process used, and add tests covering relative paths from a temporary snapshot directory.
- Confidence: high

### 4. [MEDIUM] `registerAdapter()` throws an uncontrolled `TypeError` for `null` or primitive input
- Location: src/adapters/adapter-registry.js:74
- Why it matters: The duck-typing branch uses `'agentId' in configOrAdapter` without first verifying that the value is a non-null object. A bad caller gets a low-level runtime exception instead of the intended validation error, which makes API failures harder to handle and test.
- Recommended fix: Guard `configOrAdapter` with `typeof configOrAdapter === 'object' && configOrAdapter !== null` before any property or `in` checks. Reject invalid inputs with a deliberate `Error` message, and add tests for `null`, `undefined`, and primitive values.
- Confidence: high

### 5. [MEDIUM] `SEMGREP_PRESET` loses Semgrep severity and human-readable message
- Location: src/adapters/adapter-registry.js:178
- Why it matters: Semgrep JSON places the useful text and severity under `extra.message` and `extra.severity`. The generic extractor ignores those nested fields, so findings degrade to summary=`check_id`, severity=`medium`, and empty evidence. That materially weakens review quality and ranking.
- Recommended fix: Provide a Semgrep-specific `parseOutput` that reads `results[]`, uses `path`, `start.line`, `extra.message`, `extra.severity`, and optional metadata/fix text, then converts them into canonical findings. Add a test with representative Semgrep JSON.
- Confidence: high

### 6. [MEDIUM] `parseJsonOutput()` does not reliably find the trailing JSON block it claims to parse
- Location: src/adapters/generic-adapter.js:135
- Why it matters: The regex `/(?)/` is not the issue; the current `/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/` is greedy and starts at the first `{`/`[` it can satisfy, so log noise or prose before the final JSON block can make parsing fail entirely. That turns valid structured output into zero findings.
- Recommended fix: Replace the greedy regex approach with a deterministic parser: either scan backward for the last complete JSON value, or require/customize a parser per tool format. Add tests for output shaped like `log lines...\n{...valid JSON...}` and `note\n[...valid array...]`.
- Confidence: medium

## Recommendations
- Restore built-in registration from a single shared helper and verify `resetRegistry()` preserves both `codex` and `mcp-codex`.
- Pass the actual snapshot root into `GenericAdapter.parseResult()` so path normalization matches the child process working directory.
- Implement tool-specific `parseOutput` handlers for `ESLINT_PRESET` and `SEMGREP_PRESET` instead of relying on the flat generic JSON extractor.
- Harden `registerAdapter()` input validation so invalid values fail with explicit errors rather than `TypeError`.
- Replace the greedy trailing-JSON regex with a robust extraction strategy and add regression tests for mixed log + JSON output.
- Rerun review: yes
