<#
.SYNOPSIS
  Start the IDV Tactical Replay FastAPI backend (uvicorn) from the project root.

.DESCRIPTION
  Runs `python -m uvicorn app.main:app --app-dir backend --host <BindHost> --port <Port>`.
  The 7 verified matches are served from backend/data/cache (or $env:IDV_CACHE_DIR when set).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/start_backend.ps1
  powershell -ExecutionPolicy Bypass -File scripts/start_backend.ps1 -Port 8010 -CacheDir D:\idv_cache
#>
[CmdletBinding()]
param(
    [int]$Port = 8000,
    [string]$BindHost = "127.0.0.1",
    [string]$Python = "python",
    [string]$CacheDir = "",
    [switch]$Reload
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $ProjectRoot

if (-not (Get-Command $Python -ErrorAction SilentlyContinue)) {
    Write-Error "Python executable '$Python' not found on PATH. Install Python 3.10+ or pass -Python <path>."
    exit 1
}

& $Python -c "import fastapi, uvicorn, multipart" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[backend] Installing backend requirements (backend/requirements.txt) ..."
    & $Python -m pip install -r (Join-Path $ProjectRoot "backend\requirements.txt")
    if ($LASTEXITCODE -ne 0) { Write-Error "pip install failed"; exit 1 }
}

if ($CacheDir) {
    $env:IDV_CACHE_DIR = $CacheDir
    Write-Host "[backend] IDV_CACHE_DIR = $CacheDir"
}

$uvArgs = @("-m", "uvicorn", "app.main:app", "--app-dir", "backend", "--host", $BindHost, "--port", "$Port")
if ($Reload) { $uvArgs += @("--reload", "--reload-dir", "backend/app") }

Write-Host "[backend] Project root : $ProjectRoot"
Write-Host "[backend] API          : http://${BindHost}:$Port/api/health"
Write-Host "[backend] Command      : $Python $($uvArgs -join ' ')"
& $Python @uvArgs
exit $LASTEXITCODE
