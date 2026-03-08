# 💡 BRIEF: Extension - Agent Communication Hub

**Ngày tạo:** 2026-03-08
**Brainstorm cùng:** Quang

---

## 1. VẤN ĐỀ CẦN GIẢI QUYẾT

Hiện tại, 3 AI agents (Antigravity, Codex CLI, Claude Code CLI) giao tiếp bằng cách **ghi/đọc file .md** — chậm, mất context, và bị lỗi font (encoding) trong PowerShell.

**Pain points cụ thể:**

| Vấn đề | Chi tiết |
|--------|---------|
| Lỗi font | Codex CLI output qua PowerShell bị lỗi encoding tiếng Việt |
| Giao tiếp gián tiếp | Antigravity → ghi file → Codex đọc → ghi file → Antigravity đọc lại |
| Không song song | Chỉ chạy 1 reviewer (Codex) tại 1 thời điểm |
| Không trực quan | Không thấy agents "nói chuyện" real-time |

## 2. GIẢI PHÁP ĐỀ XUẤT

Xây dựng **Agent Communication Hub** — local server + web dashboard:

```
┌──────────────────────────────────────────────┐
│           Web Dashboard (Browser)             │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Antigravity  │  │ Codex    │  │ Claude   │ │
│  │   (Master)   │  │ (Review) │  │ (Review) │ │
│  └──────┬───────┘  └────┬─────┘  └────┬─────┘ │
│         │               │              │       │
│         └───────┬───────┴──────┬───────┘       │
│                 ▼              ▼               │
│          ┌─────────────────────────┐           │
│          │   Message Hub (Server)   │           │
│          │  WebSocket + REST API    │           │
│          │  UTF-8 clean encoding    │           │
│          └─────────────────────────┘           │
└──────────────────────────────────────────────┘
```

## 3. VAI TRÒ CỦA TỪNG AGENT

| Agent | Vai trò | Cách kết nối |
|-------|---------|-------------|
| **Antigravity** | Master Orchestrator + Fixer | Gửi task → nhận findings → fix code |
| **Codex CLI** | Quality Reviewer #1 | Nhận code → review → trả findings |
| **Claude Code CLI** | Quality Reviewer #2 | Nhận code → review → trả findings |

> ⚠️ **Quan trọng:** Chỉ Antigravity (và agents con của nó) mới được phép **sửa code**. Codex + Claude Code chỉ review và critique.

## 4. ĐỐI TƯỢNG SỬ DỤNG

- **Primary:** Developer dùng Antigravity workflow (chính mình)
- **Secondary:** Bất kỳ ai muốn orchestrate nhiều AI CLI agents

## 5. TÍNH NĂNG

### 🚀 MVP (Bắt buộc có):

- [ ] **Local Server** — Node.js server chạy trên máy, xử lý message giữa agents
- [ ] **Web Dashboard** — Giao diện browser hiển thị agents chat real-time
- [ ] **Parallel Review** — Gửi code cho Codex + Claude Code review cùng lúc
- [ ] **Side-by-side View** — Hiển thị 2 cột so sánh findings từ 2 reviewers
- [ ] **UTF-8 Clean** — Xử lý encoding chuẩn, không phụ thuộc PowerShell
- [ ] **Message API** — REST/WebSocket API để agents gửi/nhận messages

### 🎁 Phase 2 (Làm sau):

- [ ] Auto-merge findings (gộp findings trùng lặp từ 2 agents)
- [ ] Session history (lưu lại các phiên review trước)
- [ ] Code annotation (link findings đến dòng code cụ thể)
- [ ] Configurable agents (thêm/bớt agent dễ dàng)

### 💭 Backlog (Cân nhắc):

- [ ] VS Code Extension integration
- [ ] Support thêm agents (Gemini CLI, Cursor, etc.)
- [ ] Auto-resolve conflicts giữa 2 reviewers

## 6. ƯỚC TÍNH SƠ BỘ

### Độ phức tạp theo feature:

| Feature | Độ khó | Thời gian |
|---------|--------|-----------|
| Local Server (WebSocket + REST) | 🟢 Dễ | 1-2 ngày |
| Web Dashboard (React/Vite) | 🟡 TB | 2-3 ngày |
| Codex CLI integration | 🟢 Dễ | 1 ngày (đã có wrapper) |
| Claude Code CLI integration | 🟡 TB | 1-2 ngày |
| Parallel execution | 🟢 Dễ | 1 ngày |
| Side-by-side comparison | 🟡 TB | 1-2 ngày |

**Tổng MVP: ~7-10 ngày**

### Rủi ro:

- Claude Code CLI chưa có wrapper scripts → cần tạo mới
- WebSocket stability khi agents gửi output lớn
- Codex/Claude Code CLI có thể thay đổi API/output format

## 7. BƯỚC TIẾP THEO

→ Chạy `/plan` để lên thiết kế chi tiết
