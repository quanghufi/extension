# Action Plan — Post Codex Critique

**Date:** 2026-03-08
**Findings accepted:** 6/6

---

## Immediate Actions (Before proceeding)

### 1. ❌ Đổi spike report verdict → SPIKE INCOMPLETE
- [ ] Cập nhật `docs/spike-report.md` verdict
- [ ] Thêm section "Discrepancy with automated results"

### 2. 🔧 Viết spike-test-v2.js
- [ ] Test đúng production commands:
  - `codex review --skip-git-repo-check "prompt"`
  - `claude -p --no-session-persistence "prompt"`
- [ ] TIMEOUT = FAIL (không phải pass)
- [ ] Require non-empty stdout
- [ ] Test `--output-format text` path (không json)
- [ ] Verify round-trip UTF-8 qua JSON serialization
- [ ] Test parallel bằng Node.js spawn (không PowerShell)
- [ ] Add test: large output handling
- [ ] Add test: stderr noise filtering

### 3. 🔄 Rerun spike v2
- [ ] Run spike-test-v2.js
- [ ] Generate spike-results-v2.json
- [ ] Update spike-report thành v2 dựa trên kết quả thực

---

## Deferred (Phase 1 design scope)

- Immutable snapshot mechanism
- Cancel/retry/reconnect
- Finding schema + dedup
- Full architecture spec

---

## Gate Decision

**⛔ Phase 0 NOT PASSED yet. Must rerun spike v2 and get clean results before proceeding.**
