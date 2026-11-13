# teleagent-dashboard launcher (HKCU Run autostart, ASCII only for PS 5.1 compat)
# Idempotent: skip if port 8590 already listening; else start node server.js
$dir = $PSScriptRoot
$logDir = Join-Path $dir 'data'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir 'autostart.log'

function Write-KaLog([string]$msg) {
  Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
}

# Idempotent guard
$listening = Get-NetTCPConnection -LocalPort 8590 -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Write-KaLog "already-running(PID $($listening.OwningProcess | Select-Object -First 1)), skip autostart"
  exit 0
}

Write-KaLog "autostart: launching teleagent-dashboard..."

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\TeleAgent\data\runtimes\node\node.exe' }
if (-not (Test-Path -LiteralPath $node)) {
  Write-KaLog "node not found, autostart failed"
  exit 1
}

Set-Location -LiteralPath $dir
& $node server.js *>> $log
