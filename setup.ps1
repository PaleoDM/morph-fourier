# Morph-Fourier - one-time setup (Windows). Mirrors setup.command.
# Creates the Python venv, installs dependencies, downloads the SAM model, and
# builds the frontend so launching later needs no Node. Safe to re-run.
# Invoked by setup.bat (which bypasses the PowerShell execution policy).

$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $AppDir

Write-Host "============================================="
Write-Host "  Morph-Fourier - Setup"
Write-Host "============================================="
Write-Host "App dir: $AppDir`n"

# --- [1/4] Backend Python ---
Write-Host "[1/4] Backend Python environment ..."
$pyExe = $null; $pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($t in @('-3.13', '-3.12', '-3.11', '-3.10')) {
        $v = & py $t -c "import sys;print('{}.{}'.format(*sys.version_info[:2]))" 2>$null
        if ($LASTEXITCODE -eq 0 -and $v -match '^3\.(1[0-3])$') { $pyExe = 'py'; $pyArgs = @($t); break }
    }
}
if (-not $pyExe) {
    foreach ($e in @('python', 'python3')) {
        if (Get-Command $e -ErrorAction SilentlyContinue) {
            $v = & $e -c "import sys;print('{}.{}'.format(*sys.version_info[:2]))" 2>$null
            if ($LASTEXITCODE -eq 0 -and $v -match '^3\.(1[0-3])$') { $pyExe = $e; $pyArgs = @(); break }
        }
    }
}
if (-not $pyExe) {
    Write-Host "ERROR: Need Python 3.10, 3.11, 3.12, or 3.13."
    Write-Host "       Install from https://www.python.org/downloads/ and tick 'Add python.exe to PATH'."
    exit 1
}
Write-Host "   Using $pyExe $($pyArgs -join ' ')"

if (-not (Test-Path "backend\.venv")) {
    & $pyExe @pyArgs -m venv "backend\.venv"
}
$venvPy = Join-Path $AppDir "backend\.venv\Scripts\python.exe"
& $venvPy -m pip install --upgrade pip --quiet
& $venvPy -m pip install -r "backend\requirements.txt" --quiet
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: pip install failed."; exit 1 }
Write-Host "   OK - backend dependencies installed."

# --- [2/4] SAM weights ---
Write-Host "`n[2/4] Segment Anything model weights ..."
$weightsFile = "backend\models\sam_vit_b_01ec64.pth"
$url = "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth"
$expected = 375042383
New-Item -ItemType Directory -Force -Path "backend\models" | Out-Null
if ((Test-Path $weightsFile) -and ((Get-Item $weightsFile).Length -eq $expected)) {
    Write-Host "   OK - already present."
} else {
    Write-Host "   Downloading (~375 MB) ..."
    $ProgressPreference = 'SilentlyContinue'  # otherwise Invoke-WebRequest is very slow for big files
    Invoke-WebRequest -Uri $url -OutFile $weightsFile
}

# --- [3/4] Frontend (build now so launching needs no Node) ---
Write-Host "`n[3/4] Frontend ..."
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host "   Using node $(node --version)"
    Push-Location frontend
    npm install --silent
    npm run build | Out-Null
    Pop-Location
    Write-Host "   OK - frontend built."
} elseif (Test-Path "frontend\dist\index.html") {
    Write-Host "   OK - Node not found, but a pre-built frontend is bundled - using it."
} else {
    Write-Host "ERROR: Node.js is not installed and no pre-built frontend was found."
    Write-Host "       Install Node LTS from https://nodejs.org/ and re-run."
    exit 1
}

# --- [4/4] Verify ---
Write-Host "`n[4/4] Verifying ..."
& $venvPy -c "import fastapi, torch, numpy, cv2, skimage, segment_anything, PIL, pyefd, sklearn"
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: backend import verification failed."; exit 1 }
Write-Host "   OK - backend imports."
if (-not (Test-Path "frontend\dist\index.html")) { Write-Host "ERROR: frontend bundle missing."; exit 1 }
Write-Host "   OK - frontend bundle present."

Write-Host "`n============================================="
Write-Host "  Setup complete!"
Write-Host "============================================="
Write-Host "`nTo launch: double-click  run.bat  (it opens in your browser)."
