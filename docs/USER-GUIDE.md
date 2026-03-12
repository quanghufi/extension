# Extension Hub — Hướng Dẫn Sử Dụng

## 📦 Cài Đặt

### Yêu cầu
- **Node.js 20+** (bắt buộc)
- **Python 3.10+** (tùy chọn — chỉ cần cho MCP Codex adapter)

### Cài global (khuyên dùng)

```bash
# Từ source code
cd d:\extension
npm install -g .

# Hoặc từ tarball (copy sang máy khác)
npm pack                                # tạo extension-hub-1.0.0.tgz
npm install -g extension-hub-1.0.0.tgz  # cài trên máy đích
```

### Gỡ cài đặt

```bash
npm uninstall -g extension-hub
```

---

## 🚀 Khởi Động

```bash
extension-hub                 # port mặc định 3849
extension-hub --port 4000     # port tùy chọn
extension-hub --help          # xem trợ giúp
extension-hub --version       # xem version
```

Sau khi khởi động:
- **Dashboard:** http://localhost:3849/
- **REST API:** http://localhost:3849/api/sessions
- **WebSocket:** ws://localhost:3849

Tắt server: `Ctrl+C` (graceful shutdown).

---

## 🔌 API Reference

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| GET | `/api/sessions` | Liệt kê sessions |
| POST | `/api/sessions` | Tạo review session |
| GET | `/api/sessions/:id` | Chi tiết session |
| DELETE | `/api/sessions/:id` | Xóa session |
| GET | `/api/sessions/:id/events` | Lấy events |
| GET | `/api/sessions/:id/findings` | Lấy findings |
| POST | `/api/sessions/:id/findings/evaluate` | Đánh giá findings |
| POST | `/api/sessions/:id/rerun` | Chạy lại session |

---

## 🤖 Workflows — Cách dùng với AI Agent

Extension Hub có 2 workflows quan trọng nằm trong `.agents/workflows/`:

### Workflow 1: Antigravity Hub Contract

📄 **File:** `.agents/workflows/antigravity-hub-contract.md`

**Mục đích:** Quy tắc bắt buộc khi Antigravity (hoặc bất kỳ AI agent nào) tương tác với Hub server.

**Khi nào dùng:** Mỗi khi agent cần tạo session, poll kết quả, hoặc fetch findings.

**Luật quan trọng:**

1. **Luôn dùng `displayState`** (không phải chỉ `state`) để xác định trạng thái
2. **Kiểm tra `watchdog.stalled`** — nếu stalled thì DỪNG NGAY, không chờ tiếp
3. **Chỉ fetch findings sau `state == "completed"`**
4. **Không dùng `exit` trong inline PowerShell** — dùng `break` + `$result`

**Bảng quyết định trạng thái:**

| Trạng thái | Hành động |
|------------|-----------|
| `displayState = completed` | ✅ Lấy findings |
| `displayState = stalled` | 🛑 Dừng, báo lỗi |
| `state = failed` | 🛑 Dừng, báo lỗi |
| `state = running` + không stalled | ⏳ Tiếp tục poll |

**Safe polling pattern:**

```powershell
$result = 'poll_timeout'
for ($i = 1; $i -le 60; $i++) {
    $status = Invoke-RestMethod -Uri "http://localhost:3849/api/sessions/$sessionId" -Method GET
    $state = $status.session.state
    $displayState = if ($status.session.displayState) { $status.session.displayState } else { $state }

    # Kiểm tra stalled
    $stalled = $false
    if ($status.watchdog -and $status.watchdog.stalled) { $stalled = $true }

    if ($stalled -or $displayState -eq 'stalled') { $result = 'reviewer_stalled'; break }
    if ($state -eq 'failed' -or $state -eq 'cancelled') { $result = "terminal:$state"; break }
    if ($state -eq 'completed') { $result = 'completed'; break }

    Start-Sleep -Seconds 3
}
# Sau loop: kiểm tra $result
```

---

### Workflow 2: Codex Review-Debug Loop

📄 **File:** `.agents/workflows/codex-review-loop.md`

