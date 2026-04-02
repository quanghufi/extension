# Debate Enhancement: Strict Schema + Adversarial Prompts + Review Gate

**Date:** 2026-04-02
**Status:** Draft
**Inspired by:** [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)

## Summary

Integrate three features from codex-plugin-cc into Extension Hub's debate system:
1. **Strict Finding Schema** — structured output envelope with verdict/confidence
2. **Adversarial Prompt Modes** — design-challenge prompts alongside bug-hunting
3. **Review Gate** — post-consensus validation before debate resolves

All features are opt-in. Default behavior unchanged.

## Build Order

Schema → Adversarial Prompts → Review Gate (bottom-up dependency).

---

## 1. Strict Finding Schema

### What

Wrap agent output in a structured envelope:

```js
{
  verdict: 'fail' | 'pass' | 'conditional',
  summary: 'string',
  findings: [
    {
      ...existingFinding,           // file, line, severity, summary, details
      confidence: 'certain' | 'likely' | 'inference',
    }
  ],
  next_steps: ['string'],
}
```

### Rules

- `confidence: 'inference'` findings are excluded from consensus weight
- Findings sorted by severity DESC (critical → info)
- Agent must not auto-fix — report only

### Files Changed

| File | Change |
|------|--------|
| `src/schema/events.js` | Add `createStructuredOutput()`, `validateStructuredOutput()`, add `confidence` to finding schema |
| `src/adapters/base-adapter.js` | `parseResult()` normalizes output to structured schema; fallback for unstructured output |
| `src/hub/consensus-engine.js` | Use `confidence` as weight modifier in agreement calculation |

### Fallback

If an agent returns unstructured output (legacy), wrap it:
```js
{ verdict: 'fail', summary: raw.substring(0, 200), findings: parsedFindings, next_steps: [] }
```

---

## 2. Adversarial Prompt Modes

### What

Add `promptMode` to debate config:

```js
{
  promptMode: 'normal' | 'adversarial' | 'escalating',
}
```

| Mode | Behavior |
|------|----------|
| `normal` | Current bug-hunting prompts (default) |
| `adversarial` | Design challenge — questions approach, assumptions, scalability |
| `escalating` | Starts normal, auto-switches to adversarial if round 1 yields < 3 findings |

### Adversarial Prompt Template

```
You are a hostile design reviewer. Do NOT look for bugs.
Challenge:
1. Why this approach over alternatives?
2. Where does this fail at 10x load / edge cases / concurrency?
3. What implicit assumptions are untested?
4. What's the 6-month maintenance cost?
```

### Files Changed

| File | Change |
|------|--------|
| `src/hub/debate-orchestrator.js` | `buildInitialReviewPrompt()` switches template by `promptMode`; `escalating` logic after round 1 |
| `src/schema/events.js` | Add severity level `design_challenge` |
| `src/mcp-collab-tools.js` | `hub_start_debate` accepts `promptMode` param |
| `src/mcp-server.js` | `hub_create_review_and_start_dual_debate` accepts `promptMode` param |

---

## 3. Review Gate

### What

Post-consensus validation gate. Runs after debate consensus, before resolve.

```
Consensus reached → Review Gate → PASS → resolve
                                → BLOCK → inject warnings, optional extra round
```

### Config

```js
{
  reviewGate: {
    enabled: true,
    judge: 'claude-code',
    blockOnRegression: true,
    maxSeverityToSkip: 'info',
  }
}
```

### Gate Logic

1. Filter agreed findings with `severity > maxSeverityToSkip`
2. Judge agent verifies each finding against actual code
3. Judge returns structured output: CONFIRM / DOWNGRADE / REJECT per finding
4. PASS if >= 70% confirmed
5. BLOCK if < 70% confirmed or regression detected → inject new findings

### Files Changed

| File | Change |
|------|--------|
| `src/hub/review-gate.js` | **New file** — `ReviewGate` class: gate logic, prompt builder, pass/block |
| `src/hub/debate-orchestrator.js` | `DebateExecutor.run()` calls `runReviewGate()` after consensus |
| `src/hub/session.js` | Add `gateState: 'pending' | 'passed' | 'blocked'` to session |
| `src/mcp-server.js` | `hub_get_status` returns `gateState`; debate tools accept `reviewGate` config |
| `src/mcp-collab-tools.js` | `hub_start_debate` accepts `reviewGate` config |

---

## MCP Tool Changes Summary

| Tool | New Params |
|------|-----------|
| `hub_start_debate` | `promptMode`, `reviewGate` |
| `hub_create_review_and_start_dual_debate` | `promptMode`, `reviewGate` |
| `hub_get_status` | Returns `gateState` in response |
| `hub_get_findings` | Findings include `confidence` field |

## Non-Breaking Guarantees

- All new params are optional with sensible defaults
- `promptMode` defaults to `'normal'`
- `reviewGate` defaults to `{ enabled: false }`
- `confidence` defaults to `'certain'` when not provided by agent
- Existing adapters continue working via fallback wrapper
