# edge-ts

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10%2B-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![Selenium](https://img.shields.io/badge/Selenium-WebDriver-43B02A?logo=selenium&logoColor=white)](https://www.selenium.dev/)
[![Microsoft Edge](https://img.shields.io/badge/Microsoft-Edge-0078D7?logo=microsoftedge&logoColor=white)](https://www.microsoft.com/edge)

Automated browser searches with **TypeScript**, **Selenium WebDriver** and Microsoft Edge, run across several Edge profiles one after another. It runs immediately, once at a set time, or every day. Feature-for-feature port of [edge-py](https://github.com/kodefess/edge-py).

```
  ███████╗██████╗  ██████╗ ███████╗      ████████╗███████╗
  ██╔════╝██╔══██╗██╔════╝ ██╔════╝      ╚══██╔══╝██╔════╝
  █████╗  ██║  ██║██║  ███╗█████╗  █████╗   ██║   ███████╗
  ██╔══╝  ██║  ██║██║   ██║██╔══╝  ╚════╝   ██║   ╚════██║
  ███████╗██████╔╝╚██████╔╝███████╗         ██║   ███████║
  ╚══════╝╚═════╝  ╚═════╝ ╚══════╝         ╚═╝   ╚══════╝
```

## Features

- **Multiple profiles.** Each Edge profile is copied into a separate Selenium folder, so the Edge you use every day is never touched. (Leave `ORIGINAL_USER_DATA_DIR` empty to use profiles straight from `SELENIUM_USER_DATA_DIR` instead.)
- **Bing Rewards in a second tab.** For every profile it opens `rewards.bing.com`, completes the daily set, the image-search task, your perks and the "Keep earning" list on `/earn`, and after the searches claims every point that is ready.
- **Human-like typing, short delays.** Each search is typed character by character (50–200 ms per key), submitted, given 5 seconds to load, and the next search starts from the search page. Profiles are 10–20 seconds apart.
- **Scheduling.** Run now, once at a date and time, or every day at a fixed time.
- **Plain-text keywords.** Keywords live in `src/data/keywords.txt`, one per line. A generator fills this file with harmless English queries.
- **Driver updater.** `just update-driver` downloads the msedgedriver that matches your Edge.
- **Clear terminal output.** You can see which profile is searching, each search as it happens, a recap at the end of each profile, and a session recap that lists every failed search.

## Requirements

- Windows with Microsoft Edge
- [Node.js](https://nodejs.org/) 20 or newer and [pnpm](https://pnpm.io/)
- [just](https://just.systems/) (optional, for the short commands below)

## Setup

```bash
just setup
```

This installs the dependencies, creates `.env` from `.env.example` (an existing `.env` is left untouched), and creates `driver/stable/`. Then:

1. Run `just update-driver` to download the msedgedriver that matches your Edge (see [Updating the driver](#updating-the-driver)).
2. Open `.env` and set at least `SELENIUM_USER_DATA_DIR` and `PROFILES` (and `ORIGINAL_USER_DATA_DIR` to copy profiles).

To find a profile's folder name, open `edge://version` in that profile and look at **Profile path**. The last part, such as `Default` or `Profile 3`, is the name to put in `PROFILES`.

## Configuration (`.env`)

| Variable | Default | Description |
|---|---|---|
| `EDGE_DRIVER_PATH` | — | Path to msedgedriver. A directory or glob also works. |
| `SEARCH_URL` | `https://www.bing.com` | Search page to use. |
| `ORIGINAL_USER_DATA_DIR` | — | Your live Edge `User Data` folder. Only read, to copy profiles. Optional. |
| `SELENIUM_USER_DATA_DIR` | — | Folder Selenium uses. With `ORIGINAL_USER_DATA_DIR` set it **must not** be the live Edge folder. |
| `PROFILES` | — | Comma-separated profile folder names, e.g. `Default,Profile 2,Profile 5`. |
| `SEARCHES_PER_PROFILE` | `30` | Number of searches per profile. |
| `CLOSE_EXISTING_EDGE` | `true` | Close **all** running Edge windows before a session, since Edge locks profile folders. |
| `PAGE_LOAD_TIMEOUT` | `30` | Maximum seconds to wait for a page to load (minimum 5). |
| `EDGE_WINDOW_MODE` | `maximized` | `maximized`, `minimized` or `offscreen`. Use `offscreen` to keep Edge out of the way. |
| `MAX_CONSECUTIVE_FAILURES` | `3` | Stop a profile after this many failed searches in a row. |
| `REWARDS_ENABLED` | `true` | Run the Bing Rewards pass in a second tab for each profile. |
| `REWARDS_URL` | `https://rewards.bing.com` | Rewards dashboard. |
| `REWARDS_EARN_URL` | `<REWARDS_URL>/earn` | "Keep earning" page. |
| `REWARDS_CLAIM_INTERVAL` | `5` | Unused: points are claimed once, after the searches. |
| `REWARDS_TASK_TIMEOUT` | `25` | Maximum seconds to wait for a rewards page or task tab to load. |
| `REWARDS_PHOTO_DIR` | `%USERPROFILE%\Pictures` | Folder searched (recursively) for photos for the image-search task. **Point this at a folder of free stock photos**: the photos are uploaded to Bing. |
| `REWARDS_PHOTO_MAX_ATTEMPTS` | `0` | Attempts before giving up on the image task; `0` means keep trying different photos. |
| `REWARDS_PHOTO_MIN_BYTES` | `4096` | Ignore photos smaller than this (icons and thumbnails). |
| `SCHEDULE_MODE` | — | Optional non-interactive schedule: `now`, `once` or `daily`. |
| `SCHEDULE_AT` | — | Date and time for `once`, e.g. `2026-11-12 13:00`. |
| `SCHEDULE_DAILY_TIME` | — | Time for `daily`, e.g. `00:01`. |

A profile is copied into `SELENIUM_USER_DATA_DIR` the first time it is used. Later runs reuse that copy.

## Running

Commands are grouped per platform; `just` alone lists them all.

| Group | Commands |
|---|---|
| `just web` | `run`, `now`, `at`, `daily`, `preview`, `login` |
| `just mobile` | `run`, `wifi`, `news`, `inspect`, `setup`, `server`, `web-test`, `web-news` |
| `just desktop` | `run`, `new`, `save`, `use`, `open`, `close`, `backups`, `restore` (`just desktop` = status) |
| general | `recap` (all tasks), `setup`, `install`, `keyword`, `update-driver`, `typecheck` |

### Web (PC)

| Command | What it does |
|---|---|
| `just web run` | Asks how to run: once at a date and time, daily, or now. |
| `just web run 10:00` | Runs once at 10:00 (today, or tomorrow if that time has passed). |
| `just web now` | Runs immediately. |
| `just web at "2026-11-12 13:00"` | Runs once at that date and time. |
| `just web daily "00:01"` | Runs every day at that time and keeps waiting between runs. |
| `just web preview ["Profile 5" a@x.com …]` | Opens the profiles in plain Edge windows at Rewards → Redeem and runs no task. |
| `just web login ["Profile 5" \| a@x.com]` | Opens the Selenium copy of a profile at rewards.bing.com so you can sign in again ("belum login rewards"). Without an argument it lists the profiles and their accounts. |

Add `--visible` to any run command (`just web now --visible`) to show the Edge windows for that run, whatever `EDGE_WINDOW_MODE` says.

Per profile: daily set, photo task, perks, "Keep earning" (including **Set as wallpaper**, +20), searches, then claim ready points. Tasks already checked are skipped. Searches stop at the daily PC search cap (90 points): only the missing ones run, and more are added if the counter is still short. When the counter cannot be read, `SEARCHES_PER_PROFILE` searches run.

Without `just`, use `node node_modules/tsx/dist/cli.mjs src/app.ts` with `--now`, `--at "..."` or `--daily HH:MM`. Add `--no-prompt` to fail instead of asking when no schedule is given. Command-line options take priority over the `SCHEDULE_*` values in `.env`.

Press `Ctrl+C` to stop. The session recap is still printed for the profiles that already ran. Press it twice to quit immediately.

### Exit code

`0` when every profile is perfect. Otherwise it is the number of profiles that are not perfect: a failed search, an early stop, or an error. `130` when stopped with `Ctrl+C`.

## Bing Rewards

For each profile the run starts on `bing.com`, then opens `rewards.bing.com` in a second tab.

1. **Daily set.** Every unchecked card in the daily set is opened in a new tab for a few seconds, answered if it is a quiz/poll, and closed again. One retry pass follows in case the dashboard updates slowly.
2. **Photo task.** If a **Visual Search Activity** card is present, **Search now** starts Bing visual search and a photo from `REWARDS_PHOTO_DIR` is uploaded, retrying with the next photo until the card is checked. Without a photo task this step is skipped.
3. **Your perks.** Every unfinished perk item is opened and completed.
4. **Keep earning.** The rewards tab moves to `/earn` and every unchecked item in **Keep earning** is opened and closed.
5. **Close tabs.** Every tab except the search tab is closed (including the rewards tab).
6. **Searches.** The search tab runs `SEARCHES_PER_PROFILE` searches.
7. **Claim.** After the last search a fresh rewards tab is opened and every **Ready to claim** point is claimed. The result is always shown, also when there is nothing to claim.

Rewards failures never abort the search session. They are shown as `★ reward · …` lines under the profile and summarised in the footer and session recap. If the profile is signed out, the rewards part is skipped with a note. Set `REWARDS_ENABLED=false` to turn the whole feature off.

Selectors are defined in [`src/rewards/page.ts`](src/rewards/page.ts). Microsoft changes the rewards markup from time to time; if tasks stop being detected, update the text fallbacks or the `PHOTO_WORDS` / `NAV_TITLES` lists in [`src/rewards/runner.ts`](src/rewards/runner.ts).

## Mobile (Android phone)

Needs an Android phone with the Bing app signed in to your accounts, Node.js, and `adb`. Read to Earn is only credited inside the Bing app, so this drives the real app through [Appium](https://appium.io) (a small built-in W3C client, no extra npm package).

```bash
just mobile setup         # once: installs Appium + the uiautomator2 driver
just mobile run           # every account on the phone
```

Per account: switch account → **check in** → **More activities** → **read news until Read to Earn is 30/30** → close all tabs. Accounts that fail are retried once at the end. New accounts added to the Bing app are picked up automatically. The Appium server is started (and stopped) by the run itself.

| Option | Effect |
|---|---|
| `--list` | show the accounts on the phone |
| `--accounts "a@x.com,b@x.com"` | only these accounts |
| `--no-read` | only check in + More activities |
| `--no-checkin`, `--no-activities` | skip that step |
| `--count 10` | max articles per round |
| `--dry-run` | switch accounts, read nothing |

The app's **Daily points cap is 120**; once reached, nothing more is credited that day.

**Phone connection.** USB: plug in and allow USB debugging. Wi-Fi (no cable, PC and phone on the same network): plug in once and run `just mobile wifi usb`, or pair without a cable (Android 11+) with `just mobile wifi pair`. `just mobile wifi` shows the status, `connect` reconnects, `off` disconnects. Switching between home and office Wi-Fi needs no new pairing: the phone is found over mDNS.

Other commands: `just mobile news` (Read to Earn on the active account only), `just mobile inspect` (dump the app screen for selector debugging), `just mobile server` (run Appium by hand), and `just mobile web-test` / `web-news` (Edge with a phone profile through DevTools emulation).

With `MOBILE_BACKEND=appium`, `just web run` also runs the phone pass once at the end of the session.

### Check all accounts

```bash
just recap
```

Read-only. Shows per account: check in, Search and Daily set (web tasks), Read to Earn, More activities, daily points and total. Unfinished accounts are listed with a ready `just mobile run --accounts "…"` command.

## Desktop (Microsoft Rewards app for Windows)

The Microsoft Rewards app (from the Microsoft Store) keeps one signed-in account at a time. Each account's sign-in is saved once as a **profile**; `just desktop run` swaps them in one by one and does the weekly desktop-app quest.

```bash
just desktop new you@example.com    # empties the app and opens it
#   sign in with that account inside the app
just desktop save you@example.com   # closes the app and saves the sign-in
just desktop run                    # every saved profile
```

**Always add accounts this way.** Signing in to another account directly in the app (without `new` → `save`) leaves the app holding an account that no profile knows; the session is moved to `_backup` (never deleted) and can be turned into a profile with `just desktop restore <email>`.

| Command | Effect |
|---|---|
| `just desktop` | app status and saved profiles (▶ = in app) |
| `just desktop use you@example.com` | put that account in the app and open it |
| `just desktop run --accounts "a@x,b@x"` | only these profiles |
| `just desktop run --dry-run` | read the quest status, click nothing |
| `just desktop run --visible` | keep the app window on screen |
| `just desktop backups` / `restore NAME` | list backed-up sessions / turn one into a profile |
| `just desktop open` / `close` | open / close the app |

Saved sign-ins live in `%LOCALAPPDATA%\edge-ts\desktop-profiles` (`DESKTOP_PROFILES_DIR`). They are live sessions: keep them on this PC, never in the repo or a synced folder. For a few seconds while the app starts, the user variable `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` holds `--remote-debugging-port=9333` (no admin needed); it is removed as soon as the app runs, and any leftover is removed by the next `just desktop` command. The port is on 127.0.0.1 only and closes with the app.

## Updating the driver

Edge updates itself, and Selenium fails when msedgedriver no longer matches it. To fix this:

```bash
just update-driver
```

It reads the installed Edge version from the Windows registry, compares it with the driver `EDGE_DRIVER_PATH` points to, and if they differ downloads the matching driver from Microsoft into `driver/stable/<version>/`, checks it, and sets `EDGE_DRIVER_PATH` in `.env`. Other lines in `.env` are left as they are. If there is no build for your exact Edge version, it uses the newest driver with the same major version.

| Option | Effect |
|---|---|
| `--latest` | Download the newest stable driver, even if your Edge has not updated yet. |
| `--version 157.0.4341.60` | Download that exact version. |
| `--force` | Download again even if the driver is already up to date. |

## Keywords

Keywords are picked at random from `src/data/keywords.txt`, without repeats until every keyword has been used. One keyword per line; blank lines and lines starting with `#` are ignored, and duplicates are dropped.

Generate a fresh list (default 500):

```bash
just keyword 500
```

- Keywords come from search autocomplete (Google, falling back to Bing), so they are queries people actually type. Each run gives a different mix. Needs an internet connection.
- Only English suggestions of 3–12 words are kept. Unsafe topics are filtered out by a blocklist: adult content, violence, drugs and alcohol, gambling and crypto, piracy, politics and religion, medical topics, personal data and logins, and celebrities and media.
- Use `--offline` to build keywords from local templates instead. The generator also falls back to these templates when there is no internet.

```bash
just keyword 300 --offline
```

The previous file is kept as `src/data/keywords.backup.txt`. If nothing could be generated, `keywords.txt` is left unchanged.

## Project layout

```
src/
  app.ts                       entry point: arguments, schedule, session loop
  scheduler.ts                 once / daily scheduling and the interactive prompt
  config/settings.ts           reads and validates .env
  driver/edge.ts               creates the Edge WebDriver
  driver/profile.ts            copies a profile into the Selenium folder
  search/engine.ts             runs the searches for one profile
  rewards/runner.ts            rewards tab: claims, daily tasks, earn, photos
  rewards/page.ts              rewards selectors and JavaScript helpers
  rewards/photos.ts            picks photos from the local folder
  driver/manual.ts             plain Edge window on a profile copy (web login / preview)
  mobile/                      phone: adb wifi, Appium client, Bing app accounts / news / rewards / recap,
                               plus Edge phone emulation (devices, emulation, probe, news)
  desktop/                     Rewards app for Windows: profiles, debug port, quest, offscreen window
  scripts/                     CLI entry points: login, mobile-*, recap, desktop, generate-keywords, update-driver
  utils/ui.ts, ui-mobile.ts    terminal layout (banner, profile blocks, recap, phone blocks)
just/                          web.just, mobile.just, desktop.just
Justfile                       root commands and the three groups
  utils/keywords.ts            loads keywords.txt
  data/keywords.txt            keywords, one per line
```

## License

[MIT](LICENSE) © kodefess
