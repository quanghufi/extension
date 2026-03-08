# Phase 03: Side-by-Side Findings UI

Status: ⬜ Pending
Dependencies: Phase 02 (Smart Merge — needed for merged findings data)
Est: 1 session

## Objective

Nâng cấp dashboard UI để hiển thị findings theo 2 chế độ:
- **Merged View** (default): findings gộp với agent badges
- **Side-by-Side View**: findings chia cột theo agent, highlight trùng lặp

## Hiện trạng (Phase 1)

`src/ui/index.html` hiện có:
- Timeline: live event stream
- Findings table: single flat table, sorted by severity
- Agent status badges

**Missing:**
- Không thấy sự khác biệt giữa agents
- Không biết finding nào trùng, finding nào chỉ 1 agent phát hiện
- Không có filter theo agent

## Requirements

### Functional
- [ ] Toggle button: "Merged View" ↔ "Side-by-Side View"
- [ ] **Merged View:**
  - Grouped findings table with agent badges (🟢 codex, 🔵 claude)
  - Merged findings hiện icon 🔗 link
  - Expand row → xem original findings từ mỗi agent
- [ ] **Side-by-Side View:**
  - Split screen: Agent 1 | Agent 2 (2 columns)
  - Matched findings highlighted with connecting line/color
  - Unique findings (only 1 agent) shown with faded background
  - Severity disagreements shown with ⚠️ indicator
- [ ] Filter bar: filter by severity, agent, file, merge status
- [ ] Summary stats bar: Total, Merged, Unique per agent, Conflicts

### Non-Functional
- [ ] Responsive: works on 1280px+ screens
- [ ] Smooth toggle animation between views
- [ ] No external CSS framework (keep vanilla)
- [ ] Keyboard shortcuts: `M` = merged, `S` = side-by-side

## Implementation Steps

1. [ ] Design UI layout wireframe (both views)
   ```
   ┌───────────────────────────────────────────────┐
   │ [Merged ▼] [Side-by-Side]  │ Stats: 12 total │
   ├───────────────────────────────────────────────┤
   │ Filters: [Severity ▼] [Agent ▼] [File ▼]     │
   ├───────────────────────────────────────────────┤
   │                                               │
   │  MERGED VIEW:                                 │
   │  ┌─────────────────────────────────────────┐  │
   │  │ 🔴 HIGH │ Missing null check │ 🟢🔵    │  │
   │  │         │ src/server.js:42   │ 🔗merged │  │
   │  ├─────────────────────────────────────────┤  │
   │  │ 🟡 MED  │ Unused import     │ 🟢       │  │
   │  └─────────────────────────────────────────┘  │
   │                                               │
   │  SIDE-BY-SIDE VIEW:                           │
   │  ┌──────────────┬──────────────┐              │
   │  │  🟢 Codex    │  🔵 Claude   │              │
   │  ├──────────────┼──────────────┤              │
   │  │ 🔴 null chk  │ 🔴 null grd  │ ← matched  │
   │  │ 🟡 unused    │              │ ← unique   │
   │  │              │ 🟡 naming    │ ← unique   │
   │  └──────────────┴──────────────┘              │
   └───────────────────────────────────────────────┘
   ```

2. [ ] Add filter bar HTML/CSS to `index.html`
   - Severity dropdown (critical/high/medium/low/all)
   - Agent multi-select checkboxes
   - File path text filter
   - Merge status: all / merged only / unique only

3. [ ] Implement Merged View rendering
   - Fetch `mergedFindings` from API
   - Render table with agent badge chips
   - Collapsible row detail showing original per-agent findings
   - Color-coded severity

4. [ ] Implement Side-by-Side View rendering
   - 2-column grid layout
   - Color-code rows by match status (matched=green border, unique=grey bg)
   - Draw visual connection between matched findings (CSS border trick)
   - Show severity disagree icon ⚠️

5. [ ] Add toggle + keyboard shortcuts
   - Toggle button in header
   - `M` key → Merged, `S` key → Side-by-side
   - Animate transition (fade or slide)

6. [ ] Update summary stats bar
   - Calculate from merged findings data
   - Show: Total | Merged | Codex-only | Claude-only | Conflicts

7. [ ] Update WebSocket handler to receive merge data
   - On session finalized → receive `mergedFindings` + `rawFindings`
   - Re-render active view

## Files to Create/Modify

- `src/ui/index.html` — MODIFY: add filter bar, merged view, side-by-side view
- `src/server.js` — MODIFY: expose `mergedFindings` in session API response

## Test Criteria

- [ ] Toggle switches between views without reload
- [ ] Merged view shows correct agent badges
- [ ] Side-by-side correctly aligns matched findings
- [ ] Unique findings appear in correct column only
- [ ] Filters work in both views
- [ ] Stats bar updates with filter changes
- [ ] Keyboard shortcuts M/S work
- [ ] Responsive at 1280px width
- [ ] WebSocket reconnect refreshes findings correctly

## Notes

- Single-file `index.html` approach continues — use `<style>` and `<script>` inline
- Consider CSS Grid for side-by-side instead of flexbox (better alignment)
- Agent colors: derive from agent ID hash for consistency with N agents
- If >2 agents: side-by-side becomes multi-column (scrollable horizontally)

---
Next Phase: [Phase 04 — Code Annotation Viewer](./phase-04-code-annotation.md)
