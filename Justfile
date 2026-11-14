# On Windows, run recipes in PowerShell instead of requiring `sh` (Git Bash).
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Install deps, create driver folder and .env (keeps an existing .env), build.
[windows]
setup:
    pnpm install
    New-Item -ItemType Directory -Force -Path driver/stable | Out-Null
    if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env - fill it in before running." } else { Write-Host ".env already exists, left unchanged." }
    pnpm build

[unix]
setup:
    pnpm install
    mkdir -p driver/stable
    if [ ! -f .env ]; then cp .env.example .env; echo "Created .env - fill it in before running."; else echo ".env already exists, left unchanged."; fi
    pnpm build

# Start now, or at a set time: `just run 10:00`
run at="":
    pnpm dev {{at}}
