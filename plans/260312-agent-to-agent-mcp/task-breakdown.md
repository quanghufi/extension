# Phase 2A — Agent-to-Agent MCP Hub

## Purpose

File này là implementation handoff để Antigravity code tiếp Phase 2A theo từng file, giảm tối đa quyết định lại trong lúc implement.

Scope của bản này:
- thêm collaboration layer cho shared session
- thêm 5 MCP tools mới
- giữ backward compatibility với flow review cũ

Không làm ở vòng này:
- `hub_reply_to_finding`
- auth production-grade
- auto snapshot creation
- free-form chat UI hoàn chỉnh

## Defaults đã chốt

- Session model: shared thread
- Advance primitive: `hub_advance_session`
- Default reviewer: `codex`
- Default responder: `antigravity`
- Default decider: `antigravity`
- First turn: `reviewer`
- Turn TTL default: `600s`

## File-by-file tasks

### 1) `src/hub/session-collab.js`

Tạo file mới chứa collaboration state machine.

Export các hằng và helper sau:
- `COLLAB_STATES`
- `COLLAB_TERMINAL_STATES`
- `TURN_STATUS`
- `ADVANCE_ACTIONS`
- `defaultAssignments()`
- `createDefaultTurn()`
- `expectedAgentForState(collabState, assignments)`
- `transitionOnAssignments(assignments)`
- `claimStateForAgent(agentId, assignments)`
- `waitingStateForAgent(agentId, assignments)`
- `validateAdvanceAction({ collabState, action, agentId, assignments, isDecider })`
- `deriveNextCollabState({ collabState, action, agentId, assignments, payload })`

Hardcode transitions theo spec:

```text
draft -> awaiting_assignment
awaiting_assignment -> awaiting_codex_turn
awaiting_assignment -> awaiting_antigravity_turn
awaiting_assignment -> failed

awaiting_codex_turn -> codex_reviewing
codex_reviewing -> awaiting_antigravity_turn
codex_reviewing -> awaiting_resolution
codex_reviewing -> failed

awaiting_antigravity_turn -> antigravity_reviewing
antigravity_reviewing -> awaiting_codex_turn
antigravity_reviewing -> awaiting_resolution
antigravity_reviewing -> failed

awaiting_resolution -> awaiting_codex_turn
awaiting_resolution -> awaiting_antigravity_turn
awaiting_resolution -> resolved
awaiting_resolution -> closed
awaiting_resolution -> failed

resolved -> closed
failed -> awaiting_codex_turn
failed -> awaiting_antigravity_turn
closed -> terminal
```

Notes:
- không phụ thuộc MCP/HTTP/server
- source of truth cho collab state machine

### 2) `src/hub/session-messages.js`

Tạo file mới chứa message schema + validation.

Export:
- `MESSAGE_TYPES`
- `MESSAGE_TYPES_REQUIRING_TURN`
- `MESSAGE_TYPES_REQUIRING_FINDING_REF`
- `buildSessionMessage({ session, agentId, role, type, content, findingRefs, replyToMessageId, turnToken, metadata })`
- `validateFindingRefs(session, findingRefs)`
- `validateReplyTarget(session, replyToMessageId)`
- `filterMessages(messages, { afterSeq, limit, types, agentId })`

Validation rules:
- `content` trim xong không được rỗng
- `finding_reply`, `decision`, `rerun_request`, `resolution` phải check finding refs nếu dùng finding
- `replyToMessageId` phải trỏ tới message đã tồn tại

### 3) `src/hub/session.js`

Mở rộng session hiện tại, nhưng import logic từ 2 file mới thay vì nhồi toàn bộ vào đây.

Thêm fields trong constructor:
- `messages = []`
- `messageSeqCounter = 0`
- `collabState = 'draft'`
- `assignments = defaultAssignments()`
- `turn = createDefaultTurn()`
- `pendingAction = null`

Nếu session tạo mới từ flow review chuẩn:
- set default assignments:
  - reviewer `codex`
  - responder `antigravity`
  - decider `antigravity`
- nếu đủ reviewer + responder thì `collabState = awaiting_codex_turn`

Thêm methods:
- `addMessage(input)`
- `listMessages(filters)`
- `assignAgent(role, agentId)`
- `claimTurn(agentId, ttlSeconds = 600)`
- `releaseTurn(agentId, token)`
- `ensureTurnOwner(agentId, token)`
- `advanceCollabState(action, agentId, options = {})`
- `expireTurnIfNeeded(now = new Date())`
- `isCollabTerminal()`
- `getExpectedAgentForCurrentState()`

Behavior:
- `claimTurn()`:
  - expire turn cũ nếu cần
  - chỉ cho expected agent claim
  - set `turnToken`
  - set `claimedAt`, `claimExpiresAt`
  - đổi state sang `codex_reviewing` hoặc `antigravity_reviewing`
- `advanceCollabState()`:
  - validate bằng helper từ `session-collab.js`
  - `request_rerun` set `pendingAction = { type: 'rerun', ... }`
  - `resolve` -> `resolved`
  - `close` -> `closed`
  - `release_turn` trả state về `awaiting_<same_agent>_turn`

Update `toJSON()` và `toSummaryJSON()` để include:
- `collabState`
- `assignments`
- `turn`
- `pendingAction`
- `messageCount`

