# Phase 02: Smart Auto-Merge

Status: ⬜ Pending
Dependencies: Phase 1 complete (existing `_groupFindings()` in session.js)
Est: 1 session

## Objective

Nâng cấp finding deduplication từ "group by dedupe_key" → "smart merge" với:
- Fuzzy matching cho similar findings (không cần exact dedupe_key)
- Merge strategy: keep richest evidence, combine agent badges
- Conflict resolution khi 2 agents report khác severity
- Merge confidence score

## Hiện trạng (Phase 1)

`Session._groupFindings()` groups by exact `dedupe_key` (hash of file + line + normalizedSummary).

**Limitations:**
- Codex nói "Missing null check in handler" và Claude nói "handler lacks null guard"
  → 2 dedupe_keys khác nhau → hiện 2 rows riêng biệt
- Severity disagrees: Codex says `high`, Claude says `medium` → no resolution

## Requirements

### Functional
- [ ] `MergeEngine` class with configurable strategies
- [ ] Fuzzy match: normalize summaries → compare similarity (Jaccard or Levenshtein)
- [ ] Merge threshold: configurable (default 0.7 similarity)
- [ ] Severity resolution: take highest severity when agents disagree
- [ ] Merged finding preserves ALL original findings as `sources[]`
- [ ] Each merged finding shows agent badges: `[codex] [claude]`
- [ ] Unmatched findings pass through as-is
- [ ] Merge stats: `{ total, merged, unique, conflicts }`

### Non-Functional
- [ ] O(n²) acceptable for typical session sizes (<100 findings)
- [ ] Deterministic: same input → same output
- [ ] Backward-compatible: `_groupFindings()` still works, MergeEngine is opt-in

## Implementation Steps

1. [ ] Implement text similarity utility (`src/utils/similarity.js`)
   - `normalizeText(text)` — lowercase, strip punctuation, collapse whitespace
   - `tokenize(text)` — split into word tokens
   - `jaccardSimilarity(tokens1, tokens2)` — set intersection / union
   - `isSimilar(text1, text2, threshold)` — convenience wrapper

2. [ ] Implement `MergeEngine` class (`src/hub/merge.js`)
   ```js
   class MergeEngine {
     constructor(options = {}) {
       this.threshold = options.threshold ?? 0.7;
       this.severityStrategy = options.severityStrategy ?? 'highest';
     }
     
     merge(findings) → { merged: MergedFinding[], stats: MergeStats }
   }
   ```

3. [ ] Define `MergedFinding` type
   ```js
   /** @typedef {Object} MergedFinding
    *  @property {string} id - Merged finding ID
    *  @property {string} file
    *  @property {number|null} line
    *  @property {string} severity - Resolved severity
    *  @property {string} summary - Best summary (longest/most detailed)
    *  @property {string[]} agents - Agent IDs that found this
    *  @property {Finding[]} sources - Original findings
    *  @property {number} confidence - Merge confidence (0-1)
    *  @property {string} dedupe_key - New merged dedupe_key
    */
   ```

4. [ ] Merge algorithm
   ```
   For each finding:
     1. Check same file (exact match required)
     2. Check same line (±3 lines tolerance)
     3. Check summary similarity (Jaccard ≥ threshold)
     4. If all match → merge into existing group
     5. Else → create new group
   ```

5. [ ] Integrate into `Session.finalize()`
   - After `_groupFindings()`, optionally run `MergeEngine.merge()`
   - Store both `rawFindings` and `mergedFindings` in session
   - API response includes both

6. [ ] Write tests (`src/hub/merge.test.js`, `src/utils/similarity.test.js`)

## Files to Create/Modify

- `src/utils/similarity.js` — NEW: Text similarity utilities
- `src/utils/similarity.test.js` — NEW: Tests
- `src/hub/merge.js` — NEW: MergeEngine class
- `src/hub/merge.test.js` — NEW: Tests  
- `src/hub/session.js` — MODIFY: integrate MergeEngine in finalize()
- `src/server.js` — MODIFY: expose merged findings in API

## Test Criteria

- [ ] Identical summaries → merged (confidence 1.0)
- [ ] Similar summaries above threshold → merged (confidence = similarity)
- [ ] Different files → never merged
- [ ] Same file, distant lines (>3) → not merged
- [ ] Severity resolution: `high` + `medium` → `high`
- [ ] Merged finding has both agent badges
- [ ] Sources array contains original findings
- [ ] Stats count is accurate
- [ ] Deterministic ordering
- [ ] Empty input → empty output
- [ ] Single finding → passthrough (no merge needed)

## Notes

- Jaccard similarity is simple but effective for this use case
  (findings are short, keyword-heavy sentences)
- Line tolerance ±3 handles minor line shifts between agent reports
- Future: could add LLM-based semantic matching, but overkill for now

---
Next Phase: [Phase 03 — Side-by-Side Findings UI](./phase-03-side-by-side-ui.md)