**Mục đích:** Cho Codex (GPT) review code, Antigravity (Gemini) đánh giá + phản biện, fix bug, test, lặp lại tối đa 5 rounds.

**Khi nào dùng:** Gõ `/codex-review-loop` trong Antigravity.

**Quy trình:**

```
┌─────────────────────────────────────────┐
│  Giai đoạn 0: Kiểm tra Hub server      │
│  extension-hub (hoặc node src/server.js)│
└───────────────┬─────────────────────────┘
                ▼
┌─────────────────────────────────────────┐
│  Giai đoạn 1: Xác định file cần review │
└───────────────┬─────────────────────────┘
                ▼
┌─────────────────────────────────────────────┐
│  Giai đoạn 2: Review Loop (tối đa 5 rounds)│
│                                             │
│  2.1  Tạo session (POST /api/sessions)      │
│  2.2  Poll kết quả (theo Hub Contract)      │
│  2.3  ⚠️ Antigravity phản biện findings     │
│  2.4  Gửi evaluations (agree/disagree)      │
│  2.5  Fix confirmed bugs                    │
│  2.6  Chạy tests                            │
│  2.7  Rerun nếu cần (POST /rerun)           │
│  2.8  Đánh giá: tiếp tục hay dừng?          │
└───────────────┬─────────────────────────────┘
                ▼
┌─────────────────────────────────────────┐
│  Giai đoạn 3: Tổng kết + Dọn sessions  │
└─────────────────────────────────────────┘
```

**Tạo session review:**

```powershell
$body = @{
    projectDir = "d:/extension"
    prompt = "Review this code for bugs and issues"
    agentId = "mcp-codex"
    label = "Review server.js Round 1"
    reviewOptions = @{
        review_target = "file"
        file_path = "src/server.js"
        max_findings = 15
    }
} | ConvertTo-Json -Depth 3

$r = Invoke-RestMethod -Uri "http://localhost:3849/api/sessions" `
    -Method POST -ContentType "application/json" -Body $body
$sessionId = $r.session.id
```

**Gửi đánh giá findings:**

```powershell
$evaluations = @{
    evaluations = @(
        @{ findingId = "F-XXXXX"; verdict = "agree"; reason = "Valid bug"; action = "fix" }
        @{ findingId = "F-YYYYY"; verdict = "disagree"; reason = "False positive"; action = "skip" }
    )
} | ConvertTo-Json -Depth 3

Invoke-RestMethod -Uri "http://localhost:3849/api/sessions/$sessionId/findings/evaluate" `
    -Method POST -ContentType "application/json" -Body $evaluations
```

**Rerun session:**

```powershell
$rerunBody = @{ context = "Round 2: Re-review after fixes" } | ConvertTo-Json
$child = Invoke-RestMethod -Uri "http://localhost:3849/api/sessions/$sessionId/rerun" `
    -Method POST -ContentType "application/json" -Body $rerunBody
