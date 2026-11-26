<#
.SYNOPSIS
  Launch backend (FastAPI/uvicorn) + frontend (Vite) together, print URLs and health status.

.DESCRIPTION
  Starts scripts/start_backend.ps1 and scripts/start_frontend.ps1 as child processes, waits for
  /api/health and the web app to answer, prints clickable URLs, then keeps running until Ctrl+C.
  On exit both process trees are terminated with `taskkill /F /T`.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/start_all.ps1
  powershell -ExecutionPolicy Bypass -File scripts/start_all.ps1 -Mode preview -FrontendPort 4173
#>
[CmdletBinding()]
param(
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [ValidateSet("dev", "preview")]
    [string]$Mode = "dev",
    [string]$Python = "python",
    [int]$TimeoutSec = 180,
    [switch]$NoWait
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $ProjectRoot

$Shell = (Get-Process -Id $PID).Path
$BackendUrl = "http://127.0.0.1:$BackendPort"
$FrontendUrl = "http://127.0.0.1:$FrontendPort"

# The renderer dist/ is gitignored: make sure it exists before anything starts Vite.
if (-not (Test-Path (Join-Path $ProjectRoot "packages\replay-renderer\dist\index.js"))) {
    Write-Host "[all] packages/replay-renderer/dist missing -> building ..."
    if (-not (Test-Path (Join-Path $ProjectRoot "packages\replay-renderer\node_modules"))) {
        npm --prefix packages/replay-renderer install
        if ($LASTEXITCODE -ne 0) { Write-Error "npm install (replay-renderer) failed"; exit 1 }
    }
    npm --prefix packages/replay-renderer run build
    if ($LASTEXITCODE -ne 0) { Write-Error "replay-renderer build failed"; exit 1 }
}

function Stop-Tree([System.Diagnostics.Process]$Proc, [string]$Name) {
    if ($null -ne $Proc -and -not $Proc.HasExited) {
        Write-Host "[all] Stopping $Name (PID $($Proc.Id)) ..."
        & taskkill.exe /F /T /PID $Proc.Id 2>&1 | Out-Null
    }
}

function Wait-Http([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $r }
        } catch { Start-Sleep -Milliseconds 700 }
    }
    return $null
}

$backend = $null
$frontend = $null
try {
    $backend = Start-Process -FilePath $Shell -PassThru -NoNewWindow -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start_backend.ps1"),
        "-Port", "$BackendPort", "-Python", $Python)
    $frontend = Start-Process -FilePath $Shell -PassThru -NoNewWindow -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start_frontend.ps1"),
        "-Mode", $Mode, "-Port", "$FrontendPort", "-ApiTarget", $BackendUrl)

    $health = Wait-Http "$BackendUrl/api/health" $TimeoutSec
    if ($null -eq $health) { throw "Backend did not become healthy at $BackendUrl/api/health within $TimeoutSec s" }
    $h = $health.Content | ConvertFrom-Json

    $web = Wait-Http "$FrontendUrl/" $TimeoutSec
    if ($null -eq $web) { throw "Frontend did not answer at $FrontendUrl/ within $TimeoutSec s" }
    $proxied = Wait-Http "$FrontendUrl/api/health" 20

    Write-Host ""
    Write-Host "==================== IDV Tactical Replay ===================="
    Write-Host "  Web app     : $FrontendUrl/"
    Write-Host "  Chinatown   : $FrontendUrl/#m=6b04323a84b889718100f507&s=2"
    Write-Host "  API health  : $BackendUrl/api/health  (status=$($h.status), preloaded_matches=$($h.preloaded_matches))"
    Write-Host "  API docs    : $BackendUrl/docs"
    Write-Host "  /api proxy  : $(if ($null -ne $proxied) { 'OK' } else { 'NOT REACHABLE' })"
    Write-Host "============================================================="
    Write-Host "  Press Ctrl+C to stop both servers."

    if ($NoWait) { return }
    while (-not $backend.HasExited -and -not $frontend.HasExited) { Start-Sleep -Seconds 1 }
    if ($backend.HasExited) { Write-Warning "Backend exited with code $($backend.ExitCode)" }
    if ($frontend.HasExited) { Write-Warning "Frontend exited with code $($frontend.ExitCode)" }
}
finally {
    if (-not $NoWait) {
        Stop-Tree $frontend "frontend"
        Stop-Tree $backend "backend"
    }
}
