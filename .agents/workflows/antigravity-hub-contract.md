---
description: Antigravity operational contract for the local Agent Communication Hub
---

# Antigravity Hub Contract

Use this workflow whenever Antigravity interacts with the local hub at `http://localhost:3849`.

## Core Rules

1. Always poll `GET /api/sessions/:id` before doing anything else.
2. Use `session.displayState` as the primary execution state.
3. If `session.displayState == "stalled"` or `watchdog.stalled == true`:
   - stop polling immediately
   - do not keep waiting as if the review were progressing normally
   - do not treat this as a completed review
   - report `reviewer_stalled`
   - optionally trigger retry logic
4. Only fetch `GET /api/sessions/:id/findings` after `session.state == "completed"`.
5. If `session.state == "failed"` or `session.state == "cancelled"`, stop and report terminal failure.
6. Never use `Invoke-RestMethod ... | ConvertTo-Json -Depth N` for hub findings payloads.
7. Prefer:
   - `Invoke-RestMethod` when selecting a small number of fields
   - `Invoke-WebRequest(...).Content` when raw JSON text is needed
8. Treat MCP startup stalls as runtime/infrastructure failures, not as “still making progress”.

## State Decision Table

| Condition | Action |
|---|---|
| `displayState = completed` | Fetch findings |
| `displayState = stalled` | Stop, report `reviewer_stalled`, retry or fallback |
| `state = failed` | Stop, report failure |
| `state = cancelled` | Stop |
| `state = running` and not stalled | Continue polling |

## Safe PowerShell Pattern

> **⚠️ CRITICAL:** Do NOT use `exit` in inline PowerShell code (e.g. `run_command`).
> `exit` terminates the entire PowerShell process, not just the script block.
> Use `break` + `$result` variable instead. Only use `exit` in `.ps1` script files.

```powershell
$ErrorActionPreference = 'Stop'

$baseUrl = 'http://localhost:3849'
$sessionId = '{SESSION_ID}'

$maxPolls = 60
$pollSeconds = 3
$result = 'poll_timeout'

for ($i = 1; $i -le $maxPolls; $i++) {
    $status = Invoke-RestMethod -Uri "$baseUrl/api/sessions/$sessionId" -Method GET

    $state = $status.session.state
    $displayState = if ($status.session.displayState) { $status.session.displayState } else { $state }

    $stalled = $false
    if ($status.watchdog -and $status.watchdog.stalled) {
        $stalled = $status.watchdog.stalled
    } elseif ($status.session.watchdog -and $status.session.watchdog.stalled) {
        $stalled = $status.session.watchdog.stalled
    }

    Write-Host "Poll #$i - state=$state displayState=$displayState stalled=$stalled"

    if ($stalled -or $displayState -eq 'stalled') {
        $result = 'reviewer_stalled'; break
    }

    if ($state -eq 'failed' -or $state -eq 'cancelled') {
        $result = "terminal_failure:$state"; break
    }

    if ($state -eq 'completed') {
        $result = 'completed'; break
    }

    Start-Sleep -Seconds $pollSeconds
}

Write-Host "RESULT=$result"
if ($result -eq 'completed') {
    Write-Host 'Fetching findings...'
    (Invoke-WebRequest -UseBasicParsing "$baseUrl/api/sessions/$sessionId/findings").Content | Out-File -Encoding utf8 "$env:TEMP\hub-findings.json"
    Write-Host "Findings saved to $env:TEMP\hub-findings.json"
}
```

## Raw JSON Pattern

If raw JSON text is needed, use:

```powershell
(Invoke-WebRequest -UseBasicParsing "http://localhost:3849/api/sessions/{SESSION_ID}/findings").Content
```

Do not re-serialize the full PowerShell object with `ConvertTo-Json` unless you have already narrowed it down to a small shape.

## Forbidden Patterns

- Polling forever just because `state == running`
- Ignoring `displayState`
- Ignoring `watchdog.stalled`
- Fetching findings after a `stalled` result as if the review is still in progress
- Using `Invoke-RestMethod ... | ConvertTo-Json -Depth 5` on full hub responses

## Review Loop Integration

When running a Codex review loop:

1. Create session
2. Poll using the safe pattern above
3. If completed, fetch findings
4. Evaluate findings
5. Submit rebuttals/evaluations
6. Retry only when needed

## Examples

### Example A

```text
session.state = running
session.displayState = stalled
watchdog.stalled = true
=> Stop polling. Report reviewer_stalled. Do not keep waiting.
```

### Example B

```text
session.state = completed
session.displayState = completed
=> Fetch findings and continue triage.
```

### Example C

```text
session.state = failed
=> Stop and report failure.
```
