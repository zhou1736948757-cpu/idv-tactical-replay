<#
.SYNOPSIS
  Start the Vue 3 Manor Dossier web app (Vite dev or preview server) from the project root.

.DESCRIPTION
  1. Ensures packages/replay-renderer is installed and built (its dist/ is gitignored and the
     frontend consumes it through a file: symlink, so it must exist before Vite starts).
  2. Ensures frontend/node_modules exists.
  3. Starts Vite with /api proxied to $ApiTarget via VITE_API_PROXY_TARGET
     (frontend/vite.config.ts honours it in both dev and preview modes).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/start_frontend.ps1
  powershell -ExecutionPolicy Bypass -File scripts/start_frontend.ps1 -Mode preview -Port 4173
#>
[CmdletBinding()]
param(
    [ValidateSet("dev", "preview")]
    [string]$Mode = "dev",
    [int]$Port = 5173,
    [string]$BindHost = "127.0.0.1",
    [string]$ApiTarget = "http://127.0.0.1:8000"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $ProjectRoot

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Error "npm not found on PATH. Install Node.js 20+ first."
    exit 1
}

$RendererDir = Join-Path $ProjectRoot "packages\replay-renderer"
$FrontendDir = Join-Path $ProjectRoot "frontend"

if (-not (Test-Path (Join-Path $RendererDir "node_modules"))) {
    Write-Host "[frontend] Installing packages/replay-renderer dev dependencies ..."
    npm --prefix packages/replay-renderer install
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install (replay-renderer) failed"; exit 1 }
}

if (-not (Test-Path (Join-Path $RendererDir "dist\index.js"))) {
    Write-Host "[frontend] packages/replay-renderer/dist missing -> building @idv/replay-renderer ..."
    npm --prefix packages/replay-renderer run build
    if ($LASTEXITCODE -ne 0) { Write-Error "replay-renderer build failed"; exit 1 }
}

if (-not (Test-Path (Join-Path $FrontendDir "node_modules"))) {
    Write-Host "[frontend] Installing frontend dependencies ..."
    npm --prefix frontend install
    if ($LASTEXITCODE -ne 0) { Write-Error "npm install (frontend) failed"; exit 1 }
}

$env:VITE_API_PROXY_TARGET = $ApiTarget
Write-Host "[frontend] /api proxy  -> $ApiTarget"

if ($Mode -eq "preview") {
    Write-Host "[frontend] Building production bundle (vue-tsc + vite build) ..."
    npm --prefix frontend run build
    if ($LASTEXITCODE -ne 0) { Write-Error "frontend build failed"; exit 1 }
    Write-Host "[frontend] Web app      : http://${BindHost}:$Port/"
    npm --prefix frontend run preview -- --host $BindHost --port $Port --strictPort
} else {
    Write-Host "[frontend] Web app      : http://${BindHost}:$Port/"
    npm --prefix frontend run dev -- --host $BindHost --port $Port --strictPort
}
exit $LASTEXITCODE
