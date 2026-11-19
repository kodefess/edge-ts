# Mobile (Android phone): check in, More activities and Read to Earn in the
# Bing app, for every account on the phone.

set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]
set working-directory := ".."

tsx := "node node_modules/tsx/dist/cli.mjs"

# List the mobile commands.
[private]
default:
    @just --list mobile

# Every account on the phone, one after another. Starts Appium itself.
# Example: just mobile run
#          just mobile run --list
#          just mobile run --accounts "a@gmail.com,b@gmail.com" --count 5
#          just mobile run --dry-run
[doc("Every account on the phone (check in, activities, read to earn)")]
run *flags:
    {{tsx}} src/scripts/mobile-run.ts {{flags}}

# Wireless adb, so the phone needs no USB cable (same Wi-Fi as the PC).
# Example: just mobile wifi            status
#          just mobile wifi usb        cable plugged in once → Wi-Fi
#          just mobile wifi pair       Android 11+ Wireless debugging, no cable
#          just mobile wifi connect    reconnect (saved address or mDNS)
#          just mobile wifi off        disconnect
[doc("Wireless adb: status, usb, pair, connect, off")]
wifi *args:
    {{tsx}} src/scripts/mobile-wifi.ts {{args}}

# Read to Earn on the active phone account only (no account switching).
# Example: just mobile news
#          just mobile news --count 3 --dwell-min 10
#          just mobile news --dry-run
#          just mobile news --from-xml "$env:TEMP\edgets-app.xml"
[doc("Read to Earn on the active phone account only")]
news *flags:
    {{tsx}} src/scripts/mobile-news.ts {{flags}}

# Dump the Bing app screen through Appium (debugging selectors).
# Example: just mobile inspect
#          just mobile inspect --tap Rewards
[doc("Dump the Bing app screen (debugging)")]
inspect *flags:
    {{tsx}} src/scripts/mobile-inspect.ts {{flags}}

# Install Appium and the uiautomator2 driver (the client is built in).
[doc("Install Appium and the uiautomator2 driver")]
setup:
    npm install -g appium
    appium driver install uiautomator2

# Run the Appium server by hand (`just mobile run` starts it itself).
# uiautomator2 needs ANDROID_HOME pointing at a folder that contains
# platform-tools; when it is unset this picks the Android Studio SDK or the
# Chocolatey adb package.
[doc("Run the Appium server by hand")]
server:
    $h = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, "$env:LOCALAPPDATA\Android\Sdk", 'C:\ProgramData\chocolatey\lib\adb\tools') | Where-Object { $_ -and (Test-Path (Join-Path $_ 'platform-tools\adb.exe')) } | Select-Object -First 1; if ($h) { $env:ANDROID_HOME = $h; Write-Host "ANDROID_HOME=$h" } else { Write-Warning 'platform-tools tidak ditemukan; set ANDROID_HOME ke folder Android SDK' }; appium

# Edge with a phone profile (emulation): check what the page sees.
# Example: just mobile web-test "Profile 1"
#          just mobile web-test "Profile 1" --device galaxy_s23 --visible
[doc("Edge phone emulation: check what the page sees")]
web-test profile *flags:
    {{tsx}} src/scripts/mobile-test.ts --profile "{{profile}}" {{flags}}

# Edge with a phone profile (emulation): read a few MSN articles.
# Example: just mobile web-news "Profile 1"
#          just mobile web-news "Profile 1" --count 2 --visible
[doc("Edge phone emulation: read a few MSN articles")]
web-news profile *flags:
    {{tsx}} src/scripts/mobile-web-news.ts --profile "{{profile}}" {{flags}}
