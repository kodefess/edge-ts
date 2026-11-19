# Desktop (Microsoft Rewards app for Windows): one saved sign-in per
# account, swapped into the app; the weekly desktop-app quest. Saved
# sign-ins live in %LOCALAPPDATA%\edge-ts\desktop-profiles (never the repo).

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]
set working-directory := ".."

tsx := "node node_modules/tsx/dist/cli.mjs"

# App status and saved profiles (▶ = the one in the app).
[doc("App status and saved profiles")]
status:
    {{tsx}} src/scripts/desktop.ts status

# Weekly quest on every saved profile; the app window stays offscreen.
# Example: just desktop run
#          just desktop run --accounts "a@gmail.com,b@gmail.com"
#          just desktop run --dry-run
#          just desktop run --visible
[doc("Weekly quest on every saved profile (offscreen)")]
run *flags:
    {{tsx}} src/scripts/desktop.ts run {{flags}}

# Add an account: empties the app and opens it; sign in, then `save`.
# Example: just desktop new you@example.com
[doc("Add an account: empty the app to sign in")]
new name:
    {{tsx}} src/scripts/desktop.ts new "{{name}}"

# Keep the account signed in to the app as a profile.
# Example: just desktop save you@example.com
[doc("Save the account signed in to the app")]
save name:
    {{tsx}} src/scripts/desktop.ts save "{{name}}"

# Put a saved account in the app and open it.
# Example: just desktop use you@example.com
[doc("Put a saved account in the app and open it")]
use name *flags:
    {{tsx}} src/scripts/desktop.ts use "{{name}}" {{flags}}

# Sessions kept in _backup and the account in each.
[doc("Sessions kept in _backup")]
backups:
    {{tsx}} src/scripts/desktop.ts backups

# Turn a backed-up session into a profile (an account signed in but never saved).
# Example: just desktop restore bsmnt002@gmail.com
[doc("Restore a backed-up session as a profile")]
restore name *flags:
    {{tsx}} src/scripts/desktop.ts restore "{{name}}" {{flags}}

# Open the app.
[doc("Open the app")]
open:
    {{tsx}} src/scripts/desktop.ts open

# Close the app.
[doc("Close the app")]
close:
    {{tsx}} src/scripts/desktop.ts close
