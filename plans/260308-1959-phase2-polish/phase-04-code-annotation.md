# Phase 04: Code Annotation Viewer

Status: ⬜ Pending
Dependencies: Phase 02 (findings data), Phase 03 (UI framework)
Est: 2 sessions

## Objective

Click finding → mở code viewer hiển thị source file với highlighted line.
Trọng tâm: **read-only viewer** (không phải editor), chạy inside dashboard browser.

## Hiện trạng (Phase 1)

- Findings có `file` và `line` fields nhưng chỉ hiển thị text
- Không thể xem actual code context
- Phải mở IDE riêng, navigate đến file/line thủ công

## Requirements

### Functional
- [ ] Click finding row → slide-in code panel (right side)
- [ ] Code viewer hiển thị file content với syntax highlighting
- [ ] Finding line highlighted (yellow background)
- [ ] Context: hiển thị ±15 lines quanh finding line
- [ ] "Open in VS Code" button (sử dụng `vscode://file/` protocol)
- [ ] Multiple findings in same file → all highlighted (different colors per severity)
- [ ] File path breadcrumb ở top (`src/server.js:42`)
- [ ] Finding detail panel below code (severity, summary, evidence, agent)

### Non-Functional
- [ ] Syntax highlighting: basic (keyword + string + comment đủ cho review)
- [ ] Lightweight: NO heavy deps (no Monaco, no CodeMirror)
- [ ] File loading: fetch from server API, cache in memory
- [ ] Smooth slide-in animation (CSS transition)
- [ ] Max file size: warn nếu >100KB, skip nếu >500KB

## Implementation Steps

1. [ ] Add file API endpoint to server
   - `GET /api/files?path=src/server.js&snapshot=<snapshotId>`
   - Read from snapshot directory (immutable, safe)
   - Returns: `{ path, content, lines, size }`
   - Security: validate path is within snapshot dir (no traversal)

2. [ ] Implement lightweight syntax highlighter (`src/ui/code-viewer.js`)
   - Token-based regex highlighter for JS/TS
   - Categories: keyword, string, comment, number, operator
   - Apply CSS classes: `.token-keyword`, `.token-string`, etc.
   - Render as `<pre><code>` with line numbers

3. [ ] Build Code Viewer panel in `index.html`
   ```
   ┌─────────────────────────┬──────────────────────────┐
   │                         │ 📄 src/server.js:42      │
   │  Findings Table         │ ─────────────────────── │
   │  (merged or side-by-   │ 40│ function handle() {   │
   │   side view)           │ 41│   const data = req.b   │
   │                        │▶42│   if (!data) return;   │← highlighted
   │                        │ 43│   // process          │
   │                        │ 44│ }                     │
   │                        │ ─────────────────────── │
   │                        │ 🔴 HIGH: Missing null chk │
   │                        │ Agent: 🟢codex 🔵claude   │
   │                        │ [Open in VS Code]        │
   └─────────────────────────┴──────────────────────────┘
   ```

4. [ ] Wire click handler
   - Finding row click → fetch file from API
   - Render in code viewer panel
   - Scroll to finding line (centered)
   - Highlight finding line with severity color
   - If panel already open → update content (no close/reopen)

5. [ ] Handle multiple findings in same file
   - When switching findings in same file → no re-fetch (cache)
   - All findings in visible range get mini-markers in gutter
   - Active finding gets full highlight, others get subtle markers

6. [ ] Add "Open in VS Code" integration
   - Uses `vscode://file/{absolutePath}:{line}:{column}` URI
   - Button only shown if finding has valid file + line
   - Also support: `cursor://` protocol for Cursor IDE

7. [ ] Path traversal protection
   - `GET /api/files?path=../../etc/passwd` → 403 Forbidden
   - Validate: `resolved_path.startsWith(snapshot_dir)` 
   - Strip `..` segments before resolve

8. [ ] Write tests
   - File API: valid path → content
   - File API: traversal attempt → 403
   - File API: nonexistent file → 404
   - File API: oversized file → 413 with warning
   - Syntax highlighter: keywords → correct tokens
   - Code viewer panel: renders with line numbers

## Files to Create/Modify

- `src/ui/index.html` — MODIFY: add code viewer panel, click handlers
- `src/ui/code-viewer.js` — NEW: lightweight syntax highlighter (injected inline via build or `<script type="module">`)
- `src/server.js` — MODIFY: add `/api/files` endpoint
- `src/server.test.js` — MODIFY: add file API tests

## Test Criteria

- [ ] Click finding → code panel opens with correct file
- [ ] Finding line highlighted with correct severity color
- [ ] Line numbers render correctly
- [ ] ±15 lines context shown
- [ ] Multiple findings in same file → all marked
- [ ] Path traversal → 403 blocked
- [ ] File not found → 404 with message
- [ ] Large file (>100KB) → warning shown
- [ ] "Open in VS Code" generates correct URI
- [ ] Syntax highlighting: JS keywords colored correctly
- [ ] Panel close button works
- [ ] Existing tests still pass

## Notes

- **Why not Monaco/CodeMirror?** Overkill for read-only viewing. They add 300KB+.
  Custom highlighter is ~100 lines, covers 80% of needs.
- Keep code viewer as `<script>` inside `index.html` (single-file philosophy)
  OR inject via `<script src="/ui/code-viewer.js">` served by HubServer
- Future: could add diff view (showing what agent suggests changing)
- Session 1: file API + highlighter + basic panel
  Session 2: multi-finding marks + VS Code link + polish

---
Next Phase: [Phase 05 — Resilient Sessions](./phase-05-resilient-sessions.md)
