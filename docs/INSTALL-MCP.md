# Install Extension Hub As An MCP Server

This guide explains how to install and wire `extension-hub-mcp` into MCP clients on another machine.

## What Gets Installed

After:

```bash
npm install -g extension-hub
```

you should have these commands:

```bash
extension-hub
extension-hub-mcp
```

- `extension-hub` starts the HTTP/WebSocket dashboard server.
- `extension-hub-mcp` starts the stdio MCP server.

## Install Sources

### From npm

```bash
npm install -g extension-hub
```

### From a Tarball

```bash
npm pack
npm install -g extension-hub-1.0.0.tgz
```

### Directly From GitHub

For a public GitHub repo:

```bash
npm install -g github:<owner>/<repo>
```

Equivalent git URL form:

```bash
npm install -g git+https://github.com/<owner>/<repo>.git
```

Pin a branch or tag:

```bash
npm install -g github:<owner>/<repo>#main
npm install -g github:<owner>/<repo>#v1.0.0
```

For a private repo, use a token-enabled git URL or clone the repo and run:

```bash
npm install -g .
```

## Requirements

### Minimum

- Node.js 20+

### For Real Codex Review Execution

- Python 3.10+
- `codex` CLI available in `PATH`

Without Python and `codex`, the MCP server can still start and expose tools, but review-execution tools will not be able to run real Codex-backed reviews.

## Quick Smoke Test

Run this on the target machine after install:

```bash
extension-hub-mcp
```

Expected behavior:

- The process starts and waits on stdio.
- You may see a startup log on `stderr` similar to:
  `"[extension-hub MCP] Server started on stdio"`

Stop it with `Ctrl+C`.

## Windows Path Tip

If your MCP client does not inherit npm global shims from `PATH`, use the full shim path instead of just `extension-hub-mcp`.

Typical npm global shim location on Windows:

```text
C:\Users\<you>\AppData\Roaming\npm\extension-hub-mcp.cmd
```

## Generic MCP Client Config

Use this when your MCP client accepts a stdio command definition.

```json
{
  "mcpServers": {
    "extension-hub": {
      "command": "extension-hub-mcp"
    }
  }
}
```

Windows fallback with absolute path:

```json
{
  "mcpServers": {
    "extension-hub": {
      "command": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\extension-hub-mcp.cmd"
    }
  }
}
```

## Claude Desktop Style Config

If your client uses a `claude_desktop_config.json`-style MCP config, use:

```json
{
  "mcpServers": {
    "extension-hub": {
      "command": "extension-hub-mcp"
    }
  }
}
```

Windows absolute-path variant:

```json
{
  "mcpServers": {
    "extension-hub": {
      "command": "C:\\Users\\<you>\\AppData\\Roaming\\npm\\extension-hub-mcp.cmd"
    }
  }
}
```

## Antigravity Setup

The package includes PowerShell helpers under `src/mcp/`.

### Register Current Working Directory As The Review Workspace

Open PowerShell in the repo you want to review, then run:

```powershell
powershell -ExecutionPolicy Bypass -File .\src\mcp\register_antigravity_codex_review.ps1
```

This helper:

- uses the installed packaged bridge in `src/mcp/`
- registers the current working directory as `--workspace`
- keeps the MCP server name as `codex-review` by default

### Register A Specific Repo Path

```powershell
powershell -ExecutionPolicy Bypass -File .\src\mcp\register_antigravity_codex_review_global.ps1 -RepoPath D:\my-repo
```

Optional parameters:

```powershell
-ServerName my-codex-review
-CodexProfile my-profile
```

## Codex CLI Dependency Check

Before relying on review tools, verify:

```bash
codex --help
python --version
```

Expected:

- `codex` resolves from `PATH`
- Python version is 3.10 or newer

## Recommended End-To-End Check

On a newly provisioned machine:

1. Install the package globally.
2. Run `extension-hub-mcp` once to confirm the MCP server starts.
3. Verify `codex --help` and `python --version`.
4. Add the MCP config to your client.
5. Restart the client.
6. Confirm the client sees tools such as `hub_list_sessions` and `hub_create_review`.

## Troubleshooting

### `command not found: extension-hub-mcp`

Cause:

- npm global bin path is not in `PATH`

Fix:

- use the absolute `.cmd` shim path on Windows
- or add your npm global bin directory to `PATH`

### MCP Client Starts, But Review Tools Fail

Cause:

- Python or `codex` CLI is missing

Fix:

- install Python 3.10+
- ensure `codex` is installed and reachable in `PATH`

### Antigravity Registration Fails

Check:

- `antigravity` exists in `PATH`
- `python` or `py` exists in `PATH`
- the PowerShell script is run from the intended workspace, or `-RepoPath` is correct

### No Findings Or Wrong Project Data Directory

The Hub MCP server stores review session data under the reviewed project's own directories:

```text
<projectDir>\data\
<projectDir>\tmp\snapshots\
```

So make sure `projectDir` points at the actual repo you want to review.
