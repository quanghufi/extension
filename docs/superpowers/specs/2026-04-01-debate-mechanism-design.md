# Debate Mechanism Design — Token-Efficient & Effective

## Status
**Implemented**: v1.0 — Branch `feature/debate-opt` (worktree `debate-opt`)

## Implementation Summary

Two commits implement the full spec:
- `de2822e` — Replace multi-round debate loop with targeted judge (Phase 3)
- `1ea4dd7` — Add auto-reject low severity + expose judgeAgent/disputedThreshold config

**All 579 tests pass.**

## Overview

Thiết kế cơ chế debate mới cho Extension Hub, tối ưu hóa giữa **effectiveness** (accurate, reliable findings) và **token efficiency** (tiết kiệm ~30-50% so với full multi-round hiện tại).

**Goals**:
- Multi-agent debate ngắn gọn (1-2 rounds max)
- Token budget: 50-100K tokens/debate
- Latency: 1-2 phút
- Judge đáng tin cậy với evidence-based verification
- Scope linh hoạt: file hoặc project (user chỉ định)

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Debate Orchestrator                  │
│                  (debate-orchestrator.js)             │
└──────────────────────┬───────────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   ┌─────────┐   ┌──────────┐   ┌─────────────────┐
   │ Phase 1 │──▶│ Phase 2  │──▶│ Phase 3 (Judge) │
   │ Parallel│   │ Auto-    │   │ Targeted for    │
   │ Review  │   │ Merge    │   │ Disputed Only   │
   └─────────┘   └──────────┘   └─────────────────┘
                                           │
                                           ▼
                                    ┌─────────────┐
                                    │ Phase 4     │
                                    │ Resolve &   │
                                    │ Notify User │
                                    └─────────────┘
