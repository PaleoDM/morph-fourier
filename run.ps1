# Morph-Fourier - launch (Windows). Mirrors run-prod.command.
# Runs setup on first launch, serves the app on :8000, and opens your browser.
# Invoked by run.bat (which bypasses the PowerShell execution policy).

$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $AppDir

$venvPy = Join-Path $AppDir "backend\.venv\Scripts\python.exe"

# First launch (or incomplete install) - set up automatically.
if ((-not (Test-Path $venvPy)) -or (-not (Test-Path "frontend\dist\index.html"))) {
    Write-Host "First launch - running setup (this can take a few minutes) ...`n"
    & (Join-Path $AppDir "setup.ps1")
    Write-Host ""
}

Write-Host "============================================="
Write-Host "  Morph-Fourier"
Write-Host "============================================="
Write-Host "  Opening http://localhost:8000 in your browser ..."
Write-Host "  Keep this window open while you work. Close it to quit."
Write-Host "============================================="
Write-Host ""

# Open the browser once the server is accepting connections (background job).
Start-Job -ScriptBlock {
    for ($i = 0; $i -lt 120; $i++) {
        try {
            Invoke-WebRequest -UseBasicParsing "http://localhost:8000/api/health" -TimeoutSec 2 | Out-Null
            Start-Process "http://localhost:8000"
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
} | Out-Null

# `python -m uvicorn` (not the bare console script) so the launcher keeps working
# even if the folder is moved after setup.
& $venvPy -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir "backend/src"
