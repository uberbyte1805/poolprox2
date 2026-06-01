# PoolProx2 installer for Windows
#
# One-command install (PowerShell):
#   irm https://raw.githubusercontent.com/uberbyte1805/poolprox2/main/install.ps1 | iex
#
# Or, after cloning:
#   powershell -ExecutionPolicy Bypass -File install.ps1

#Requires -Version 5.1

$ErrorActionPreference = "Stop"

$RepoUrl     = if ($env:POOLPROX_REPO) { $env:POOLPROX_REPO } else { "https://github.com/uberbyte1805/poolprox2.git" }
$DefaultDir  = if ($env:POOLPROX_HOME) { $env:POOLPROX_HOME } else { Join-Path $HOME "poolprox2" }

function Step([string]$msg) { Write-Host "==> " -ForegroundColor Cyan -NoNewline; Write-Host $msg -ForegroundColor White }
function Info([string]$msg) { Write-Host "    $msg" }
function Warn([string]$msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "xx  $msg" -ForegroundColor Red; exit 1 }
function Ok  ([string]$msg) { Write-Host "ok  " -ForegroundColor Green -NoNewline; Write-Host $msg }

function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

function Add-PathOnce([string]$dir) {
  if (-not (Test-Path $dir)) { return }
  if (-not ($env:Path -split ';' | Where-Object { $_ -eq $dir })) {
    $env:Path = "$dir;$env:Path"
  }
}

function Ensure-Git {
  if (Have git) { return }
  Step "Installing Git"
  if (Have winget) {
    winget install --id Git.Git --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } elseif (Have scoop) {
    scoop install git | Out-Null
  } elseif (Have choco) {
    choco install -y git | Out-Null
  } else {
    Fail "Install Git manually from https://git-scm.com/download/win and re-run this script"
  }
  Add-PathOnce "$env:ProgramFiles\Git\cmd"
  if (-not (Have git)) { Fail "git is still not on PATH. Open a new PowerShell window and re-run." }
  Ok "Git installed"
}

function Ensure-Bun {
  if (Have bun) { return }
  Step "Installing Bun"
  try {
    powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex" | Out-Null
  } catch {
    Fail "Bun install failed: $_"
  }
  Add-PathOnce (Join-Path $HOME ".bun\bin")
  if (-not (Have bun)) {
    Warn "Bun installed but not on PATH yet. Open a new PowerShell and re-run this installer."
    exit 1
  }
  Ok "Bun $(bun --version) installed"
}

function Ensure-Python {
  $script:PythonBin = $null
  foreach ($cand in @("python3.12","python3.11","python3.10","python","python3")) {
    if (Have $cand) {
      try {
        $ver = & $cand -c "import sys;print('%d.%d'%sys.version_info[:2])"
        $parts = $ver.Trim().Split('.')
        if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 10) {
          $script:PythonBin = $cand
          return
        }
      } catch {}
    }
  }
  Step "Installing Python 3.11"
  if (Have winget) {
    winget install --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } elseif (Have scoop) {
    scoop install python | Out-Null
  } elseif (Have choco) {
    choco install -y python | Out-Null
  } else {
    Fail "Install Python 3.10+ manually from https://python.org and re-run"
  }
  if (Have python) { $script:PythonBin = "python" }
  elseif (Have python3) { $script:PythonBin = "python3" }
  else {
    Warn "Python installed but not on PATH yet. Open a new PowerShell and re-run."
    exit 1
  }
  Ok "Python $(& $script:PythonBin --version) installed"
}

function Clone-Or-Update-Repo {
  $script:ProjectDir = $null
  if (Test-Path "package.json") {
    $pkg = Get-Content "package.json" -Raw
    if ($pkg -match '"name"\s*:\s*"poolprox2"') {
      $script:ProjectDir = (Get-Location).Path
      Step "Using existing checkout: $($script:ProjectDir)"
      if (Test-Path ".git") {
        try { git pull --ff-only | Out-Null } catch { Warn "git pull failed (continuing)" }
      }
      return
    }
  }

  if (Test-Path (Join-Path $DefaultDir ".git")) {
    $script:ProjectDir = $DefaultDir
    Step "Updating existing checkout at $($script:ProjectDir)"
    Push-Location $script:ProjectDir
    try { git pull --ff-only | Out-Null } catch { Warn "git pull failed" }
    finally { Pop-Location }
  } else {
    $script:ProjectDir = $DefaultDir
    Step "Cloning $RepoUrl -> $($script:ProjectDir)"
    git clone --depth=1 $RepoUrl $script:ProjectDir
  }
  Set-Location $script:ProjectDir
}

function Write-EnvIfMissing {
  Step "Configuring .env"
  if (Test-Path ".env") { Info ".env already exists, leaving untouched"; return }
  Copy-Item ".env.example" ".env"

  $bytes = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

  (Get-Content ".env") -replace '^ENCRYPTION_KEY=.*', "ENCRYPTION_KEY=$key" | Set-Content ".env"
  Ok "Generated random ENCRYPTION_KEY"

  $venvPython = "./scripts/auth/.venv/Scripts/python.exe"
  (Get-Content ".env") -replace '^PYTHON_PATH=.*', "PYTHON_PATH=$venvPython" | Set-Content ".env"
}