### 4) `src/hub/session-serialization.js`

Serialize/deserialize thêm:
- `messages`
- `messageSeqCounter`
- `collabState`
- `assignments`
- `turn`
- `pendingAction`

Compatibility:
- session cũ load được với default values
- không fail nếu thiếu field mới

### 5) `src/schema/events.js`

Thêm event types mới:
- `message_posted`
- `turn_claimed`
- `turn_released`
- `turn_expired`
- `agent_assigned`
- `collab_state_changed`
- `resolution_requested`
- `session_resolved`
- `session_closed`

Không đổi contract `createEvent()` ngoài việc hỗ trợ event types mới.

### 6) `src/mcp-server.js`

Expose 5 tools mới:
- `hub_post_message`
- `hub_list_messages`
- `hub_claim_turn`
- `hub_assign_agent`
- `hub_advance_session`

Pattern cho mỗi tool:
1. `await hub.ensureReady()`
2. load session
3. gọi method trên `Session`
4. `server.store.save(session)`
5. emit event tương ứng
6. return JSON text

Tool-specific behavior:
- `hub_post_message` -> emit `message_posted`
- `hub_list_messages` -> return `messages`, `total`, `nextAfterSeq`, `collabState`, `turn`
- `hub_claim_turn` -> emit `turn_claimed` + `collab_state_changed`
- `hub_assign_agent` -> emit `agent_assigned`; nếu state đổi thì emit `collab_state_changed`
- `hub_advance_session` -> emit `collab_state_changed`; nếu `resolve` emit `session_resolved`; nếu `close` emit `session_closed`

Mở rộng `hub_get_status` để trả thêm:
- `collabState`
- `assignments`
- `turn`
- `pendingAction`
- `messageCount`

### 7) `src/api-routes.js`

Giữ endpoint cũ, thêm REST parity endpoints:
- `GET /api/sessions/:id/messages`
- `POST /api/sessions/:id/messages`
- `POST /api/sessions/:id/claim-turn`
- `POST /api/sessions/:id/assignments`
- `POST /api/sessions/:id/advance`

Nếu file bắt đầu phình lớn, tách thêm:
- `src/collab-routes.js`

Recommendation:
- tạo `src/collab-routes.js` để giữ `src/api-routes.js` gọn

### 8) `src/server.js`

Không rewrite orchestrator lớn.

Chỉ làm các việc sau:
- nối thêm route dispatch cho collab endpoints nếu tách route file mới
- trước khi thao tác collab, có thể gọi `session.expireTurnIfNeeded()`
- giữ `runSession()` như runtime execution layer hiện tại

Không tự động advance nhiều collab states trong `runSession()`.

### 9) `src/rebuttal-routes.js`

Giữ evaluate/rerun cũ.

Bridge nhẹ với collab flow:
- `apiEvaluateFindings`
  - vẫn lưu rebuttal như cũ
  - optional: mirror thành `decision` hoặc `finding_reply` message
- `apiRerunSession`
  - child session mới phải có collab defaults đúng
  - optional: append system message vào parent: `rerun child created`

Nếu scope cần gọn:
- ưu tiên child session có collab metadata đúng
- mirror-to-message có thể để TODO

### 10) Tests mới và cập nhật test cũ

#### `src/hub/session-collab.test.js`
Test:
- default assignments
- expected agent mapping
- valid/invalid transitions
- derive next state cho:
  - `review_complete`
  - `request_response`
  - `request_rerun`
  - `resolve`
  - `close`
  - `release_turn`

#### `src/hub/session-messages.test.js`
Test:
- valid `note`
- reject empty content
- reject invalid reply target
- reject invalid finding refs
- `afterSeq` polling
- `limit`
- filter by `type`
- filter by `agentId`

#### update `src/hub/session.test.js`
Test:
- constructor defaults for collab fields
- `assignAgent()` transitions state
- `claimTurn()` returns token + updates state
- `releaseTurn()` works
- `advanceCollabState()` handles rerun/resolve
- serialization round-trip preserves new fields

#### update `src/mcp-server.test.js`
Test tool layer cho:
- `hub_assign_agent`
- `hub_claim_turn`
- `hub_post_message`
- `hub_list_messages`
- `hub_advance_session`

#### update `src/server.test.js`
Integration flow:
- create session
- codex claim
- codex post summary
- codex advance
- antigravity claim
- antigravity post reply
- antigravity request rerun or resolve

WebSocket should receive:
- `message_posted`
- `turn_claimed`
- `collab_state_changed`

## Suggested coding order

1. `src/hub/session-collab.js`
2. `src/hub/session-messages.js`
3. `src/hub/session.js`
4. `src/hub/session-serialization.js`
5. `src/schema/events.js`
6. `src/mcp-server.js`
7. `src/api-routes.js` hoặc `src/collab-routes.js`
8. `src/server.js`
9. `src/rebuttal-routes.js`
10. unit tests
11. integration tests
12. docs ngắn

## Definition of done

- 5 MCP tools mới hoạt động
- shared session có `messages`, `turn`, `assignments`, `collabState`
- `Codex -> Antigravity -> Codex` chạy được trong 1 session
- API cũ chưa bị gãy
- tests cover state/message/turn flow

