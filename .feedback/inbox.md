# Codex Feedback Inbox — Spike Report Review

**Reviewer:** Codex (gpt-5.4, xhigh reasoning)
**Date:** 2026-03-08
**Tokens used:** 98,486
**Source:** `.agents/codex-feedback.md`

---

## Finding #1 — ❌ CRITICAL: Report kết luận sai so với evidence

**Report nói SPIKE PASS, nhưng `spike-results.json` ghi ngược lại:**
- Codex: `EXIT_2` (exit code 2, `unexpected argument 'review' found`)
- Claude: `TIMEOUT` (60s, no output)
- Parallel: `pass: false`, `ranParallel: false`

**Kết luận Codex:** Đây không phải "known limitation" — đây là **fail** của Phase 0 gate.

> Refs: `spike-results.json:4,8,12,22,29,39` | `spike-report.md:4` | `BRIEF.md:130,143`

---

## Finding #2 — 🔴 HIGH: Parallel test fact mismatch

Report nói test dùng PowerShell `Start-Job`, nhưng script thực tế dùng Node.js `spawn` + `Promise.all` với `shell: true`. Evidence không khớp claim.

> Refs: `spike-report.md:54,60` | `spike-test.js:21,25,140,155`

---

## Finding #3 — 🔴 HIGH: `--output-format json` là HIGH risk, không phải nhỏ

Đường machine-readable duy nhất đã timeout 60s không trả gì. Workaround "text mode + parse tay" chưa được test. BRIEF yêu cầu UTF-8 JSON pipeline cho finding schema.

> Refs: `spike-report.md:36,38` | `spike-results.json:17,22,24` | `BRIEF.md:53,100,123,140`

---

## Finding #4 — 🔴 HIGH: Test logic cho false confidence

- `TIMEOUT` được tính là `pass` cho Codex (line 96)
- `utf8Clean: true` khi stdout rỗng (vacuously true)
- `jsonParseable` không tham gia pass/fail
- Silent failure vẫn bị báo "pass"

> Refs: `spike-test.js:46,51,96,115,125,156,157`

---

## Finding #5 — 🟡 MEDIUM: Recommended commands chưa được test

Script không chạy `codex review --skip-git-repo-check` cũng không chạy `claude -p --no-session-persistence`. Recommendation là assumption, không phải verified baseline.

> Refs: `spike-report.md:22,39,82,85` | `spike-test.js:87,88,108,110`

---

## Finding #6 — 🟡 MEDIUM: Architecture recommendation quá mỏng

Đúng hướng nhưng bỏ qua: immutable snapshot, read-only enforcement, cancel/retry, large output, dedupe/schema normalization. Hợp lý như skeleton, không đủ để "Proceed to Phase 1".

> Refs: `spike-report.md:91,92` | `BRIEF.md:56,68,78,160,195,202`

---

## Codex Conclusion

> **Phase 0 chưa pass. Evidence mâu thuẩn. Cần rerun spike với command chuẩn và test oracle chặt hơn.**
