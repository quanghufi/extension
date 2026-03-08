# Phase 01: Agent Registry

Status: ⬜ Pending
Dependencies: Phase 1 complete
Est: 1 session

## Objective

Thay thế hardcoded Codex + Claude adapters bằng một registry system cho phép:
- Thêm/bớt agent qua config file (không sửa code)
- Mỗi agent có adapter type, command, args, timeout config
- Validate config trước khi launch
- Backward-compatible: default config vẫn là Codex + Claude

## Hiện trạng (Phase 1)

Trong `scripts/e2e-test.js` và `scripts/hub-codex-review.js`, agents được hardcode:
```js
const codexAdapter = new CodexAdapter({ ... });
const claudeAdapter = new ClaudeAdapter({ ... });
```

Nếu muốn thêm agent thứ 3 (Gemini CLI, Cursor, etc.) → phải sửa code.

## Requirements

### Functional
- [ ] Config file format: `agents.json` hoặc `agents.yml` trong project root
- [ ] Registry loads config, validates, và instantiate đúng adapter class
- [ ] Built-in adapter types: `codex`, `claude`, `generic` (custom command)
- [ ] Each agent config: `id`, `name`, `type`, `command`, `args[]`, `env{}`, `timeout{}`
- [ ] Default config auto-generated nếu file không tồn tại
- [ ] `--agents` CLI flag để filter agents cho từng run

### Non-Functional
- [ ] Config validation: clear error messages cho missing/invalid fields
- [ ] Zero breaking changes: existing E2E scripts vẫn chạy

## Implementation Steps

1. [ ] Define config schema + JSDoc types (`src/adapters/registry.js`)
   ```js
   /** @typedef {Object} AgentConfig
    *  @property {string} id - Unique agent identifier
    *  @property {string} name - Display name
    *  @property {'codex'|'claude'|'generic'} type - Adapter type
    *  @property {string} command - CLI command
    *  @property {string[]} [args] - Additional CLI args
    *  @property {Record<string, string>} [env] - Extra env vars
    *  @property {object} [timeout] - Override timeouts
    *  @property {number} [timeout.firstByte] - ms
    *  @property {number} [timeout.idle] - ms
    *  @property {number} [timeout.hard] - ms
    */
   ```

2. [ ] Implement `AgentRegistry` class
   - `loadFromFile(configPath)` — parse + validate JSON
   - `loadDefaults()` — returns hardcoded Codex + Claude config
   - `createAdapter(agentConfig, sessionOpts)` — factory method
   - `listAgents()` — returns all registered configs
   - `getAgent(id)` — returns single config

3. [ ] Implement `GenericAdapter` extending `BaseAdapter`
   - Accepts arbitrary `command` + `args`
   - Captures stdout/stderr like existing adapters
   - Parses output as JSON (or raw text fallback)

4. [ ] Create default `agents.json` template
   ```json
   {
     "agents": [
       {
         "id": "codex",
         "name": "Codex CLI",
         "type": "codex",
         "command": "codex",
         "args": ["review"],
         "timeout": { "firstByte": 45000, "idle": 20000, "hard": 90000 }
       },
       {
         "id": "claude-code",
         "name": "Claude Code CLI",
         "type": "claude",
         "command": "claude",
         "args": ["-p", "--no-session-persistence"],
         "timeout": { "firstByte": 90000, "idle": 30000, "hard": 120000 }
       }
     ]
   }
   ```

5. [ ] Update `e2e-test.js` and `hub-codex-review.js` to use Registry
   - Replace hardcoded adapter creation with `registry.createAdapter()`
   - Add `--agents codex,claude` filter flag

6. [ ] Write tests (`src/adapters/registry.test.js`)
   - Valid config loads correctly
   - Missing required fields → clear error
   - Unknown adapter type → error
   - Default config matches Phase 1 behavior
   - `--agents` flag filters correctly
   - `GenericAdapter` basic execution

## Files to Create/Modify

- `src/adapters/registry.js` — NEW: AgentRegistry class
- `src/adapters/generic-adapter.js` — NEW: GenericAdapter for custom commands
- `src/adapters/generic-adapter.test.js` — NEW: Tests
- `src/adapters/registry.test.js` — NEW: Tests
- `agents.example.json` — NEW: Example config template
- `scripts/e2e-test.js` — MODIFY: use Registry
- `scripts/hub-codex-review.js` — MODIFY: use Registry

## Test Criteria

- [ ] `AgentRegistry.loadDefaults()` returns 2 agents (codex, claude)
- [ ] `AgentRegistry.loadFromFile()` parses valid JSON config
- [ ] Invalid config throws with field-level error message
- [ ] `createAdapter('codex', opts)` returns CodexAdapter instance
- [ ] `createAdapter('claude', opts)` returns ClaudeAdapter instance
- [ ] `createAdapter('generic', opts)` returns GenericAdapter instance
- [ ] GenericAdapter executes command and captures output
- [ ] Existing 172 tests still pass (zero regressions)

## Notes

- `GenericAdapter` là key để mở rộng: user chỉ cần viết CLI tool output JSON
  và config trong `agents.json` là xong
- Timeout defaults phải match Phase 1 values chính xác
- Config file path: `./agents.json` (project root), overridable via `--config` flag

---
Next Phase: [Phase 02 — Smart Auto-Merge](./phase-02-smart-merge.md)
