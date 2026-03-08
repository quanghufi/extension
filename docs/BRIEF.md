# 💡 BRIEF v2: Extension — Agent Communication Hub

**Ngày tạo:** 2026-03-08
**Revision:** v2 (post-Codex critique, 9 findings accepted)
**Brainstorm cùng:** Quang

---

## 1. VẤN ĐỀ CẦN GIẢI QUYẾT

3 AI agents (Antigravity, Codex CLI, Claude Code CLI) giao tiếp bằng **ghi/đọc file .md** — chậm, mất context, bị lỗi encoding trong PowerShell.

| Vấn đề | Chi tiết |
|--------|---------|
| Lỗi encoding | Codex CLI output qua PowerShell bị garble tiếng Việt |
| Giao tiếp gián tiếp | Antigravity → ghi file → Codex đọc → ghi file → đọc lại |
| Không song song | Chỉ chạy 1 reviewer tại 1 thời điểm |
| Không trực quan | Không thấy agents hoạt động real-time |

---

## 2. KIẾN TRÚC ĐỀ XUẤT

> **Thay đổi từ v1:** Thêm Agent Adapter layer. CLI không nói REST/WS trực tiếp.

```
┌─────────────────────────────────────────────────────┐
│                  UI Layer (Phase 1)                  │
│         Timeline + Findings Table (Browser)         │
└──────────────────────┬──────────────────────────────┘
                       │ WebSocket / SSE
┌──────────────────────▼──────────────────────────────┐
│              Hub / Session Manager                   │
│  • Session lifecycle    • Finding aggregation        │
│  • Event routing        • Snapshot management        │
│  • History storage      • Dedup & merge              │
└──────┬───────────────────────────┬──────────────────┘
       │                           │
┌──────▼──────┐            ┌───────▼──────┐
│  Adapter:   │            │  Adapter:    │
│  Codex CLI  │            │  Claude Code │
│  (PTY/stdio │            │  (PTY/stdio  │
│   capture)  │            │   capture)   │
└──────┬──────┘            └──────┬───────┘
       │ subprocess                │ subprocess
┌──────▼──────┐            ┌──────▼───────┐
│  Codex CLI  │            │ Claude Code  │
│  (headless) │            │   (headless) │
└─────────────┘            └──────────────┘
```

**Key design decisions:**
- Agent Adapter wrap subprocess/PTY, capture stdout/stderr → emit structured events
- Hub quản lý sessions, routing, aggregation — không parse raw CLI output
- UI nhận events qua WebSocket/SSE, render timeline + findings
- Review chạy trên **immutable snapshot** (git worktree hoặc read-only copy)

---

## 3. VAI TRÒ CỦA TỪNG AGENT

| Agent | Vai trò | Kết nối |
|-------|---------|---------|
| **Antigravity** | Master Orchestrator + Fixer | Gửi task → nhận findings → fix code |
| **Codex CLI** | Quality Reviewer #1 | Nhận snapshot → review → trả findings |
| **Claude Code CLI** | Quality Reviewer #2 | Nhận snapshot → review → trả findings |

> ⚠️ Chỉ Antigravity được **sửa code**. Reviewers chạy trên read-only snapshot. Đây là **enforcement kỹ thuật** (worktree/permissions), không chỉ policy.

---

## 4. REVIEW SNAPSHOT MODEL

> **Thay đổi từ v1:** Thêm concept immutable snapshot để findings không lệch revision.

Khi Antigravity trigger review:
1. Hub tạo snapshot từ current commit hash
2. Mỗi reviewer nhận **git worktree read-only** hoặc temp copy
3. Findings gắn với `commit_hash` + `snapshot_id`
4. Antigravity chỉ fix code **sau khi** cả 2 review xong và triage xong

---

## 5. FINDING SCHEMA

> **Thay đổi từ v1:** Định nghĩa schema ngay, không đợi phase 2.

### Event Schema
```json
{
  "session_id": "uuid",
  "agent_id": "codex | claude-code",
  "seq": 1,
  "event_type": "finding | status | error | heartbeat",
  "timestamp": "ISO-8601",
  "payload": {}
}
```

