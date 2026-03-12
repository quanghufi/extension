---
id: 00-extension-agent-hub
name: 00-extension-agent-hub
description: "Skill chính cho dự án Extension — Agent Communication Hub. Dùng để điều phối Phase 1 event-driven hub, review kiến trúc, và giữ đúng các quyết định đã được spike v3 xác nhận."
category: local-project
risk: safe
source: workspace
date_added: "2026-03-10"
---

## When to Use

Use this skill whenever working inside `D:\extension` or when the task involves Antigravity, Codex CLI, the review hub, snapshot isolation, streaming output capture, or Phase 1 implementation planning.

## Project Identity

`Extension` là hub giao tiếp đa-agent theo kiến trúc event-driven để cho Antigravity và Codex CLI cộng tác review code.

- Trạng thái hiện tại: Phase 0 spike đã hoàn tất, pass gate tests.
- Trạng thái tiếp theo: sẵn sàng cho Phase 1 — Event-Driven Hub.
- Evidence mạnh nhất nằm trong repo, không dựa vào run thủ công ngoài repo.

## Canonical Sources

Ưu tiên đọc theo thứ tự này khi cần context:

1. `AGENTS.md`
2. `docs/BRIEF.md`
3. `.feedback/inbox-v3.md`
4. `.feedback/action-plan-v3.md`
5. `docs/spike-report.md`

## Non-Negotiable Decisions

- Evidence trong repo thắng mọi assumption bên ngoài repo.
- UTF-8 phải được enforce end-to-end; luôn decode explicit từ bytes.
- Reviewer phải chạy trên immutable snapshot, read-only ở Phase 1.
- Dùng `spawn(shell:false)` cho production; không dùng `exec()`.
- Timeout phải là 3 tầng: `firstByte`, `idle`, `hard`.
- Không dùng cờ `--skip-git-repo-check` cho Codex.
- Không đánh giá pass/fail chỉ từ `stdoutBytes`; phải dùng `combinedBytes`.
- Codex có thể đẩy output chủ yếu sang `stderr`; đây là expected behavior.

## Working Rules

- Giao tiếp và tài liệu tiếng Việt là bình thường.
- Feedback từ agent đặt trong `.feedback/`.
- Run logs đặt trong `.agents/runs/`.
- Không sửa `docs/spike-results.json` vì đó là evidence.
- Nếu file target đã vượt ngưỡng cảnh báo split thì tách file trước khi thêm code.
- Không tạo file mới vượt 300 dòng.

## Phase 1 Focus

Khi được giao implement, ưu tiên theo thứ tự:

1. Agent adapter cho Codex CLI
2. Session manager / event hub
3. Snapshot isolation cho reviewer
4. Finding schema + dedupe
5. Session history
6. UI timeline + findings table tối giản

## Output Expectations

Khi phân tích hoặc đề xuất thay đổi, nên:

- Nêu rõ assumption nào đã được spike xác nhận.
- Chỉ ra rủi ro encoding, timeout, và snapshot consistency.
- Ưu tiên fix root cause thay vì workaround tạm.
- Giữ thay đổi nhỏ, bám đúng kiến trúc event-driven.

## Quick Reminders

- Nếu kiểm tra CLI output, luôn xem cả `stdout` và `stderr`.
- Nếu cần test reviewer song song, đảm bảo cùng một snapshot/revision.
- Nếu thấy mâu thuẫn giữa README cũ và evidence mới, ưu tiên `AGENTS.md` + docs spike mới nhất.
