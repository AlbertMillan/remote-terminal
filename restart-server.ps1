<#
.SYNOPSIS
  Stop the running Claude Remote server and start it again from dist/.

.DESCRIPTION
  There was no restart script -- only start-server.bat and start-server-hidden.vbs,
  which start a server without stopping one, so running them against a live
  instance just fails to bind the port.

  IMPORTANT: terminal sessions are child processes of the server, so restarting
  kills every active session. If you launch this from inside a claude-remote
  terminal you are killing your own shell, and a script running in that shell
  dies with it -- before it can start the server back up. Use restart-server.vbs
  (or -Detach) in that case: it re-launches this script outside the server's
  process tree, so the restart completes even though the calling session ends.

.PARAMETER Port
  Port the server listens on. Default 4220.

.PARAMETER Detach
  Re-launch this script in its own hidden process and return immediately.

.EXAMPLE
  .\restart-server.ps1
  .\restart-server.ps1 -Detach
#>
[CmdletBinding()]
param(
    [int]$Port = 4220,
    [switch]$Detach
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Detach) {
    # Own process tree, so the restart outlives the session that asked for it.
    $quoted = '"' + $MyInvocation.MyCommand.Path + '"'
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $quoted, '-Port', $Port `
        -WindowStyle Hidden
    Write-Output "Restart launched in the background on port $Port."
    exit 0
}

if (-not (Test-Path (Join-Path $root 'dist\server\index.js'))) {
    Write-Error "dist\server\index.js is missing -- run 'npm run build' first."
    exit 1
}

# --- Stop -------------------------------------------------------------------
# Match the server by its command line, not by name: plenty of unrelated
# node.exe processes are running, and npm wrappers must not be mistaken for it.
$servers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -and
    $_.CommandLine -match 'dist[\\/]server[\\/]index\.js' -and
    $_.CommandLine -notmatch 'npm-cli|npx-cli'
}

if ($servers) {
    foreach ($s in $servers) {
        Write-Output "Stopping server (PID $($s.ProcessId))..."
        try {
            Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop
        } catch {
            Write-Warning "Could not stop PID $($s.ProcessId): $($_.Exception.Message)"
        }
    }
} else {
    Write-Output 'No running server found; starting a fresh one.'
}

# Wait for the port to come free, so the new process is not refused the bind.
$freed = $false
foreach ($i in 1..30) {
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) { $freed = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $freed) {
    Write-Error "Port $Port is still held after 15s -- something else is listening on it."
    exit 1
}

# --- Start ------------------------------------------------------------------
$vbs = Join-Path $root 'start-server-hidden.vbs'
Write-Output 'Starting server...'
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden

# --- Verify -----------------------------------------------------------------
# Report what actually happened rather than assuming the spawn worked.
foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 500
    try {
        $res = Invoke-WebRequest -Uri "http://localhost:$Port/api/sessions" `
            -UseBasicParsing -TimeoutSec 2
        if ($res.StatusCode -eq 200) {
            Write-Output "Server is up on port $Port."
            exit 0
        }
    } catch {
        # Not listening yet; keep waiting.
    }
}

Write-Error "Server did not come up on port $Port within 20s -- check ~\.claude-remote\logs\server.log."
exit 1