```

---

## Detailed Flow

### Phase 1: Parallel Review (~30-50K tokens)

**What**: Codex + Claude-Code chạy review **song song** (parallel execution).

**Implementation**:
- Use `runReviewPass()` với `Promise.allSettled()` để chạy agents parallel.
- Prompt: Dùng `buildInitialReviewPrompt()` — focus scope (file/project chỉ định), ignore stale artifacts.
- Output: Mỗi agent trả findings JSON `{ dedupeKey, severity, title, evidence, fixInstructions, ... }`.

**Token optimization**: Parallel execution giảm latency và sum token output không tăng nhiều.

---

### Phase 2: Auto-Merge & Infer Evaluations (~0 tokens, pure logic)

**What**: Merge findings + infer evaluations dựa trên presence/absence.

**Implementation**:
- Dùng `groupFindings()` + `mergeFindingsSmart()` để merge findings by dedupeKey.
- Infer evals:
  - Finding ở **cả 2 agents** → `status: 'agreed'`, `confidence: 1.0`
  - Finding ở **chỉ 1 agent** → `status: 'disputed'`
  - Finding **dropped** (rejected by eval) → excluded
- **Auto-reject low severity disputed** (severity ≤ threshold, configurable via `disputedThreshold` param) — implemented in `run()` Phase 3, before judge runs. Threshold defaults to `'low'`. Also exposed via `hub_start_debate` MCP tool param.

**Token optimization**: Pure logic, no LLM calls.

---

### Phase 3: Targeted Judge for Disputed (~20-50K tokens, chỉ nếu cần)

**What**: Claude-Code làm judge chỉ cho disputed findings.

**Trigger**: Chỉ run nếu disputed > 0.

**Implementation**:
1. **Batch disputed findings** nhỏ (1-2 findings/batch) — giống `splitDisputedIntoBatches()` hiện tại, nhưng ensure size ≤ 2.
2. **Judge prompt**: Dùng `buildJudgePrompt()` — require:
   - `verdict`: 'confirmed' | 'rejected'
   - `evidence`: Exact file/line/code snippet (bắt buộc, nếu thiếu → auto-reject)
   - `rationale`: 2-3 sentences based on code read
   - `suggested_fix`: Concrete fix (nếu confirmed)
3. **Output validation**: Parser phải extract `verdict` + `evidence` fields. Nếu `evidence` missing/empty → auto-reject finding.
4. **Update verdicts**: Accepted disputed → `status: 'confirmed'`, confidence = 1.0. Rejected → dropped.

**Token optimization**:
- Judge chỉ disputed (không re-judge agreed).
- Batch nhỏ → prompts ngắn → tokens thấp.
- Early stop nếu all disputed resolved.

---

### Phase 4: Resolve & Notify User (~0 tokens)

**What**: Apply final findings + thông báo user.

**Implementation**:
- Dùng `applyResolvedFindings()` để lưu final findings vào session.
- Output report cho user:
  ```json
  {
    "total": N,
    "confirmed": M,
    "rejected": K,
    "findings": [
      {
        "dedupeKey": "...",
        "severity": "high",
        "title": "...",
        "status": "confirmed",
        "evidence": "file:123: exact code",
        "rationale": "...",
        "suggested_fix": "..."
      }
    ]
  }
  ```
- Lưu vào `session.allFindings`, `session.groupedFindings`, `session.judgeVerdicts`.

---

## Token Estimate Summary

| Phase | Tokens | Notes |
|-------|--------|-------|
| Phase 1: Parallel Review | 30-50K | 2 agents × (input context + output findings) |
| Phase 2: Auto-Merge | 0 | Pure logic |
| Phase 3: Targeted Judge | 20-50K | Chỉ disputed, batched 1-2 |
| Phase 4: Resolve | 0 | Pure logic |
| **Total** | **50-100K** | Trong budget B |

---

## Error Handling

| Scenario | Handling |
|----------|----------|
| 1 agent fails (timeout) | Retry 3x với exponential backoff. Nếu vẫn fail → continue với single-agent (auto-reject findings chỉ từ failed agent). |
| Both agents fail | Fail debate gracefully, notify user error, log for debugging. |
| Judge output malformed | Auto-reject finding (không trust unreliable output). |
| Too many disputed (>50) | Cap judge batches: prioritize high/critical severity. Low disputed auto-rejected. |
| Session disconnect mid-debate | Persist state after each phase. Resume/retry on reconnect. |

---

## Integration with Current Codebase

### Files to Modify

| File | Changes |
|------|---------|
| `src/hub/debate-orchestrator.js` | ✅ Phase 3 targeted judge in `run()`, `_findingsForKeys()` helper, auto-reject low severity, `judgeAgent`/`disputedThreshold` config support. |
| `src/hub/consensus-engine.js` | No changes needed — auto-reject handled in orchestrator `run()`. |
| `src/hub/debate-state.js` | ✅ Added `judging` state + transitions (`consensus_check → judging → resolved`). |
| `src/mcp-collab-tools.js` | ✅ Added `judgeAgent` and `disputedThreshold` params to `hub_start_debate`. |

### Files to Reuse (không thay đổi)

| File | Usage |
|------|-------|
| `src/hub/finding-aggregation.js` | `groupFindings()`, `mergeFindingsSmart()` — dùng nguyên. |
| `src/adapters/base-adapter.js` | Parallel execution via `Promise.allSettled()`. |
| `src/adapters/codex-adapter.js` | Giữ nguyên. |
| `src/adapters/claude-code-adapter.js` | Giữ nguyên. |

---

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Judge biased (trust findings blindly) | High | Evidence requirement + validation (auto-reject nếu thiếu). |
| Token overflow (nhiều disputed) | Medium | Batch cap + severity prioritization. |
| Single-agent mode kém reliable | Low | Chỉ fallback khi agent fail; thông báo user. |
| Judge output parsing fails | Medium | Robust parser với fallback (presence/absence). |

---

## Testing Plan

1. **Unit tests**: Mock adapters, test Phase 2 (auto-merge logic), Phase 3 (validation). ✅ Updated `debate-orchestrator.test.js`, `debate-state.test.js`.
2. **Integration tests**: Test full flow với mock adapters. ✅ Updated `server-debate.test.js`.
3. **Token measurement**: Log tokens mỗi phase, assert total ≤ 100K. (Not yet instrumented — deferred.)
4. **Error injection**: Test agent failures, malformed judge output. ✅ Covered by existing retry/fallback tests (579/579 passing).