### Finding Schema
```json
{
  "id": "F-001",
  "severity": "critical | high | medium | low",
  "summary": "Mô tả ngắn",
  "evidence": "Chi tiết, trích dẫn code",
  "file": "src/server.ts",
  "line": 42,
  "confidence": 0.9,
  "dedupe_key": "hash(severity+file+line+summary)"
}
```

---

## 6. ENCODING STRATEGY

> **Thay đổi từ v1:** UTF-8 cần enforcement end-to-end, không tự xảy ra.

1. Agent Adapter launch CLI với `{ env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, encoding: 'utf-8' }`
2. Capture raw bytes từ stdout/stderr, decode explicit UTF-8
3. Nếu CLI output garbled → adapter detect + log warning, **không relay rác**
4. Hub store/transmit tất cả dưới dạng UTF-8 JSON
5. Test case bắt buộc: Vietnamese sample text qua full pipeline

---

## 7. PHASES

### ⚡ Phase 0: Spike (1-2 ngày) — GATE

> **Thay đổi từ v1:** Thêm Phase 0 để verify assumptions trước khi build.

Mục tiêu: chứng minh 4 thứ hoạt động trên Windows.

| Test | Pass criteria |
|------|--------------|
| Codex CLI headless | Chạy non-interactive, capture full output, exit clean |
| Claude Code CLI headless | Chạy non-interactive, capture full output, exit clean |
| UTF-8 capture | Vietnamese text qua CLI → adapter → JSON, không garble |
| Parallel execution | 2 CLI chạy cùng lúc trên cùng snapshot, không conflict |

**Nếu Phase 0 fail:** Dừng lại, reassess kiến trúc. Không tiếp Phase 1.

### 🏗️ Phase 1: Core Hub (3-5 ngày)

- [ ] Agent Adapter (Codex + Claude Code)
- [ ] Hub / Session Manager
- [ ] Review Snapshot (git worktree)
- [ ] Finding Schema + dedup
- [ ] Session history storage
- [ ] Simple UI: timeline + findings table (browser)

### 🎨 Phase 2: Polish (3-5 ngày)

- [ ] Side-by-side findings comparison
- [ ] Auto-merge findings trùng lặp
- [ ] Code annotation (link findings → line)
- [ ] Configurable agents (thêm/bớt agent)
- [ ] Cancel / retry / reconnect handling

### 💭 Backlog

- [ ] VS Code Extension integration
- [ ] Support thêm agents (Gemini CLI, Cursor, etc.)
- [ ] Auto-resolve conflicts giữa 2 reviewers

---

## 8. ƯỚC TÍNH THỰC TẾ

| Phase | Thời gian | Điều kiện |
|-------|-----------|-----------|
| Phase 0 Spike | 1-2 ngày | — |
| Phase 1 Core | 3-5 ngày | Phase 0 pass |
| Phase 2 Polish | 3-5 ngày | Phase 1 stable |
| **Tổng** | **~2-3 tuần** | |

### Rủi ro (cập nhật):

| Rủi ro | Severity | Mitigation |
|--------|----------|------------|
| CLI không chạy headless ổn | 🔴 Critical | Phase 0 spike verify |
| Output encoding garbled | 🟠 High | UTF-8 enforcement + fallback |
| Findings lệch revision | 🟠 High | Immutable snapshot model |
| CLI API/output format thay đổi | 🟡 Medium | Adapter layer absorb changes |
| Large output streaming | 🟡 Medium | Chunked transfer + backpressure |

---

## 9. VERIFICATION CHECKLIST

> **Thay đổi từ v1:** Thêm acceptance criteria rõ ràng.

MVP chỉ pass khi **tất cả** test cases sau pass:

- [ ] 2 reviewers chạy song song trên cùng snapshot, cùng revision
- [ ] Reviewer không write vào source — read-only enforcement
- [ ] Vietnamese text (UTF-8) qua full pipeline không garble
- [ ] Large output (>100KB) stream không crash, không truncate
- [ ] Cancel review giữa chừng → cleanup sạch
- [ ] Retry failed review → resume hoặc restart clean
- [ ] Duplicate findings bị dedup, không hiện 2 lần
- [ ] Session history lưu và load lại được

---

## 10. BƯỚC TIẾP THEO

1. **Chạy Phase 0 spike** — test headless CLI integration
2. Nếu pass → `/plan` để thiết kế Phase 1 chi tiết
3. Nếu fail → reassess, tìm alternative approach
