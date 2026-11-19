# Web (PC): Bing searches and Rewards tasks in Edge, one profile after
# another. Add --visible to any run to show the Edge windows.

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]
set working-directory := ".."

tsx := "node node_modules/tsx/dist/cli.mjs"

# List the web commands.
[private]
default:
    @just --list web

# Interactive: choose "once at a date/time", "daily at HH:MM", or "now".
# Example: just web run
#          just web run --visible
#          just web run 10:00
[doc("Ask when to run: now, once at a time, or daily")]
run *flags:
    {{tsx}} src/app.ts {{flags}}

# Start now.
# Example: just web now
#          just web now --visible
[doc("Run the web tasks now")]
now *flags:
    {{tsx}} src/app.ts --now {{flags}}

# Run once at a date and time.
# Example: just web at "2026-11-12 13:00"
[doc("Run once at a date and time")]
at time *flags:
    {{tsx}} src/app.ts --at "{{time}}" {{flags}}

# Run every day at a time.
# Example: just web daily 00:01
[doc("Run every day at a time")]
daily time *flags:
    {{tsx}} src/app.ts --daily "{{time}}" {{flags}}

# Open the profiles in plain Edge windows at Rewards → Redeem, run no task
# (to redeem points by hand). No argument: every profile in PROFILES.
# Example: just web preview
#          just web preview "Profile 5"
#          just web preview nunung.ptv@gmail.com "Profile 7"
[doc("Open profiles at Rewards → Redeem, run no task")]
preview *targets:
    {{tsx}} src/app.ts --preview {{targets}}

# Fix "belum login rewards": open the Selenium copy of a profile in a
# normal Edge window at rewards.bing.com, sign in yourself, close it.
# Example: just web login                     (profiles and their accounts)
#          just web login "Profile 65"
#          just web login nunung.ptv@gmail.com
[doc("Sign a profile copy in to Rewards again")]
login *args:
    {{tsx}} src/scripts/login.ts {{args}}
