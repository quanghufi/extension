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
- [ ] Active finding line: severity-tinted background (critical=red, high=orange, medium=yellow, low=blue)
- [ ] Display: ≤100KB files load fully, scroll centered on finding line; >100KB show ±15 lines window
- [ ] "Open in VS Code" button (sử dụng `vscode://file/` protocol)
- [ ] Multiple findings in same file → gutter markers for non-active (within visible window), full highlight for active
- [ ] Truncated files: show "N more findings outside view" indicator for off-screen findings
- [ ] Same-line collision: highest severity wins for line color, stacked badge count shown
- [ ] File path breadcrumb ở top (`src/server.js:42`)
- [ ] Finding detail panel below code (severity, summary, evidence, agent) — all escaped
- [ ] Close button to dismiss code panel + Escape key support
- [ ] Findings with file but no line: open file at top, no line highlight, show "No line provided"

### Non-Functional
- [ ] Syntax highlighting: basic (keyword + string + comment đủ cho review)
- [ ] Language detection by extension, plain-text fallback for unknown types
- [ ] Lightweight: NO heavy deps (no Monaco, no CodeMirror)
- [ ] File loading: fetch from server API, cache in memory
- [ ] Smooth slide-in animation (CSS transition)
- [ ] Max file size: ≤100KB → full load, 100-500KB → load with truncation warning, >500KB → reject (413)
- [ ] Binary file detection: reject non-text files with friendly message
- [ ] XSS safety: ALL displayed strings (code, findings, breadcrumbs, tooltips, paths) via escaped text nodes, NEVER raw innerHTML

## Implementation Steps

1. [ ] Add file API endpoint to server (session-scoped)
   - `GET /api/sessions/:id/files?path=src/server.js&line=42&context=15`
   - Resolve snapshot path from session server-side (never expose snapshotId to client)
   - Read from snapshot directory (immutable, safe)
   - Full response: `{ path, content, lines, size, encoding, isBinary, workspacePath }`
   - Truncated response (100-500KB): add `{ truncated, startLine, endLine, totalLines }`
   - `workspacePath`: original project root + relative path (for IDE links)
   - `line` param: optional positive integer (>=1), centers content window; required for truncated files; 400 for invalid values
   - Out-of-range `line` (beyond EOF): clamp to last line, report effective line in response
   - `context` param: optional, default 15, max 50. Must be positive integer, 400 for invalid values
   - Missing `line` for full files: return from top; missing `line` for truncated files: 400
   - Security: validate path is within snapshot dir (no traversal)
   - Encoding: read as UTF-8 explicitly, detect binary via file extension + null-byte/control-byte heuristic, handle BOM

2. [ ] Implement lightweight syntax highlighter (`src/ui/code-viewer.js`)
   - Token-based regex highlighter for JS/TS (primary)
   - Language detection by file extension (`.js`/`.ts` → JS mode, others → plain text)
   - Categories: keyword, string, comment, number, operator
   - Apply CSS classes: `.token-keyword`, `.token-string`, etc.
   - Render as `<pre><code>` with line numbers
   - ⚠️ XSS: build tokens via DOM text nodes or HTML-escape BEFORE wrapping in spans
   - NEVER use innerHTML for code content — use textContent or createTextNode

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
   - Stale-response protection: track request ID, ignore responses from superseded clicks
   - Error state: on non-2xx response, clear previous code, show error message (404/413/415/generic)
   - Keep panel open on error — show contextual message, not silent failure

5. [ ] Handle multiple findings in same file
   - When switching findings in same file → no re-fetch if full file cached
   - Cache key: `sessionId + normalized path` (disable cache reuse for truncated responses)
   - All findings in visible range get mini-markers in gutter
   - Active finding gets full severity-colored highlight, others get subtle gutter markers
   - Same line: highest severity background, badge shows count of findings on line

