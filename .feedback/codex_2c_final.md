# Codex Final — Phase 2C Scope Chốt Với Antigravity

**Date:** 2026-03-12  
**Source inputs:** `.feedback/codex_phase2c.md`, `.feedback/antigravity_answer.md`

---

## TL;DR

Sau khi đối chiếu đề xuất của Codex và phản hồi của Antigravity, scope cuối cùng cho **Phase 2C** được chốt như sau:

1. **Làm Workstream 1 trước:** cập nhật workflow/docs để phản ánh collaboration model của Phase 2A.
2. **UI chỉ làm phần P0:** hiển thị rõ `collabState`, assignment, turn, và timeline inspection tối giản.
3. **Không làm operator controls trong UI ở Phase 2C.**
4. **Không redesign backend lớn.** Chỉ enrich payload nếu UI thật sự bị block.
5. **Test ở mức integration + workflow verification**, không thêm UI test framework mới.

Đây là bản chốt để Antigravity implement. Nếu có mâu thuẫn với bản đề xuất trước, **bản này thắng**.

---

## 1. Mục tiêu chính của Phase 2C

Phase 2C không phải là phase “beautify UI” hay “mở full operator control”.

Mục tiêu đúng là:

1. **Workflow alignment** — docs/workflows phải khớp collaboration reality.
2. **Operator visibility** — người vận hành xem được session collaboration mà không phải đọc raw JSON.
3. **Basic observability** — có timeline đơn giản để hiểu session đã diễn ra gì.

---

## 2. Scope đã thống nhất

## 2.1 Bắt buộc làm trong Phase 2C

### A. Workflow alignment

Update các file sau:

1. `.agents/workflows/antigravity-hub-contract.md`
2. `.agents/workflows/codex-review-loop.md`
3. `docs/USER-GUIDE.md`

Yêu cầu thống nhất:

- **Extend, not rewrite.**
- Giữ flow legacy làm **Basic Mode / Compatibility Mode**.
- Thêm collaboration-first sections mô tả rõ:
  - `collabState`
  - turn ownership
  - assignments
  - shared messages
  - `hub_claim_turn`
  - `hub_post_message`
  - `hub_advance_session`

### B. Decision table và forbidden patterns

Trong workflow docs, phải thêm:

#### Decision table tối thiểu

| `collabState` | Actor chính | Hành động mong đợi |
|---|---|---|
| `awaiting_codex_turn` | Codex | claim turn, post summary/message, advance |
| `codex_reviewing` | Codex | tiếp tục review/post update nếu cần |
| `awaiting_antigravity_turn` | Antigravity | claim turn |
| `antigravity_reviewing` | Antigravity | post reply/decision, request next step |
| `awaiting_resolution` | Decider/Operator | resolve hoặc close |
| `resolved` | Operator | optional close |

#### Forbidden patterns bắt buộc ghi rõ

- Post turn-sensitive message khi chưa own turn.
- Advance state bằng stale token.
- Chỉ nhìn `session.state` mà bỏ qua `collabState`.
- Dùng `hub_evaluate_findings` như cơ chế collaboration chính khi message/turn flow đã available.

### C. UI P0 — chỉ phần cần thiết

Update `src/ui/index.html` để hiển thị rõ hơn session collaboration, nhưng **chỉ làm P0**:

1. **Session header**
   - hiển thị `collabState`
   - hiển thị trạng thái execution hiện tại
   - hiển thị session id/revision nếu đã có pattern sẵn

2. **Assignment panel**
   - agent nào đang được assign role gì
   - nếu chưa có assignment thì hiển thị rõ là chưa gán

3. **Turn panel**
   - current turn owner
   - token presence/status theo kiểu an toàn
   - last turn-related timestamps nếu đã có dữ liệu

4. **Findings panel**
   - giữ hoặc nâng nhẹ phần đang có
   - nhấn mạnh linkage giữa findings và session state nếu có thể làm nhẹ nhàng

### D. Replay/inspection tối giản

Thêm view/timeline đơn giản để trộn:

- events
- messages
- state/collabState transitions

Yêu cầu:

- chronological order
- actor label
- event/message type label
- marker cho `collabState` transitions

Mục tiêu là giúp operator trả lời được:

- chuyện gì đã xảy ra?
- ai đã làm gì?
- session đã advance/rerun/resolve vì sao?

### E. Test tối thiểu bắt buộc

Chỉ làm các test sau:

1. **Route/integration tests**
   - verify session detail response đủ field collaboration cho UI P0
   - verify messages/events/findings endpoints đủ để build inspection view

2. **Workflow verification test**
   - ít nhất 1 test hoặc scripted verification chứng minh flow:
     - claim turn
     - post message
     - advance session

---

## 2.2 Không làm trong Phase 2C

Các mục dưới đây **được chốt là out-of-scope**:

1. **Không làm operator controls trong UI**
   - không assign role từ UI
   - không claim turn từ UI
   - không post message từ UI
   - không advance/resolve/close từ UI

2. **Không làm message thread đầy đủ nếu nó kéo scope nặng**
   - nếu timeline đơn giản đã đủ thì ưu tiên timeline
   - message thread rich/full panel để Phase sau

3. **Không làm pending action panel riêng nếu chưa thật sự cần**

4. **Không làm step-by-step replay mode**

5. **Không thêm UI testing framework mới chỉ cho Phase 2C**

6. **Không redesign backend lớn hoặc thêm endpoint mới nếu existing APIs đã đủ**

---