$sessionId = $child.childSessionId  # session mới cho round tiếp
```

**Phản biện (devil's advocate) — NGUYÊN TẮC QUAN TRỌNG:**

> Antigravity **BẮT BUỘC** phản biện mọi finding:
> 1. Đọc code tại dòng Codex chỉ ra
> 2. Tìm lý do ĐỂ BÁC BỎ — có phải false positive?
> 3. Tìm được lý do → disagree
> 4. Không tìm được → agree + fix

---

## 🤝 Agent-to-Agent Collaboration

Extension Hub hỗ trợ **agent-to-agent collaboration** — Codex và Antigravity phối hợp qua turn-based protocol.

### Collaboration State (`collabState`)

Mỗi session có một `collabState` mô tả tiến trình hợp tác:

| State | Ý nghĩa |
|-------|---------|
| `draft` | Session mới, chưa gán agent |
| `awaiting_assignment` | Đang chờ gán reviewer/responder |
| `awaiting_codex_turn` | Đến lượt Codex review |
| `codex_reviewing` | Codex đang review (đã claim turn) |
| `awaiting_antigravity_turn` | Đến lượt Antigravity phản biện |
| `antigravity_reviewing` | Antigravity đang phản biện (đã claim turn) |
| `awaiting_resolution` | Chờ quyết định cuối cùng |
| `resolved` | Đã giải quyết |
| `closed` | Đã đóng |

### Turn Ownership

- Agent phải **claim turn** trước khi gửi message quan trọng (review_summary, finding_reply, decision, ...)
- Turn có TTL (mặc định 10 phút) — hết hạn sẽ tự expire
- Raw turn token **không hiển thị** trên dashboard — chỉ hiển thị owner và status

### Assignments

| Role | Mặc định | Chức năng |
|------|----------|-----------|
| `reviewer` | Codex | Review code, báo findings |
| `responder` | Antigravity | Phản biện, đánh giá findings |
| `decider` | Antigravity | Quyết định resolve/close |

### Collaboration API

| Method | Endpoint | Mô tả |
|--------|----------|-------|
| POST | `/api/sessions/:id/assignments` | Gán agent vào role |
| POST | `/api/sessions/:id/claim-turn` | Claim turn |
| POST | `/api/sessions/:id/messages` | Gửi message |
| GET | `/api/sessions/:id/messages` | Lấy danh sách messages |
| POST | `/api/sessions/:id/advance` | Advance collab state |

### Ví dụ flow end-to-end

```
1. Tạo review session              → collabState: awaiting_codex_turn
2. Codex claim turn                 → collabState: codex_reviewing
3. Codex post review_summary        
4. Codex advance (review_complete)  → collabState: awaiting_antigravity_turn
5. Antigravity claim turn           → collabState: antigravity_reviewing
6. Antigravity post finding_reply   
7. Antigravity advance (resolve)    → collabState: resolved
```

---

## ⚠️ Lưu Ý Quan Trọng (Gotchas)

| # | Gotcha | Giải pháp |
|---|--------|-----------|
| 1 | **PowerShell `exit` trong inline code** giết cả terminal | Dùng `break` + `$result`, chỉ `exit` trong file `.ps1` |
| 2 | **Codex output đi qua stderr** (không phải stdout) | Check `combinedBytes`, không chỉ `stdoutBytes` |
| 3 | **`path.join + startsWith`** bị trick bởi sibling dirs | Dùng `startsWith(dir + path.sep)` |
| 4 | **`http.Server.listen()`** không có host → bind `0.0.0.0` | Luôn specify `'127.0.0.1'` |
| 5 | **`removeAllListeners('error')`** xóa TẤT CẢ error handlers | Dùng `removeListener(fn)` với named function |
| 6 | **`existsSync`** trả true cho directories | Luôn check `statSync().isFile()` |
| 7 | **Codex MCP adapter có thể stall** | Hub watchdog detect qua `idleMs > 45s`. Fix: restart Hub |
| 8 | **`ConvertTo-Json`** truncates nested objects | Dùng `-Depth 3+` cho complex bodies |
| 9 | **Python/MCP là optional** | Core Hub chỉ cần Node.js. Python chỉ cho MCP Codex adapter |

---

## 📁 Cấu Trúc Project

```
extension-hub/
├── bin/extension-hub.js          # CLI entry point (global command)
├── src/
│   ├── server.js                 # HTTP + WebSocket server
│   ├── api-routes.js             # REST API handlers
│   ├── ws-handler.js             # WebSocket handler
│   ├── rebuttal-routes.js        # Evaluate/rerun endpoints
│   ├── adapters/                 # Agent adapters (Codex, generic)
│   ├── hub/                      # Session, EventStore, merge logic
│   ├── schema/                   # Event schema, validation
│   ├── snapshot/                 # Git worktree snapshots
│   ├── mcp/                      # Python MCP bridge scripts
│   ├── ui/                       # Dashboard (single HTML file)
│   └── utils/                    # Path utils, similarity
├── .agents/workflows/            # AI agent workflows
│   ├── codex-review-loop.md      # Review-debug loop
│   └── antigravity-hub-contract.md # Hub interaction rules
├── package.json                  # npm config (v1.0.0)
└── README.md                     # Quick start
```

---

## 🧪 Development

```bash
npm test              # Chạy unit tests
npm run e2e           # End-to-end tests
npm run pack:smoke    # Verify tarball contents
npm start             # Chạy từ source (dev mode)
```