function Install-NodeDeps {
  Step "Installing JS dependencies (bun install)"
  bun install --silent
  Push-Location "dashboard"
  try { bun install --silent } finally { Pop-Location }
  Ok "JS dependencies installed"
}

function Setup-PythonVenv {
  Step "Setting up Python venv at scripts\auth\.venv"
  $venv = "scripts\auth\.venv"
  if (-not (Test-Path $venv)) {
    & $script:PythonBin -m venv $venv
  }
  $venvPip = Join-Path $venv "Scripts\pip.exe"
  $venvPy  = Join-Path $venv "Scripts\python.exe"
  & $venvPip install --upgrade pip wheel | Out-Null
  & $venvPip install -r scripts\auth\requirements.txt
  Ok "Python deps installed"

  Step "Installing Playwright + Camoufox browsers (this can take a few minutes)"
  try { & $venvPy -m playwright install chromium | Out-Null } catch { Warn "Playwright Chromium install failed (re-run later)" }
  try { & $venvPy -m camoufox fetch | Out-Null }              catch { Warn "Camoufox fetch failed (re-run later)" }
  Ok "Browsers ready"
}

function Build-Dashboard {
  Step "Building dashboard (production)"
  Push-Location "dashboard"
  try { bun run build } catch { Pop-Location; Fail "Dashboard build failed" }
  Pop-Location
  Ok "Dashboard built"
}

function Get-ComposeCmd {
  # Returns "docker compose", "docker-compose", or $null.
  if ((Have docker) -and (docker compose version 2>$null)) { return "docker compose" }
  if (Have docker-compose) { return "docker-compose" }
  return $null
}

function Test-DbIsLocal {
  # True if DATABASE_URL in .env points at localhost / 127.0.0.1.
  if (-not (Test-Path ".env")) { return $false }
  $line = Select-String -Path ".env" -Pattern '^DATABASE_URL=' | Select-Object -First 1
  if (-not $line) { return $false }
  return ($line.Line -match '@(localhost|127\.0\.0\.1)[:/]')
}

function Ensure-Database {
  Step "Provisioning database"

  if (-not (Test-DbIsLocal)) {
    Info "DATABASE_URL points at a remote host -- skipping auto-provision."
    return
  }

  $dc = Get-ComposeCmd
  if ($dc -and (Test-Path "docker-compose.yml")) {
    Info "Starting PostgreSQL via Docker Compose..."
    try {
      Invoke-Expression "$dc up -d db" | Out-Null
      Info "Waiting for database to become healthy..."
      for ($i = 0; $i -lt 30; $i++) {
        $ready = Invoke-Expression "$dc exec -T db pg_isready -U postgres" 2>$null
        if ($LASTEXITCODE -eq 0) { Ok "PostgreSQL is ready (Docker)"; return }
        Start-Sleep -Seconds 2
      }
      Warn "Database did not report healthy in time -- migrations may fail."
      return
    } catch {
      Warn "Docker Compose failed to start the DB. Falling back to native PostgreSQL."
    }
  }

  if (Have pg_isready) {
    & pg_isready -q 2>$null
    if ($LASTEXITCODE -eq 0) {
      if (Have createdb) {
        & createdb pool_proxy 2>$null
        if ($LASTEXITCODE -eq 0) { Ok "Created database 'pool_proxy'" }
        else { Info "Database 'pool_proxy' already exists or could not be created." }
      }
      Ok "Native PostgreSQL is running"
      return
    }
  }

  Warn "No Docker and no running PostgreSQL found."
  Info "Install Docker Desktop (recommended) then re-run, or start PostgreSQL manually."
  Info "  Docker:  https://docs.docker.com/desktop/install/windows-install/"
  Info "  Native:  ensure PostgreSQL is running and 'createdb pool_proxy'"
}

function Run-Migrations {
  Step "Running database migrations"
  try {
    bun src/db/migrate.ts
    Ok "Migrations applied"
  } catch {
    Warn "Migrations failed. Make sure PostgreSQL is running and DATABASE_URL in .env is correct."
    Info "After fixing, run: bun run migrate"
  }
}

function Main {
  Write-Host ""
  Write-Host "PoolProx2 Installer (Windows)" -ForegroundColor Blue
  Write-Host ""

  Ensure-Git
  Ensure-Bun
  Ensure-Python
  Clone-Or-Update-Repo

  Set-Location $script:ProjectDir
  Write-EnvIfMissing
  Install-NodeDeps
  Setup-PythonVenv
  Build-Dashboard
  Ensure-Database
  Run-Migrations

  Write-Host ""
  Write-Host "Done. PoolProx2 is installed at $($script:ProjectDir)" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  1. Edit .env if needed:"
  Write-Host "       notepad $($script:ProjectDir)\.env"
  Write-Host "  2. Make sure PostgreSQL is running and DATABASE_URL in .env points to a reachable DB."
  Write-Host "  3. Start the server:"
  Write-Host "       cd $($script:ProjectDir)"
  Write-Host "       .\poolprox.ps1 start    (or: bun start)"
  Write-Host "  4. Open the dashboard:"
  Write-Host "       http://localhost:1631"
  Write-Host ""
  Write-Host "Re-run this installer any time to pull updates and rebuild."
}

Main