## 3. Hướng dẫn implement cụ thể cho Antigravity

## 3.1 Read first

Đọc theo thứ tự này trước khi sửa:

1. `AGENTS.md`
2. `.feedback/codex_phase2c.md`
3. `.feedback/antigravity_answer.md`
4. `.agents/workflows/antigravity-hub-contract.md`
5. `.agents/workflows/codex-review-loop.md`
6. `docs/USER-GUIDE.md`
7. `src/session.js`
8. `src/collab-state-machine.js` nếu file này tồn tại
9. `src/api-routes.js`
10. `src/collab-routes.js`
11. `src/ws-handler.js`
12. `src/ui/index.html`

## 3.2 Code order

Implement theo đúng thứ tự này:

1. `.agents/workflows/antigravity-hub-contract.md`
2. `.agents/workflows/codex-review-loop.md`
3. `docs/USER-GUIDE.md`
4. `src/ui/index.html`
5. Backend payload enrichment nhỏ nếu UI thật sự thiếu dữ liệu
6. Tests

Lý do:

- workflow phải đúng trước thì UI mới không kể sai câu chuyện
- UI chỉ nên phản ánh model đã chốt
- backend chỉ bổ sung nếu UI thật sự bị block

---

## 4. Yêu cầu chi tiết theo file

## 4.1 `.agents/workflows/antigravity-hub-contract.md`

Phải có thêm section mới kiểu:

- `## Collaboration Mode`
- `## Decision Table`
- `## Forbidden Patterns`

Phải nêu rõ:

- luôn gọi `hub_get_status` trước khi hành động trên session
- ưu tiên `collabState` hơn cách suy luận từ execution state
- phải check turn trước khi gửi turn-sensitive collaboration message
- `hub_claim_turn` + `hub_post_message` + `hub_advance_session` là protocol chính của collab mode
- `hub_get_findings`, `hub_evaluate_findings`, `hub_rerun_review` vẫn tồn tại như compatibility path

## 4.2 `.agents/workflows/codex-review-loop.md`

Không xóa flow cũ hoàn toàn.

Phải thêm section kiểu:

- `## Collaboration-Enhanced Flow`

Flow nên thể hiện rõ ít nhất các bước:

1. check session/status
2. inspect `collabState`
3. claim turn khi cần
4. run/review work phù hợp với phase hiện tại
5. post summary/message
6. advance session bằng action phù hợp

Phải nói rõ:

- legacy evaluate/rerun flow vẫn hợp lệ ở compatibility mode
- collab-first flow là path ưu tiên cho shared-thread collaboration

## 4.3 `docs/USER-GUIDE.md`

Thêm section collaboration ngắn gọn, dễ đọc cho operator:

- `collabState` là gì
- turn ownership là gì
- assignments dùng để làm gì
- khi nào nhìn messages, findings, events
- session inspection UI giúp đọc session như thế nào

Không biến file này thành spec kỹ thuật quá dài.

## 4.4 `src/ui/index.html`

Chỉ làm read-only inspection improvements.

UI phải cho operator nhìn được nhanh:

- session đang ở `collabState` nào
- ai đang giữ turn
- ai đang được assign role nào
- có findings/messages/events gì liên quan gần đây

Yêu cầu UX:

- không lộ raw turn token theo kiểu copy-paste khuyến khích thao tác tay
- không render button/action gây hiểu lầm rằng UI có quyền mutate session
- nếu thiếu data thì hiển thị trạng thái empty rõ ràng, không mơ hồ

## 4.5 `src/api-routes.js` / `src/collab-routes.js` / `src/ws-handler.js`

Chỉ sửa khi thật sự cần để support UI P0/timeline.

Ưu tiên:

- reuse existing endpoints
- enrich payload nhỏ, không đổi kiến trúc
- đảm bảo ws/live update không làm UI kể sai state

Nếu existing APIs đã đủ thì **không cần sửa backend**.

---

## 5. Definition of Done

Phase 2C hoàn tất khi:

1. Workflow docs phản ánh đúng collaboration model của Phase 2A.
2. Legacy flow vẫn còn, nhưng được đóng khung là compatibility/basic mode.
3. UI session detail hiển thị rõ `collabState`, assignments, turn info.
4. Có inspection timeline đơn giản cho events + messages + transitions.
5. Operator có thể hiểu session mà không cần đọc raw JSON.
6. Không có operator controls trong UI.
7. Không có backend redesign ngoài payload enrichment nhỏ nếu cần.
8. Có test integration/workflow verification cho phần đã build.

---

## 6. Stop conditions

Antigravity phải dừng và re-evaluate nếu gặp một trong các dấu hiệu sau:

1. Workflow edit bắt đầu thay hẳn legacy mode thay vì extend.
2. UI bắt đầu thêm action buttons để mutate session.
3. UI lộ raw turn token theo cách không an toàn.
4. Scope trượt sang full message thread/pending action/operator console.
5. Cần thêm backend endpoint lớn chỉ để phục vụ một phần UI nhỏ.

---

## 7. Final instruction to Antigravity

Hãy implement **Phase 2C bản gọn và sắc**:

- **docs/workflows trước**
- **UI P0 read-only sau**
- **timeline đơn giản, hữu ích**
- **test vừa đủ để chứng minh flow**

Đừng biến 2C thành 2D hay Phase 3.

Nếu phải chọn giữa “đủ rõ để vận hành” và “nhiều tính năng hơn”, hãy chọn **đủ rõ để vận hành**.
