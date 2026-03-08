# Feedback Process

## Mục tiêu
Thu thập và xử lý phản hồi từ Codex CLI một cách có cấu trúc.

## Cấu trúc
- `inbox.md` — Raw findings từ Codex
- `responses.md` — Decisions (Accept/Reject) cho từng finding
- `action-plan.md` — Task list từ accepted findings

## Quy trình
1. Codex review → raw output → `.agents/codex-feedback.md`
2. Parse findings → `inbox.md`
3. Triage → `responses.md`
4. Create tasks → `action-plan.md`
