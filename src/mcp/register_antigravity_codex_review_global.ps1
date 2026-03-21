[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoPath,
    [string]$ServerName = "codex-review",
    [string]$CodexProfile
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path $RepoPath).Path
$packageRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$bridgeCandidates = @(
    (Join-Path $PSScriptRoot "codex_review_mcp.py"),
    (Join-Path $packageRoot "src\mcp\codex_review_mcp.py")
)
$schemaCandidates = @(
    (Join-Path $PSScriptRoot "codex_review_schema.json"),
    (Join-Path $packageRoot "src\mcp\codex_review_schema.json")
)

$bridgePath = $bridgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$schemaPath = $schemaCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $bridgePath) {
    throw "Could not find codex_review_mcp.py in the packaged src\\mcp runtime for repo: $repoRoot"
}

if (-not $schemaPath) {
    throw "Could not find codex_review_schema.json in the packaged src\\mcp runtime for repo: $repoRoot"
}

$bridgePath = (Resolve-Path $bridgePath).Path
$schemaPath = (Resolve-Path $schemaPath).Path

$pythonCommand = $null
$pythonPrefixArgs = @()
$antigravity = Get-Command antigravity -ErrorAction Stop

$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    $pythonCommand = $python.Source
} else {
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        $pythonCommand = $pyLauncher.Source
        $pythonPrefixArgs = @("-3")
    } else {
        throw "Neither 'python' nor 'py' is available in PATH."
    }
}

$serverArgs = $pythonPrefixArgs + @(
    $bridgePath,
    "--workspace",
    $repoRoot,
    "--schema",
    $schemaPath,
    "--codex-timeout-sec",
    "600"
)

if (-not [string]::IsNullOrWhiteSpace($CodexProfile)) {
    $serverArgs += @(
        "--codex-profile",
        $CodexProfile.Trim()
    )
}

$serverDefinition = @{
    name = $ServerName
    command = $pythonCommand
    args = $serverArgs
}

$json = $serverDefinition | ConvertTo-Json -Compress

Write-Host "Registering MCP server '$ServerName' in Antigravity for repo: $repoRoot"
$antigravityExe = $antigravity.Source
$env:CODEX_REVIEW_REGISTRATION_JSON = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
$env:CODEX_REVIEW_ANTIGRAVITY_EXE = $antigravityExe
$encodedCommand = @'
import base64
import os
import subprocess

payload = base64.b64decode(os.environ["CODEX_REVIEW_REGISTRATION_JSON"]).decode("utf-8")
antigravity_exe = os.environ["CODEX_REVIEW_ANTIGRAVITY_EXE"]
subprocess.run([antigravity_exe, "--add-mcp", payload], check=True)
'@

$pythonRunnerArgs = $pythonPrefixArgs + @("-")
$encodedCommand | & $pythonCommand @pythonRunnerArgs
$env:CODEX_REVIEW_REGISTRATION_JSON = $null
$env:CODEX_REVIEW_ANTIGRAVITY_EXE = $null
Write-Host "Done."
