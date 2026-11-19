# On Windows, run recipes in PowerShell instead of requiring `sh` (Git Bash).
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

# Commands per platform:
#   just web …       Bing searches and Rewards tasks in Edge
#   just mobile …    Bing app on the Android phone
#   just desktop …   Microsoft Rewards app for Windows
# `just web`, `just mobile` list their commands; `just desktop` shows status.

# Recipes call tsx through node directly, so they keep working even when the
# global `pnpm` command is broken (they only need node_modules installed).
tsx := "node node_modules/tsx/dist/cli.mjs"

mod web "just/web.just"
mod mobile "just/mobile.just"
mod desktop "just/desktop.just"

# List every command.
[private]
default:
    @just --list --list-submodules

# Install deps, create driver folder and .env (keeps an existing .env).
[windows]
[doc("Install dependencies, create .env, prepare the driver folder")]
setup:
    npm install
    New-Item -ItemType Directory -Force -Path driver/stable | Out-Null
    if (-not (Test-Path .env)) { Copy-Item .env.example .env; Write-Host "Created .env - fill it in before running." } else { Write-Host ".env already exists, left unchanged." }

[unix]
[doc("Install dependencies, create .env, prepare the driver folder")]
setup:
    npm install
    mkdir -p driver/stable
    if [ ! -f .env ]; then cp .env.example .env; echo "Created .env - fill it in before running."; else echo ".env already exists, left unchanged."; fi

# Install the Node dependencies only.
[doc("Install the Node dependencies only")]
install:
    npm install

# Status of every account across the tasks, read from the phone (it holds
# the accounts of both PCs): web search + daily set, check in, read to
# earn, more activities, daily points (cap 120), total. Read-only.
# Example: just recap
#          just recap --accounts "a@gmail.com,b@gmail.com"
#          just recap --json
[doc("Status of every account across all tasks (read-only)")]
recap *flags:
    {{tsx}} src/scripts/recap.ts {{flags}}

# Generate harmless English keywords into src/data/keywords.txt.
# Uses search autocomplete (Google, then Bing); falls back to local
# templates when offline. The old file is kept as keywords.backup.txt.
# Example: just keyword 500
#          just keyword 300 --offline
[doc("Regenerate src/data/keywords.txt")]
keyword count="500" *flags:
    {{tsx}} src/scripts/generate-keywords.ts {{count}} {{flags}}

# Download the msedgedriver matching the installed Edge into
# driver/stable/<version>/ and point EDGE_DRIVER_PATH in .env at it.
# Example: just update-driver
#          just update-driver --latest
#          just update-driver --version 157.0.4341.60
[doc("Download the msedgedriver matching Edge")]
update-driver *flags:
    {{tsx}} src/scripts/update-driver.ts {{flags}}

# Type-check the project.
[doc("Type-check the project")]
typecheck:
    node node_modules/typescript/bin/tsc --noEmit
