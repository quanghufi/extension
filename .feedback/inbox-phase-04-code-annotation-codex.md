# Codex Review — phase-04-code-annotation

Source: `plans/260308-1959-phase2-polish/phase-04-code-annotation.md`
Reviewer: `codex exec`
Date: 2026-03-10
Verdict: Needs revision before implementation

## Top Risks
- API đang nghiêng về `snapshot`-bound thay vì `session`-bound, dễ lệch revision với runtime hiện tại ở `src/server.js` và `src/hub/session.js`.
- Path validation đề xuất kiểu `startsWith(snapshot_dir)` là chưa đủ chắc trên Windows; nên tái dùng chuẩn hóa path ở `src/utils/paths.js`.
- UI click flow chưa có cơ chế chặn stale response overwrite response mới khi click finding liên tiếp.
- Cache key chưa chốt theo session/snapshot nên có nguy cơ render nhầm nội dung file từ revision khác.
- Finding-to-source mapping chưa định nghĩa rõ cho `line = null`, `line <= 0`, `line > EOF`, và nhiều finding cùng dòng.

## Missing Tests
- Race test cho 2 request click liên tiếp.
- Cache isolation test giữa 2 session/snapshot khác nhau cùng một `path`.
- Invalid line tests: `null`, `0`, âm, vượt EOF.
- Windows path tests: drive-letter, UNC, mixed slash, encoded traversal.
- Non-text file tests: binary, invalid UTF-8, CRLF-heavy, file rất lớn.
- Lifecycle test khi snapshot đã cleanup mà UI vẫn yêu cầu mở file.

## Recommended Changes
- Đổi API sang session-bound, ví dụ: `GET /api/sessions/:id/files?path=...`.
- Reuse `normalizeFindingPath` ở `src/utils/paths.js` thay vì rule path riêng.
- Dùng `AbortController` hoặc request token để chỉ response mới nhất được cập nhật UI.
- Cache key tối thiểu: `{sessionId, snapshotId, normalizedPath}`.
- Định nghĩa fallback rõ cho bad line / non-text / too-large file.
- Chốt rõ viewer lấy dữ liệu từ raw finding, grouped finding hay merged finding.
