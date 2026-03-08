---
description: 🔪 Tự động tách file khi vượt ngưỡng kích thước — giữ codebase gọn gàng, dễ review
---
// turbo-all

# File Splitting Rules

## Khi nào rule này kích hoạt?

Rule này **PHẢI** được kiểm tra tự động mỗi khi:
1. **Tạo file mới** — trước khi commit
2. **Sửa file có sẵn** — sau khi hoàn thành thay đổi
3. **Code review** — khi review code của agent khác
4. Bất kỳ lúc nào agent nhận thấy file đang phình to

---

## Ngưỡng (Thresholds)

| Metric | ⚠️ Warning | 🔴 Must Split | Áp dụng cho |
|--------|-----------|---------------|-------------|
| **Lines of Code** | > 200 lines | > 300 lines | `.js`, `.ts`, `.mjs` |
| **Lines of Code (Test)** | > 250 lines | > 400 lines | `*.test.js`, `*.spec.js` |
| **Lines of Code (HTML)** | > 400 lines | > 600 lines | `.html` |
| **File Size** | > 10 KB | > 15 KB | Tất cả source files |
| **Functions/Methods** | > 8 per file | > 12 per file | Logic files |
| **Exports** | > 6 per file | > 10 per file | Module files |

### Ngoại lệ (Exemptions)
- `node_modules/`, `package-lock.json`, `*.min.js` — bỏ qua hoàn toàn
- `*.json` config files — chỉ check khi > 50 KB
- Generated files (ghi chú `// @generated`) — bỏ qua

---

## Chiến lược tách file

### Strategy 1: Tách theo Concern (ưu tiên cao nhất)

Khi một file chứa **nhiều responsibility** khác nhau:

```
❌ TRƯỚC: server.js (328 lines)
  - HTTP route handlers
  - WebSocket logic
  - Middleware
  - Utility helpers

✅ SAU:
  server.js           — HTTP server setup + route mounting (~80 lines)
  routes/sessions.js   — Session CRUD routes (~80 lines)
  routes/files.js      — File content API routes (~60 lines)
  ws/handler.js        — WebSocket connection + subscription (~80 lines)
  middleware/index.js   — CORS, error handler, etc. (~40 lines)
```

### Strategy 2: Tách theo Layer (cho module lớn)

```
❌ TRƯỚC: session.js (300 lines)
  - Session class definition
  - Event processing logic
  - Finalization / cleanup
  - State machine transitions

✅ SAU:
  session.js            — Session class, constructor, public API (~100 lines)
  session-events.js     — Event processing logic (~100 lines)
  session-lifecycle.js  — State transitions, finalize, cleanup (~100 lines)
```

### Strategy 3: Tách Test Suites

```
❌ TRƯỚC: base-adapter.test.js (186 lines, 15 test cases)

✅ SAU:
  __tests__/base-adapter/
    construction.test.js   — Constructor + config tests
    execution.test.js      — execute() flow tests
    timeout.test.js        — Timeout strategy tests
    error-handling.test.js — Error + edge case tests
```

### Strategy 4: Extract Constants/Types

Khi file có nhiều JSDoc types hoặc constants:

```
❌ TRƯỚC: events.js (160 lines)
  - 40 lines JSDoc type definitions
  - 20 lines constants
  - 100 lines logic

✅ SAU:
  events.types.js    — JSDoc typedefs + constants (~60 lines)
  events.js          — Logic only, imports types (~100 lines)
```

---

## Quy trình tách file (Step-by-step)

### Bước 1: Đánh giá

```markdown
## File Split Assessment
- **File:** `src/example.js`
- **Current:** 350 lines, 16 KB
- **Threshold:** 🔴 Must Split (>300 lines AND >15 KB)
- **Concerns identified:** [list distinct responsibilities]
- **Strategy:** [Strategy 1/2/3/4]
```

### Bước 2: Lên kế hoạch tách

Liệt kê rõ:
- File mới nào sẽ được tạo
- Mỗi file chứa gì (functions/classes nào)
- Import/export sẽ thay đổi thế nào
- Backward compatibility: các file khác import file gốc có bị ảnh hưởng không?

### Bước 3: Thực hiện tách

1. **Tạo file mới** với nội dung extracted
2. **Update file gốc** — re-export từ file mới (nếu cần backward compat)
3. **Update imports** trong toàn bộ codebase
4. **Chạy tests** — `node --test src/**/*.test.js` — phải 100% pass
5. **Verify** — không có circular imports

### Bước 4: Commit

```
refactor(module): split file-name.js into concern-based modules

- Extract [concern A] to new-file-a.js
- Extract [concern B] to new-file-b.js
- Original file now serves as orchestrator/barrel
- All 172 tests still pass
```

---

## Naming Conventions khi tách

| Pattern | Khi nào dùng | Ví dụ |
|---------|-------------|-------|
| `{name}-{concern}.js` | Tách theo concern | `session-events.js`, `session-lifecycle.js` |
| `{name}.types.js` | Extract types/constants | `events.types.js` |
| `{folder}/{name}.js` | Tách thành module folder | `routes/sessions.js` |
| `__tests__/{name}/` | Tách test suites | `__tests__/adapter/timeout.test.js` |

---

## Kiểm tra nhanh sau khi tách

```bash
# 1. Tất cả tests vẫn pass
node --test src/**/*.test.js

# 2. Không file nào vượt ngưỡng
# (Agent tự kiểm tra bằng cách đếm lines)

# 3. Không circular imports
node -e "import('./src/server.js')"
```

---

## Ví dụ thực tế — Project hiện tại

### Các file cần theo dõi (gần ngưỡng ⚠️):

| File | Lines | KB | Status |
|------|-------|----|--------|
| `base-adapter.js` | 339 | 15.1 | 🔴 **Must Split** |
| `server.js` | 328 | 12.8 | 🔴 **Must Split** |
| `session.js` | 300 | 12.9 | ⚠️ **Warning** (đúng threshold) |
| `snapshot-manager.js` | 264 | 10.4 | ⚠️ **Warning** |
| `claude-adapter.js` | 255 | 10.8 | ⚠️ **Warning** |
| `claude-adapter.test.js` | 238 | 10.5 | ✅ OK (test threshold = 250) |

### Recommended splits (khi bắt đầu Phase 2):

1. **`base-adapter.js`** → `base-adapter.js` + `adapter-execution.js` + `adapter-timeout.js`
2. **`server.js`** → `server.js` + `routes/sessions.js` + `ws/handler.js`

---

## CRITICAL RULES — Agent PHẢI tuân thủ

1. **KHÔNG BAO GIỜ** tạo file mới > 300 lines. Nếu logic cần > 300 lines → tách TRƯỚC khi viết.
2. **KHÔNG BAO GIỜ** thêm code vào file đã ở mức ⚠️ Warning mà không kiểm tra lại tổng lines.
3. **LUÔN LUÔN** re-export từ file gốc khi tách để giữ backward compatibility.
4. **LUÔN LUÔN** chạy full test suite sau khi tách.
5. **LUÔN LUÔN** ghi commit message theo format `refactor(scope): split ...`.
6. Khi nhận lệnh `/code` hoặc viết code mới → **kiểm tra file target trước**, nếu gần ngưỡng → tách trước, code sau.
