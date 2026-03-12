# Codex Review

## Overview
- Status: has_findings
- Summary: `package.json` is not yet sufficient for a reliable `npm install -g` release. The main gaps are the missing executable entry point, missing Node version guardrails for the ESM/runtime features already used in the repo, lack of a publish whitelist, and no packaging smoke test to catch broken tarballs before publish.
- Findings: 5

## Key Findings

### 1. [HIGH] No `bin` mapping means a global install will not create the `extension-hub` command
- Location: package.json
- Why it matters: The stated goal is `npm install -g` usability, but the current manifest has no `bin` field. npm will install the package without generating an executable shim, so users cannot launch the CLI after global install.
- Recommended fix: Add a top-level `bin` field such as `{ "extension-hub": "./bin/extension-hub.js" }`. Ensure `bin/extension-hub.js` exists in the published package, starts with a shebang (`#!/usr/bin/env node`), and explicitly imports/starts the server instead of assuming direct execution of `src/server.js`.
- Confidence: high

### 2. [HIGH] Missing `engines.node` allows installs on unsupported Node versions
- Location: package.json:4
- Why it matters: This repo already depends on modern ESM/runtime behavior (`type: module`, `import.meta.dirname` fallback logic in `src/server.js`, Node's built-in test runner). Without an `engines` floor, npm can install the package on older Node releases where the CLI may fail immediately or behave differently once installed globally.
- Recommended fix: Add an `engines` entry that matches the documented support policy, e.g. `"engines": { "node": ">=20" }`. Keep the value aligned with the actual minimum runtime needed by the CLI and add a packaging test that runs the global entrypoint under that minimum supported Node version.
- Confidence: high

### 3. [MEDIUM] No `files` whitelist makes the publish artifact easy to get wrong or leak internal repo contents
- Location: package.json
- Why it matters: Relying on a future `.npmignore` alone is fragile. A missed ignore rule can publish repo-only material such as `.agents`, `data/sessions`, plans, docs, tests, and `__pycache__`; an over-broad ignore can also omit required runtime assets like `src/ui/*`, JSON schemas, or Python bridge files. Both cases turn into install-time or runtime failures for global users.
- Recommended fix: Add a top-level `files` allowlist and treat `.npmignore` only as a secondary filter. Include exactly the runtime payload required by the CLI, for example `bin/`, `src/**/*.js`, `src/ui/`, `src/schema/*.json`, and any Python files the shipped command can invoke. Then verify with `npm pack --json` and inspect the tarball contents before publish.
- Confidence: high

### 4. [MEDIUM] The manifest has no packaging smoke-test script to validate the published tarball
- Location: package.json:5
- Why it matters: The current `scripts` section exercises source-tree execution, not the installable package. That leaves common release regressions undetected: broken `bin` path, missing shebang, omitted UI assets, omitted schema files, or CLI startup failures after `npm pack`/global install.
- Recommended fix: Add a packaging verification script in `package.json`, for example a `prepack`/`pack:smoke` script that runs `npm pack`, installs the generated tarball into a temp directory, and executes `extension-hub --help` or a minimal `--port` startup check. Fail the release if the packed artifact cannot start.
- Confidence: high

### 5. [MEDIUM] Package metadata does not currently communicate external runtime expectations for globally installed users
- Location: package.json:13
- Why it matters: The package exposes scripts that depend on Python (`src/mcp/codex_review_mcp.py`) and Codex tooling, but the manifest does not distinguish what the globally installed CLI requires versus what is optional. That increases support risk because users may assume `npm install -g extension-hub` is self-contained when some commands are not.
- Recommended fix: Decide which capabilities are part of the supported global CLI surface. If Python/Codex-backed features are optional, keep them out of the default CLI path and document them in README. If they are required, state the requirement explicitly in `description`/README and add an install or startup check that fails with a clear message when the external dependency is missing.
- Confidence: medium

## Recommendations
- Add a top-level `bin` entry for `extension-hub` and make the CLI bootstrap explicit rather than relying on `src/server.js` direct-execution detection.
- Add `engines.node` with the real minimum supported version for the shipped ESM CLI.
- Use a strict `files` whitelist so the packed artifact contains only required runtime assets.
- Add a tarball/global-install smoke test to `scripts` and run it before publishing.
- Clarify which non-Node dependencies are required for the globally installed CLI and document or gate them accordingly.
- Rerun review: yes
