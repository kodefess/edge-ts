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

| Command | What it does |
|---|---|
| `just run` | Asks how to run: once at a date and time, daily, or now. |
| `just run 10:00` | Runs once at 10:00 (today, or tomorrow if that time has passed). |
| `just run-now` | Runs immediately. |
| `just run-at "2026-11-12 13:00"` | Runs once at that date and time. |
| `just run-daily "00:01"` | Runs every day at that time and keeps waiting between runs. |

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
  scripts/generate-keywords.ts keyword generator
  scripts/update-driver.ts     downloads the matching msedgedriver
  utils/ui.ts                  terminal layout (banner, profile blocks, recap)
  utils/keywords.ts            loads keywords.txt
  data/keywords.txt            keywords, one per line
```

## License

[MIT](LICENSE) © kodefess
