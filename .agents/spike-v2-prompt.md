Doc context trong repo hien tai va phan tich ket qua spike v2 sau day.

## Context

Day la du an multi-agent communication hub. Chung toi dang build Phase 0 — spike test de xac nhan cac CLI (Codex va Claude Code) chay headless duoc.

## Ket qua spike v2

Spike v2 da chay xong voi 5 test. Ket qua chi tiet:

### Test 1: Codex CLI headless — TIMEOUT
- Command: `codex review "prompt"` (60s timeout)
- Codex mat ~20-30s loading 500+ skill YAML files
- stderr nhieu, stdout = 0 bytes
- Trong parallel test, Codex exit 0 trong 24s nhung stdout van = 0

### Test 2: Claude Code CLI headless — TIMEOUT  
- Command: `claude -p --no-session-persistence "prompt"` (60s timeout)
- Claude mat rat nhieu thoi gian init MCP servers (neural-memory, etc.)
- Console output cho thay "Xin chào!" response NHUNG chi xuat hien SAU khi timeout kill

### Test 3: Claude --output-format json — TIMEOUT (expected)
- Confirmed khong dung duoc, hangs

### Test 4: Parallel execution — ranParallel = true
- Codex: OK (24s, exit 0, nhung stdoutBytes = 0)  
- Claude: TIMEOUT (60s)
- Promise.all hoat dong dung

### Test 5: UTF-8 round-trip — PASS
- Vietnamese, Japanese, emoji deu round-trip qua JSON OK

## Van de ky thuat can giai quyet

### Problem 1: Codex output goes to stderr, not stdout
- Khi dung `exec()` trong Node.js, stdout = empty, nhung codex van chay va exit 0
- Output thuc su nam o stderr
- Can xac nhan: day la behavior co dinh cua codex CLI hay co flag nao doi output channel?

### Problem 2: Claude CLI can >60s timeout
- Claude CLI mat rat nhieu thoi gian vi init MCP servers
- Trong production hub, neu moi review mat 90-120s thi se rat cham
- Co cach nao toi uu startup time khong? Vi du:
  - Chay claude process persistent (giu warm)?
  - Disable MCP server loading cho review tasks?
  - Pre-warm MCP connections?

### Problem 3: Timeout strategy cho production hub
- Codex: ~24s average → 60s timeout du
- Claude: >60s consistently → 120s minimum
- Nhung voi 120s timeout, hub se rat cham khi review nhieu file
- Nen dung streaming output de detect "still working" vs "hung" khong?

### Problem 4: Windows exec() vs spawn()
- spawn() voi shell:false + cmd.exe thi args bi mangle
- spawn() voi shell:true thi .ps1 wrapper bi goi thay vi .cmd
- exec() voi command string hoat dong nhung khong co streaming
- Approach nao tot nhat cho production?

## Yeu cau

1. Tra loi bang tieng Viet
2. Thang than, khong dua hoi
3. Phan tich tung problem va de xuat giai phap ky thuat cu the
4. Neu co code example thi viet bang JavaScript/Node.js
5. Uu tien giai phap don gian, robust, co the implement ngay
6. Neu co rui ro hoac trade-off, noi ro

## Evidence files

- `docs/spike-results-v2.json` — automated test output
- `scripts/spike-test-v2.js` — test script v2
- `docs/spike-report.md` — analysis report
- `AGENTS.md` — project conventions and decisions
