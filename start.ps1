$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:NEXT_TELEMETRY_DISABLED = '1'
$env:UV_LINK_MODE = 'copy'
$env:UV_HTTP_TIMEOUT = '120'
$root = $PSScriptRoot

foreach ($command in @('node', 'npm.cmd', 'uv')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "$command is required. Install Node.js 22+ and uv, then run this script again."
    }
}

Push-Location -LiteralPath $root
try {
    & node (Join-Path $root 'scripts/dev.mjs') --check
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Startup cancelled: ports 3000 or 8010 are occupied.' -ForegroundColor Yellow
        Write-Host 'If NeuroLens is already running, open http://127.0.0.1:3000 or close its previous startup window before starting again.'
        Write-Host 'Existing services are preserved; dependencies were not changed.'
        exit 1
    }
    Write-Host '[1/4] Checking locked frontend dependencies...'
    $lockHash = (Get-FileHash -LiteralPath (Join-Path $root 'package-lock.json') -Algorithm SHA256).Hash
    $stamp = Join-Path $root 'node_modules/.neurolens-lock.sha256'
    $nextCli = Join-Path $root 'node_modules/next/dist/bin/next'
    $installed = (Test-Path -LiteralPath $stamp) -and (Test-Path -LiteralPath $nextCli)
    if ($installed) { $installed = ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $lockHash) }
    if (-not $installed) {
        & npm.cmd ci --no-audit --no-fund --prefer-offline
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
        Set-Content -LiteralPath $stamp -Value $lockHash -Encoding ASCII
    }
    else {
        Write-Host 'Using verified installed frontend dependencies.'
    }

    Write-Host '[2/4] Preparing isolated Python 3.12 environment...'
    & uv sync --frozen --project (Join-Path $root 'backend') --python 3.12
    if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }

    Write-Host '[3/4] Verifying pinned open-source model weights...'
    & (Join-Path $root 'backend/.venv/Scripts/python.exe') (Join-Path $root 'scripts/prepare_model.py')
    if ($LASTEXITCODE -ne 0) { throw 'Model preparation failed. No unverified or simulated model is used.' }

    Write-Host '[4/4] Starting NeuroLens at http://127.0.0.1:3000'
    & node (Join-Path $root 'scripts/dev.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'A local service stopped unexpectedly. Read the errors above.' }
}
finally {
    Pop-Location
}