6. [ ] Add "Open in IDE" integration
   - Default: `vscode://file/{workspacePath}:{line}:{column}` URI
   - Dropdown option: `cursor://file/{workspacePath}:{line}:{column}`
   - Column: default to 1 when finding has line but no column; omit `:line:column` when line is null
   - ⚠️ workspacePath = session.projectDir + relative path (NOT snapshot path)
   - URI construction: use URL helper, percent-encode special chars (#, %, ?, spaces)
   - Windows drive letters: normalize to forward slashes in URI
   - Button only shown if finding has valid file (line optional — omit `:line` if null)
   - Show resolved path in tooltip before launch

7. [ ] Path traversal protection (Windows-safe)
   - `GET /api/sessions/:id/files?path=../../etc/passwd` → 403 Forbidden
   - Normalize input: convert `\` to `/` before validation (Windows compatibility)
   - Reject absolute paths (starts with `/` or contains `:`)
   - Validation order: normalize → build candidate path → check existence (catch ENOENT → 404) → realpathSync → containment check
   - Verify containment: `rel = path.relative(rootReal, fileReal)` must satisfy `!path.isAbsolute(rel) && !rel.startsWith('..')`
   - Test cases: Windows drive letters (cross-drive = 403), mixed separators, URL-encoded traversal, symlinks, missing file

8. [ ] Write tests
   - File API: valid path → content with encoding metadata
   - File API: traversal attempt → 403 (test `..`, backslash, absolute, URL-encoded)
   - File API: Windows-style `src\server.js` → normalizes and serves correctly
   - File API: nonexistent file → 404
   - File API: file >500KB → 413 reject
   - File API: file 100-500KB with `line` param → 200 with truncation metadata + correct window
   - File API: binary file → 415 reject with message
   - File API: invalid session → 404
   - File API: cross-session isolation → session A cannot read session B's files
   - Syntax highlighter: keywords → correct tokens
   - Syntax highlighter: `<script>` content renders as escaped text (XSS test)
   - Syntax highlighter: .json file → plain text fallback
   - Finding detail: `<img onerror=...>` in summary/evidence → escaped (XSS test)
   - Code viewer panel: renders with line numbers
   - Rapid click: stale response ignored, latest selection wins
   - Editor URI: paths with spaces/# → correctly encoded
   - Close button: dismisses panel, resets state
   - Escape key: dismisses panel only when viewer open
   - Same-line collision: highest severity color + correct badge count
   - Finding with file but no line: opens file at top, no highlight

## Files to Create/Modify

- `src/ui/index.html` — MODIFY: add code viewer panel markup
- `src/ui/code-viewer.js` — NEW: lightweight syntax highlighter + viewer logic (XSS-safe)
- `src/server.js` — MODIFY: add `/api/sessions/:id/files` route
- `src/api-routes.js` — MODIFY: add `apiGetFile` handler with session-scoped path resolution
- `src/server.test.js` — MODIFY: add file API tests (traversal, encoding, binary, session scope)

## Test Criteria

- [ ] Click finding → code panel opens with correct file
- [ ] Active finding line highlighted with correct severity color
- [ ] Non-active findings show gutter markers only
- [ ] Same-line collision: highest severity wins
- [ ] Line numbers render correctly
- [ ] ≤100KB files: full content loaded, scrolled to finding
- [ ] 100-500KB files: windowed content with truncation metadata
- [ ] Truncated files: off-screen findings show count indicator
- [ ] Multiple findings in same file → visible ones marked
- [ ] Path traversal → 403 blocked (incl. Windows edge cases)
- [ ] File not found → 404 (not 500)
- [ ] Large file (>500KB) → 413 rejected
- [ ] Binary file → 415 rejected with friendly message
- [ ] "Open in VS Code" / "Open in Cursor" generates correct URI per selection
- [ ] Finding with no line → opens file at top, no line highlight
- [ ] `<script>` tags in code content render as escaped text
- [ ] Malicious path in breadcrumb → escaped (XSS test)
- [ ] Syntax highlighting: JS keywords colored correctly
- [ ] Unknown file type → plain text fallback (no errors)
- [ ] Panel close button + Escape key both dismiss panel
- [ ] Rapid finding clicks → last selection wins
- [ ] Invalid/deleted session → 404
- [ ] Invalid line/context params → 400
- [ ] Existing tests still pass

## Notes

- **Why not Monaco/CodeMirror?** Overkill for read-only viewing. They add 300KB+.
  Custom highlighter is ~100 lines, covers 80% of needs.
- Code viewer lives in `src/ui/code-viewer.js`, loaded via `<script src="/ui/code-viewer.js">`
- `index.html` only contains panel markup; all JS logic in `code-viewer.js`
- Future: could add diff view (showing what agent suggests changing)
- Session 1: file API + highlighter + basic panel
  Session 2: multi-finding marks + VS Code link + polish

---
Next Phase: [Phase 05 — Resilient Sessions](./phase-05-resilient-sessions.md)
