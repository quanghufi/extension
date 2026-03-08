# Phase 05: Resilient Sessions

Status: ⬜ Pending
Dependencies: Phase 1 complete (existing session lifecycle)
Est: 1 session

## Objective

Xử lý gracefully 3 tình huống thực tế:
1. **Cancel** mid-review → cleanup snapshots + kill processes
2. **Retry** failed review → fresh session with new snapshot
3. **Reconnect** WebSocket → catch up missed events

## Hiện trạng (Phase 1)

- `Session.createRetry()` tạo session mới với `parentSessionId` — nhưng chưa được wire vào scripts
- `process.on('SIGINT')` cleanup đã fix ở Round 6
- WebSocket disconnect → client phải reload page thủ công
- Cancel chỉ kill process, không notify session state

## Requirements

### Functional — Cancel
- [ ] `DELETE /api/sessions/:id` → graceful cancel
- [ ] Cancel kills running agent processes (via process tree kill)
- [ ] Session transitions to `cancelled` state
- [ ] Snapshot cleaned up (remove read-only + delete)
- [ ] WebSocket subscribers receive `session_cancelled` event
- [ ] Dashboard shows "Cancelled" badge with cancel reason

### Functional — Retry
- [ ] `POST /api/sessions/:id/retry` → create retry session
- [ ] Retry creates NEW snapshot from current commit
- [ ] Original session marked as parent (`parentSessionId`)
- [ ] Only failed/cancelled sessions can be retried
- [ ] Dashboard shows retry chain: "Attempt 1 → Attempt 2 → ..."
- [ ] Optional: override prompt for retry

### Functional — Reconnect
- [ ] WebSocket auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
- [ ] On reconnect: send `{ reconnect: sessionId, lastSeq: N }`
- [ ] Server replays events from `seq > lastSeq`
- [ ] Dashboard shows "Reconnecting..." indicator
- [ ] Max reconnect attempts: 10 → then show "Connection lost"

### Non-Functional
- [ ] Cancel must complete within 5 seconds (kill timeout)
- [ ] Retry chain limit: max 5 retries per original session
- [ ] Event replay: max 1000 events per reconnect
- [ ] Zero data loss during reconnect gap

## Implementation Steps

1. [ ] Implement cancel flow in session + server
   - `Session.cancel(reason)` → transitions to `cancelled`, records reason
   - Process tree kill: `taskkill /T /F /PID` (Windows) 
   - `DELETE /api/sessions/:id` handler in `HubServer`
   - Broadcast `{ type: 'status', payload: { status: 'cancelled', reason } }`

2. [ ] Implement retry flow
   - `POST /api/sessions/:id/retry` → validate state, create retry
   - `Session.createRetry()` already exists — wire it to API
   - Create new snapshot for retry (don't reuse old one)
   - Start agents on new session automatically
   - Response: `{ retrySessionId, attempt, parentSessionId }`

3. [ ] Implement WebSocket reconnect protocol
   ```js
   // Client sends on reconnect:
   { type: 'reconnect', sessionId: 'xxx', lastSeq: 42 }
   
   // Server responds:
   { type: 'replay_start', fromSeq: 43, count: 5 }
   { type: 'event', seq: 43, ... }
   { type: 'event', seq: 44, ... }
   ...
   { type: 'replay_end' }
   ```

4. [ ] Update dashboard WebSocket client
   - Track `lastSeq` from received events
   - On close: start reconnect timer (exponential backoff)
   - On reconnect: send `reconnect` message with `lastSeq`
   - Show reconnect UI: "Reconnecting in X seconds..."
   - On replay: process events sequentially, update views
   - Counter: show "Reconnected! Caught up X events"

5. [ ] Add cancel button to dashboard
   - Red "Cancel Review" button (visible when session is running)
   - Confirmation dialog: "Cancel review? Snapshots will be cleaned up."
   - After cancel: button changes to "Retry" (if cancellable)

6. [ ] Add retry chain display
   - Show attempt number in session header: "Review Session (Attempt 2/5)"
   - Collapsible history: previous attempts with their findings summary
   - Link to parent session details

7. [ ] Write tests
   - Cancel: running session → cancelled
   - Cancel: terminal session → error (can't cancel completed)
   - Retry: cancelled session → new session created
   - Retry: completed session → error (no retry needed)
   - Retry: max retries exceeded → error
   - Reconnect: replays events after lastSeq
   - Reconnect: empty gap (no missed events)
   - Reconnect: invalid lastSeq → full replay from 0

## Files to Create/Modify

- `src/hub/session.js` — MODIFY: add `cancel(reason)`, enforce retry limits
- `src/hub/session.test.js` — MODIFY: add cancel/retry tests
- `src/server.js` — MODIFY: add DELETE, POST retry, reconnect protocol
- `src/server.test.js` — MODIFY: add API + WebSocket reconnect tests
- `src/ui/index.html` — MODIFY: cancel button, retry UI, reconnect indicator

## Test Criteria

- [ ] Cancel transitions running session to cancelled
- [ ] Cancel on terminal session returns 409 Conflict
- [ ] Retry creates new session with parentSessionId
- [ ] Retry on running session returns 409
- [ ] Max retry limit enforced (5)
- [ ] WebSocket replay sends correct events after lastSeq
- [ ] Replay respects max 1000 events limit
- [ ] Reconnect protocol handshake works
- [ ] Dashboard shows reconnecting indicator
- [ ] Cancel button disappears after session completes
- [ ] Existing 172+ tests still pass

## Notes

- Process kill on Windows: `taskkill /T /F /PID <pid>` kills entire tree
- Exponential backoff: 1000 * 2^attempt, jitter ±20%, capped at 30s
- Event replay uses session.events array (already stored in memory)
- Retry snapshot: always from HEAD, not from parent snapshot's commit
- Future: could add partial retry (only re-run failed agent, keep successful results)

---
End of Phase 2 plan.
