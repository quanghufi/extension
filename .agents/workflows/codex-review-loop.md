---
description: 🔄 Codex Review-Debug Loop (5 rounds tự động)
---

# Codex Review-Debug Loop

**2 AI review:** Codex (GPT) review → Antigravity (Gemini) đánh giá + phản biện → fix → test → lặp lại tối đa 5 rounds.

**Sử dụng Hub server API** (`http://localhost:3849`) — evaluate + rerun chain.

Before running this loop, Antigravity should follow:
`./.agents/workflows/antigravity-hub-contract.md`

// turbo-all

## Giai đoạn 0: Kiểm tra Hub server

```powershell
Invoke-RestMethod -Uri "http://localhost:3849/api/sessions" -Method GET
```

Nếu Hub server chưa chạy → khởi động:
```powershell
node src/server.js
```

## Giai đoạn 1: Xác định target

1. Hỏi user file nào cần review (hoặc dùng file đang mở)
2. Xác nhận test command (auto-detect)

## Giai đoạn 2: Review Loop (tối đa 5 rounds)

### Step 2.1: Tạo session (Round 1)

```powershell
$body = @{
    projectDir = "d:/extension"
    prompt = "Review this code for bugs and issues"
    agentId = "mcp-codex"
    label = "Review {FILE_NAME} Round 1"
    reviewOptions = @{
        review_target = "file"
        file_path = "{RELATIVE_FILE_PATH}"
        max_findings = 15
    }
} | ConvertTo-Json -Depth 3

$r = Invoke-RestMethod -Uri "http://localhost:3849/api/sessions" -Method POST -ContentType "application/json" -Body $body
$sessionId = $r.session.id
```

### Step 2.2: Wait for result and fetch findings safely

Do not poll only on `session.state == running`.
Use `session.displayState` and `watchdog.stalled` from:
`./.agents/workflows/antigravity-hub-contract.md`

Only fetch findings after `session.state == "completed"`.
If the review becomes `stalled`, stop polling and treat it as a runtime issue.

### Step 2.3: ⚠️ Đánh Giá + Tranh Luận (BẮT BUỘC)

**KHÔNG FIX MÙ QUÁNG.**

Antigravity **BẮT BUỘC phản biện** mọi finding vì chỉ có 1 reviewer:
1. Đọc code tại dòng Codex chỉ ra
2. **Tìm lý do ĐỂ BÁC BỎ** bug — kiểm tra xem có thể là false positive không
3. Nếu tìm được lý do phản bác → tranh luận
4. Nếu không tìm được lý do phản bác → đồng ý fix

> Mục đích: Antigravity đóng vai "devil's advocate" để đảm bảo chỉ fix bug thật.

### Step 2.4: Gửi evaluations về Hub

```powershell
$evaluations = @{
    evaluations = @(
        @{ findingId = "F-XXXXX"; verdict = "agree"; reason = "Valid bug"; action = "fix" }
        @{ findingId = "F-YYYYY"; verdict = "disagree"; reason = "False positive because..."; action = "skip" }
    )
} | ConvertTo-Json -Depth 3

Invoke-RestMethod -Uri "http://localhost:3849/api/sessions/$sessionId/findings/evaluate" -Method POST -ContentType "application/json" -Body $evaluations
```

### Step 2.5: Fix confirmed bugs
- Chỉ fix bugs verdict = "agree"

### Step 2.6: Chạy tests
```powershell
node --test src/hub/session.test.js
```

### Step 2.7: Rerun (tạo child session cho round tiếp)

Nếu round < 5 và có findings bị reject cần re-check:

```powershell
$rerunBody = @{ context = "Round {N+1}: Re-review after fixes" } | ConvertTo-Json
$child = Invoke-RestMethod -Uri "http://localhost:3849/api/sessions/$sessionId/rerun" -Method POST -ContentType "application/json" -Body $rerunBody
$sessionId = $child.childSessionId  # Update sessionId cho round tiếp
```

Quay lại Step 2.2 với session mới.

### Step 2.8: Đánh giá
- round < 5 và còn bugs → quay lại Step 2.2
- clean hoặc round = 5 → bước 3


## Giai đoạn 3: Tổng kết

Báo cáo: rounds, bugs found/fixed/rejected, nguồn (Codex).

### Step 3.1: 🧹 Dọn dẹp sessions

Sau khi tổng kết, xóa toàn bộ session chain (bao gồm cả session stalled nếu có):

```powershell
# Xóa tất cả session IDs đã tạo trong loop (bao gồm stalled + review chain)
$allSessionIds = @("{SESSION_ID_R1}", "{SESSION_ID_R2}", ...)  # Tất cả IDs đã thu thập
foreach ($id in $allSessionIds) {
    try {
        Invoke-RestMethod -Uri "http://localhost:3849/api/sessions/$id" -Method DELETE
        Write-Host "Deleted: $($id.Substring(0,8))..."
    } catch { Write-Host "Skip: $($id.Substring(0,8))..." }
}
```

> **Lưu ý:** Thu thập tất cả session IDs (cả stalled, failed) trong quá trình chạy loop để xóa sạch ở bước này.

## NEXT STEPS menu
```
1. /run    → Chạy thử
2. /test   → Chạy test
3. /deploy → Deploy
4. /next   → Gợi ý tiếp
```
