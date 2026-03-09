param(
    [Parameter(Position = 0)]
    [string] $Prompt,

    [string] $OutputPath = ".agents/codex-feedback.md",

    [string] $CodexHome = "$env:USERPROFILE\.codex",

    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Utf8File {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText((Resolve-Path -LiteralPath $parent).Path + "\" + (Split-Path -Leaf $Path), $Content, $utf8NoBom)
}

function Resolve-OutputPath {
    param([string] $Path)

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return $Path
    }

    return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Path))
}

$resolvedOutputPath = Resolve-OutputPath $OutputPath
$resolvedCodexHome = [System.IO.Path]::GetFullPath($CodexHome)
$configPath = Join-Path $resolvedCodexHome 'config.toml'
$authPath = Join-Path $resolvedCodexHome 'auth.json'
$codexCommand = (Get-Command codex.cmd -ErrorAction SilentlyContinue).Source

if (-not $codexCommand) {
    $codexCommand = (Get-Command codex -ErrorAction Stop).Source
}

if (-not (Test-Path $resolvedCodexHome)) {
    throw "CODEX_HOME not found: $resolvedCodexHome"
}

if (-not (Test-Path $configPath)) {
    throw "Codex config not found: $configPath"
}

if (-not (Test-Path $authPath)) {
    throw "Codex auth not found: $authPath"
}

$effectivePrompt = $Prompt
if ([string]::IsNullOrWhiteSpace($effectivePrompt) -and $args.Count -gt 0) {
    $effectivePrompt = ($args -join ' ').Trim()
}

if ([string]::IsNullOrWhiteSpace($effectivePrompt)) {
    $effectivePrompt = @'
Đọc context hiện tại trong repo và phản hồi thẳng bằng tiếng Việt.
Ưu tiên finding quan trọng trước. Nêu assumption yếu, bug, rủi ro, missing verification.
'@
}

$env:HOME = [System.IO.Path]::GetDirectoryName($resolvedCodexHome)
$env:USERPROFILE = [System.IO.Path]::GetDirectoryName($resolvedCodexHome)
$env:CODEX_HOME = $resolvedCodexHome

$header = @(
    "[run-codex-feedback] cwd=$((Get-Location).Path)",
    "[run-codex-feedback] CODEX_HOME=$env:CODEX_HOME",
    "[run-codex-feedback] output=$resolvedOutputPath",
    "[run-codex-feedback] promptLength=$($effectivePrompt.Length)"
) -join "`r`n"

if ($DryRun) {
    $preview = @(
        $header,
        '',
        'DRY RUN',
        'Command: codex review <prompt>',
        '',
        'Config preview:',
        (Get-Content -LiteralPath $configPath -Raw),
        '',
        'Auth file found: yes'
    ) -join "`r`n"

    $parent = Split-Path -Parent $resolvedOutputPath
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($resolvedOutputPath, $preview, $utf8NoBom)
    Write-Host "Dry run written to $resolvedOutputPath"
    exit 0
}

$arguments = @(
    'review',
    $effectivePrompt
)

function Quote-Argument {
    param([string] $Value)

    if ($null -eq $Value) {
        return '""'
    }

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

$previousLocation = Get-Location
$exitCode = 0
$stdoutTempPath = [System.IO.Path]::GetTempFileName()
$stderrTempPath = [System.IO.Path]::GetTempFileName()
try {
    Set-Location -LiteralPath (Get-Location)

    $quotedArguments = ($arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    $process = Start-Process -FilePath $codexCommand `
        -ArgumentList $quotedArguments `
        -WorkingDirectory $previousLocation.Path `
        -RedirectStandardOutput $stdoutTempPath `
        -RedirectStandardError $stderrTempPath `
        -NoNewWindow `
        -Wait `
        -PassThru

    $stdoutContent = if (Test-Path $stdoutTempPath) { Get-Content -LiteralPath $stdoutTempPath -Raw } else { '' }
    $stderrContent = if (Test-Path $stderrTempPath) { Get-Content -LiteralPath $stderrTempPath -Raw } else { '' }
    $rawOutput = ($stdoutContent + $stderrContent)
    $exitCode = $process.ExitCode
}
catch {
    $rawOutput = $_ | Out-String
    $exitCode = 1
}
finally {
    foreach ($tempPath in @($stdoutTempPath, $stderrTempPath)) {
        if ($tempPath -and (Test-Path $tempPath)) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
    Set-Location -LiteralPath $previousLocation
}

$combined = @(
    $header,
    "[run-codex-feedback] exitCode=$exitCode",
    '',
    $rawOutput
) -join "`r`n"

$parent = Split-Path -Parent $resolvedOutputPath
if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($resolvedOutputPath, $combined, $utf8NoBom)

Write-Host "Codex feedback written to $resolvedOutputPath"
exit $exitCode
