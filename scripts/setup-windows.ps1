# Claude Remote Terminal - Windows Setup
# Run with: powershell -ExecutionPolicy Bypass -File setup-windows.ps1

Write-Host "Claude Remote Terminal - Windows Setup" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
try {
    $nodeVersion = node -v
    $majorVersion = [int]($nodeVersion -replace 'v(\d+)\..*', '$1')
    if ($majorVersion -lt 20) {
        Write-Host "ERROR: Node.js 20+ is required. Found version $nodeVersion" -ForegroundColor Red
        exit 1
    }
    Write-Host "✓ Node.js $nodeVersion found" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js is not installed." -ForegroundColor Red
    Write-Host "Please install Node.js 20+ from https://nodejs.org/"
    exit 1
}

# Check for npm
try {
    $npmVersion = npm -v
    Write-Host "✓ npm $npmVersion found" -ForegroundColor Green
} catch {
    Write-Host "ERROR: npm is not installed." -ForegroundColor Red
    exit 1
}

# Check Windows version for ConPTY support
$osVersion = [System.Environment]::OSVersion.Version
$build = $osVersion.Build
if ($build -lt 17763) {
    Write-Host ""
    Write-Host "WARNING: Windows build $build detected." -ForegroundColor Yellow
    Write-Host "ConPTY support requires Windows 10 build 17763 (version 1809) or later."
    Write-Host "Terminal functionality may be limited."
    Write-Host ""
} else {
    Write-Host "✓ Windows build $build (ConPTY supported)" -ForegroundColor Green
}

# Check for Tailscale
$tailscaleInstalled = $false
try {
    $null = Get-Command tailscale -ErrorAction Stop
    $tailscaleInstalled = $true
    Write-Host "✓ Tailscale found" -ForegroundColor Green

    # Check if Tailscale is running
    try {
        $status = tailscale status --json | ConvertFrom-Json
        if ($status.Self.HostName) {
            $hostname = $status.Self.HostName
            $tailnet = $status.MagicDNSSuffix -replace '^\.'
            Write-Host "  Connected as: $hostname.$tailnet" -ForegroundColor Gray
        }
    } catch {
        Write-Host "  Tailscale is not connected. Run 'tailscale up' to connect." -ForegroundColor Yellow
    }
} catch {
    Write-Host ""
    Write-Host "WARNING: Tailscale is not installed." -ForegroundColor Yellow
    Write-Host "The server will run in local mode without Tailscale auth."
    Write-Host "Install Tailscale from https://tailscale.com/download"
    Write-Host ""
}

# Check for Visual Studio Build Tools (needed for node-pty)
Write-Host ""
Write-Host "Checking for build tools..." -ForegroundColor Gray
Write-Host "Note: node-pty requires Visual Studio Build Tools or Visual Studio with C++ workload."
Write-Host "If npm install fails, install from: https://visualstudio.microsoft.com/visual-cpp-build-tools/"
Write-Host ""

Write-Host "Installing dependencies..." -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: npm install failed." -ForegroundColor Red
    Write-Host "If you see errors about node-pty, you may need to install:"
    Write-Host "  1. Visual Studio Build Tools (with C++ workload)"
    Write-Host "  2. Python 3.x"
    Write-Host ""
    Write-Host "Then run: npm install --force"
    exit 1
}

Write-Host ""
Write-Host "Building project..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Build failed." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "To start the server:" -ForegroundColor Cyan
Write-Host "  npm run dev    (development mode)"
Write-Host "  npm start      (production mode)"
Write-Host ""
Write-Host "The server will be available at:" -ForegroundColor Cyan
Write-Host "  http://localhost:3000"

if ($tailscaleInstalled) {
    try {
        $status = tailscale status --json | ConvertFrom-Json
        if ($status.Self.HostName) {
            $hostname = $status.Self.HostName
            $tailnet = $status.MagicDNSSuffix -replace '^\.'
            Write-Host "  https://$hostname.$($tailnet):3000 (Tailscale)"
        }
    } catch {}
}
