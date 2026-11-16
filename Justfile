# On Windows, run recipes in PowerShell instead of requiring `sh` (Git Bash).
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Recipes call tsx through node directly, so they keep working even when the
# global `pnpm` command is broken (they only need node_modules installed).
tsx := "node node_modules/tsx/dist/cli.mjs"

# Install deps, create driver folder and .env (keeps an existing .env).
[windows]
setup:
    npm install
    New-Item -ItemType Directory -Force -Path driver/stable | Out-Null
    if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env - fill it in before running." } else { Write-Host ".env already exists, left unchanged." }

[unix]
setup:
    npm install
    mkdir -p driver/stable
    if [ ! -f .env ]; then cp .env.example .env; echo "Created .env - fill it in before running."; else echo ".env already exists, left unchanged."; fi

# Interactive: choose "once at a date/time", "daily at HH:MM", or "now".
# A time also works: `just run 10:00` runs once at 10:00.
run *args:
    {{tsx}} src/app.ts {{args}}

# Run immediately.
run-now:
    {{tsx}} src/app.ts --now

# Run once at a specific date and time.
# Example: just run-at "2026-11-12 13:00"
run-at time:
    {{tsx}} src/app.ts --at "{{time}}"

# Run every day at a specific time.
# Example: just run-daily "00:01"
run-daily time:
    {{tsx}} src/app.ts --daily "{{time}}"

# Generate harmless English keywords into src/data/keywords.txt.
# Uses search autocomplete (Google, then Bing); falls back to local
# templates when offline. The old file is kept as keywords.backup.txt.
# Example: just keyword 500
#          just keyword 300 --offline
keyword count="500" *flags:
    {{tsx}} src/scripts/generate-keywords.ts {{count}} {{flags}}

# Download the msedgedriver matching the installed Edge into
# driver/stable/<version>/ and point EDGE_DRIVER_PATH in .env at it.
# Example: just update-driver
#          just update-driver --latest
#          just update-driver --version 157.0.4341.60
update-driver *flags:
    {{tsx}} src/scripts/update-driver.ts {{flags}}

# Type-check the project.
typecheck:
    node node_modules/typescript/bin/tsc --noEmit
