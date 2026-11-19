import "dotenv/config";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ============================================================
// PATHS
// ============================================================

export const SRC_DIR = path.resolve(import.meta.dirname, "..");
export const PROJECT_ROOT = path.resolve(SRC_DIR, "..");

// ============================================================
// HELPERS
// ============================================================

function getEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Read an integer from the environment (>= minimum). */
function envInt(name: string, fallback: number, minimum = 1): number {
  const raw = getEnv(name);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer, got: ${JSON.stringify(raw)}`);
  }

  if (value < minimum) {
    throw new Error(`${name} must be >= ${minimum}, got: ${value}`);
  }

  return value;
}

/** Read a boolean from the environment. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = getEnv(name);

  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  throw new Error(`${name} must be true/false, got: ${JSON.stringify(raw)}`);
}

/** Strip quotes, expand ~ and %VAR%/$VAR, and resolve against the project root. */
export function resolveDirPath(value: string): string {
  let result = value.trim().replace(/^["']|["']$/g, "");

  result = result
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, name: string) => process.env[name] ?? match);

  return path.isAbsolute(result) ? path.normalize(result) : path.resolve(PROJECT_ROOT, result);
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Resolve the EdgeDriver path. Accepts a file, a directory, or a glob in the
 * last path segment such as ./driver/stable/*.
 */
function resolveDriverPath(value: string): string {
  const resolved = resolveDirPath(value);

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return resolved;
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    for (const filename of ["msedgedriver.exe", "msedgedriver"]) {
      const candidate = path.join(resolved, filename);

      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  if (/[*?[]/.test(resolved)) {
    const dir = path.dirname(resolved);
    const matcher = globToRegExp(path.basename(resolved));

    if (fs.existsSync(dir)) {
      const matches = fs
        .readdirSync(dir)
        .filter((name) => matcher.test(name))
        .map((name) => path.join(dir, name))
        .flatMap((match) => {
          if (fs.statSync(match).isDirectory()) {
            return ["msedgedriver.exe", "msedgedriver"]
              .map((file) => path.join(match, file))
              .filter((file) => fs.existsSync(file));
          }
          return [match];
        })
        .sort();

      const preferred = matches.filter((match) =>
        path.basename(match).toLowerCase().includes("edgedriver"),
      );

      if (preferred[0]) {
        return preferred[0];
      }
    }
  }

  return resolved;
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isWithin(child: string, parent: string): boolean {
  const c = normalizedPath(child);
  const p = normalizedPath(parent);

  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// ============================================================
// CONFIGURATION
// ============================================================

const rawDriverPath = getEnv("EDGE_DRIVER_PATH");

export const EDGE_DRIVER_PATH = rawDriverPath ? resolveDriverPath(rawDriverPath) : "";

export const SEARCH_URL = getEnv("SEARCH_URL") ?? "https://www.bing.com";

/**
 * Live Edge "User Data" folder, only read to copy profiles. Optional in
 * edge-ts: without it, profiles are used straight from SELENIUM_USER_DATA_DIR
 * (the old edge-ts behaviour).
 */
const rawOriginalDir = getEnv("ORIGINAL_USER_DATA_DIR");

export const ORIGINAL_USER_DATA_DIR = rawOriginalDir ? resolveDirPath(rawOriginalDir) : "";

const rawSeleniumDir = getEnv("SELENIUM_USER_DATA_DIR");

export const SELENIUM_USER_DATA_DIR = rawSeleniumDir ? resolveDirPath(rawSeleniumDir) : "";

export const SEARCHES_PER_PROFILE = envInt("SEARCHES_PER_PROFILE", 30);

export const CLOSE_EXISTING_EDGE = envBool("CLOSE_EXISTING_EDGE", true);

export const PAGE_LOAD_TIMEOUT = envInt("PAGE_LOAD_TIMEOUT", 30, 5);

/**
 * How the Edge window is shown:
 *   maximized  full screen (default)
 *   minimized  minimized to the taskbar right after it opens
 *   offscreen  opened outside the visible screen, never in the way
 */
export const EDGE_WINDOW_MODES = ["maximized", "minimized", "offscreen"] as const;

export type EdgeWindowMode = (typeof EDGE_WINDOW_MODES)[number];

const rawWindowMode = (getEnv("EDGE_WINDOW_MODE") ?? "maximized").toLowerCase();

if (!(EDGE_WINDOW_MODES as readonly string[]).includes(rawWindowMode)) {
  throw new Error(
    `EDGE_WINDOW_MODE must be one of: ${EDGE_WINDOW_MODES.join(", ")}, got: ${JSON.stringify(rawWindowMode)}`,
  );
}

export const EDGE_WINDOW_MODE = rawWindowMode as EdgeWindowMode;

export const MAX_CONSECUTIVE_FAILURES = envInt("MAX_CONSECUTIVE_FAILURES", 3);

// ============================================================
// BING REWARDS
// ============================================================

export const REWARDS_ENABLED = envBool("REWARDS_ENABLED", true);

export const REWARDS_URL = (getEnv("REWARDS_URL") ?? "https://rewards.bing.com").replace(/\/+$/, "");

export const REWARDS_EARN_URL = getEnv("REWARDS_EARN_URL") ?? `${REWARDS_URL}/earn`;

/** Seconds between checks for points that are ready to claim. */
export const REWARDS_CLAIM_INTERVAL = envInt("REWARDS_CLAIM_INTERVAL", 5, 2);

/** Maximum time to wait for a rewards page or task tab to load. */
export const REWARDS_TASK_TIMEOUT = envInt("REWARDS_TASK_TIMEOUT", 25, 5);

/** 0 means keep trying with different photos until the task is checked. */
export const REWARDS_PHOTO_MAX_ATTEMPTS = envInt("REWARDS_PHOTO_MAX_ATTEMPTS", 0, 0);

const rawPhotoDir = getEnv("REWARDS_PHOTO_DIR");

export const REWARDS_PHOTO_DIR = rawPhotoDir
  ? resolveDirPath(rawPhotoDir)
  : path.join(os.homedir(), "Pictures");

/** Ignore tiny icons and thumbnails that image search may reject. */
export const REWARDS_PHOTO_MIN_BYTES = envInt("REWARDS_PHOTO_MIN_BYTES", 4096, 1);

/**
 * PC search points: Bing pays this many points per search, up to the daily
 * cap the Rewards page reports (90). The search count is cut to what is still
 * missing, and topped up this many times when the cap is not reached.
 */
export const REWARDS_POINTS_PER_SEARCH = envInt("REWARDS_POINTS_PER_SEARCH", 3, 1);

export const REWARDS_SEARCH_TOPUP_ROUNDS = envInt("REWARDS_SEARCH_TOPUP_ROUNDS", 2, 0);

/** "Set as wallpaper" (+20) on /earn: seconds to wait for Image Creator, and attempts. */
export const REWARDS_WALLPAPER_TIMEOUT = envInt("REWARDS_WALLPAPER_TIMEOUT", 120, 20);

export const REWARDS_WALLPAPER_ATTEMPTS = envInt("REWARDS_WALLPAPER_ATTEMPTS", 3, 1);

// ============================================================
// MOBILE PASS
// ============================================================

function envChoice<T extends string>(name: string, choices: readonly T[], fallback: T): T {
  const value = (getEnv(name) ?? fallback).toLowerCase();

  if (!(choices as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of: ${choices.join(", ")}, got: ${JSON.stringify(value)}`);
  }

  return value as T;
}

function envUrl(name: string, fallback: string): string {
  const value = getEnv(name) ?? fallback;

  if (!/^https?:\/\//.test(value)) {
    throw new Error(`${name} must start with http:// or https://, got: ${JSON.stringify(value)}`);
  }

  return value;
}

/** off = desktop only, replace = whole session mobile, second_pass = desktop then mobile. */
export const MOBILE_RUN_MODES = ["off", "replace", "second_pass"] as const;
export const MOBILE_RUN_MODE = envChoice("MOBILE_RUN_MODE", MOBILE_RUN_MODES, "second_pass");

/** "web" = Selenium + DevTools emulation; "appium" also reads news in the Bing app on a real phone. */
export const MOBILE_BACKENDS = ["web", "appium"] as const;
export const MOBILE_BACKEND = envChoice("MOBILE_BACKEND", MOBILE_BACKENDS, "web");

/** Preset key from src/mobile/devices.ts. Validated when the pass starts. */
export const MOBILE_DEVICE = (getEnv("MOBILE_DEVICE") ?? "pixel_7").toLowerCase();

/** 0 means: use SEARCHES_PER_PROFILE. */
export const MOBILE_SEARCHES_PER_PROFILE = envInt("MOBILE_SEARCHES_PER_PROFILE", 0, 0);

export const MOBILE_LOCALE = getEnv("MOBILE_LOCALE") ?? "en-US";

export const MOBILE_WINDOW_MODE = envChoice("MOBILE_WINDOW_MODE", EDGE_WINDOW_MODES, "offscreen");

/** Abort the mobile pass when the page probe does not see a phone. */
export const MOBILE_PROBE_STRICT = envBool("MOBILE_PROBE_STRICT", true);

export const MOBILE_NEWS_ENABLED = envBool("MOBILE_NEWS_ENABLED", true);
export const MOBILE_NEWS_MAX = envInt("MOBILE_NEWS_MAX", 3);
export const MOBILE_NEWS_DWELL_MIN = envInt("MOBILE_NEWS_DWELL_MIN", 3);
export const MOBILE_NEWS_DWELL_MAX = envInt("MOBILE_NEWS_DWELL_MAX", 3);

if (MOBILE_NEWS_DWELL_MIN > MOBILE_NEWS_DWELL_MAX) {
  throw new Error(
    `MOBILE_NEWS_DWELL_MIN must be <= MOBILE_NEWS_DWELL_MAX, got: ${MOBILE_NEWS_DWELL_MIN} > ${MOBILE_NEWS_DWELL_MAX}`,
  );
}

export const MOBILE_NEWS_SCROLL = envInt("MOBILE_NEWS_SCROLL", 1, 1);
export const MOBILE_NEWS_FEED_URL = envUrl("MOBILE_NEWS_FEED_URL", "https://www.msn.com/en-us/news");

// --- Bing app through Appium ---------------------------------

export const MOBILE_APPIUM_SERVER = envUrl("MOBILE_APPIUM_SERVER", "http://127.0.0.1:4723");

/** Serial from `adb devices`. Empty means "the only attached device". */
export const MOBILE_APPIUM_UDID = getEnv("MOBILE_APPIUM_UDID") ?? "";
export const MOBILE_APPIUM_DEVICE_NAME = getEnv("MOBILE_APPIUM_DEVICE_NAME") ?? "Android";
export const MOBILE_APPIUM_PLATFORM_VERSION = getEnv("MOBILE_APPIUM_PLATFORM_VERSION") ?? "";
export const MOBILE_APPIUM_APP_PACKAGE = getEnv("MOBILE_APPIUM_APP_PACKAGE") ?? "com.microsoft.bing";
export const MOBILE_APPIUM_APP_ACTIVITY = getEnv("MOBILE_APPIUM_APP_ACTIVITY") ?? "";
export const MOBILE_APPIUM_NO_RESET = envBool("MOBILE_APPIUM_NO_RESET", true);
export const MOBILE_APPIUM_TIMEOUT = envInt("MOBILE_APPIUM_TIMEOUT", 30, 5);
export const MOBILE_APPIUM_WAIT = envInt("MOBILE_APPIUM_WAIT", 25, 5);

export const MOBILE_APP_NEWS_ENABLED = envBool("MOBILE_APP_NEWS_ENABLED", true);
export const MOBILE_APP_NEWS_MAX = envInt("MOBILE_APP_NEWS_MAX", 10);
export const MOBILE_APP_DWELL_MIN = envInt("MOBILE_APP_DWELL_MIN", 15);
export const MOBILE_APP_DWELL_MAX = envInt("MOBILE_APP_DWELL_MAX", 30);

if (MOBILE_APP_DWELL_MIN > MOBILE_APP_DWELL_MAX) {
  throw new Error(
    `MOBILE_APP_DWELL_MIN must be <= MOBILE_APP_DWELL_MAX, got: ${MOBILE_APP_DWELL_MIN} > ${MOBILE_APP_DWELL_MAX}`,
  );
}

export const MOBILE_APP_MAX_SWIPES = envInt("MOBILE_APP_MAX_SWIPES", 12);

/** Emails (lowercase), in order. Empty = every account in the app, active one first. */
export const MOBILE_APP_ACCOUNTS: string[] = (getEnv("MOBILE_APP_ACCOUNTS") ?? "")
  .split(",")
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

export const MOBILE_APP_RESTORE_ACCOUNT = envBool("MOBILE_APP_RESTORE_ACCOUNT", true);
export const MOBILE_APP_CHECKIN = envBool("MOBILE_APP_CHECKIN", true);
export const MOBILE_APP_ACTIVITIES = envBool("MOBILE_APP_ACTIVITIES", true);
export const MOBILE_APP_READ_ROUNDS = envInt("MOBILE_APP_READ_ROUNDS", 3);
export const MOBILE_APP_CLOSE_TABS = envBool("MOBILE_APP_CLOSE_TABS", true);
export const MOBILE_APP_RETRY = envInt("MOBILE_APP_RETRY", 1, 0);
export const MOBILE_APP_SKIP_FULL = envBool("MOBILE_APP_SKIP_FULL", true);

/** Last wireless adb address that worked (written by `just mobile wifi`). */
export const MOBILE_ADB_WIFI = getEnv("MOBILE_ADB_WIFI") ?? "";
export const MOBILE_ADB_WIFI_AUTO = envBool("MOBILE_ADB_WIFI_AUTO", true);
export const MOBILE_APPIUM_AUTOSTART = envBool("MOBILE_APPIUM_AUTOSTART", true);

// ============================================================
// DESKTOP (Microsoft Rewards app for Windows)
// ============================================================

export const DESKTOP_PROFILES_DIR = resolveDirPath(
  getEnv("DESKTOP_PROFILES_DIR") ??
    path.join(process.env.LOCALAPPDATA || os.homedir(), "edge-ts", "desktop-profiles"),
);

export const DESKTOP_APP_PACKAGE = getEnv("DESKTOP_APP_PACKAGE") ?? "Microsoft.24183918CCDA_8wekyb3d8bbwe";
export const DESKTOP_APP_ID = getEnv("DESKTOP_APP_ID") ?? "MicrosoftRewards";
export const DESKTOP_APP_EXE = getEnv("DESKTOP_APP_EXE") ?? "microsoft-rewards-desktop.exe";

/** offscreen: window kept outside the monitors during `desktop run`; visible: where the app opens it. */
export const DESKTOP_WINDOW_MODE = envChoice("DESKTOP_WINDOW_MODE", ["offscreen", "visible"] as const, "offscreen");

// ============================================================
// SCHEDULE (optional, non-interactive)
// ============================================================

export const SCHEDULE_MODE = getEnv("SCHEDULE_MODE")?.toLowerCase();
export const SCHEDULE_AT = getEnv("SCHEDULE_AT");
export const SCHEDULE_DAILY_TIME = getEnv("SCHEDULE_DAILY_TIME");

/** Legacy edge-ts setting: start once at HH:MM. Same as SCHEDULE_MODE=once. */
export const RUN_AT = getEnv("RUN_AT");

// ============================================================
// PROFILES
// ============================================================

/**
 * Comma-separated profile folder names. Duplicates are removed (case-
 * insensitively, like Windows paths) while keeping the original order.
 */
export const PROFILES: string[] = (() => {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const profile of (getEnv("PROFILES") ?? "").split(",")) {
    const name = profile.trim();
    const key = name.toLowerCase();

    if (name && !seen.has(key)) {
      seen.add(key);
      unique.push(name);
    }
  }

  return unique;
})();

// ============================================================
// KEYWORDS
// ============================================================

export const KEYWORDS_FILE = path.join(SRC_DIR, "data", "keywords.txt");

// ============================================================
// VALIDATION
// ============================================================

const missingConfig = Object.entries({
  EDGE_DRIVER_PATH,
  SELENIUM_USER_DATA_DIR,
})
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missingConfig.length > 0) {
  throw new Error(`Missing environment variables: ${missingConfig.join(", ")}`);
}

if (!fs.existsSync(EDGE_DRIVER_PATH) || !fs.statSync(EDGE_DRIVER_PATH).isFile()) {
  throw new Error(
    `EdgeDriver not found:\n${EDGE_DRIVER_PATH}\nPoint EDGE_DRIVER_PATH to msedgedriver.exe (or run: just update-driver).`,
  );
}

for (const [name, url] of [
  ["SEARCH_URL", SEARCH_URL],
  ["REWARDS_URL", REWARDS_URL],
  ["REWARDS_EARN_URL", REWARDS_EARN_URL],
] as const) {
  if (!/^https?:\/\//.test(url)) {
    throw new Error(`${name} must start with http:// or https://, got: ${JSON.stringify(url)}`);
  }
}

if (PROFILES.length === 0) {
  throw new Error("PROFILES is empty in .env");
}

// Profile names are used as directory names. Reject anything that could
// escape the user-data directory.
for (const profile of PROFILES) {
  if (profile === "." || profile === ".." || /[<>:"/\\|?*]/.test(profile)) {
    throw new Error(`Invalid profile name in PROFILES: ${JSON.stringify(profile)}`);
  }
}

if (ORIGINAL_USER_DATA_DIR) {
  // Selenium must never write to the live Edge profile. Doing so can corrupt
  // the user's real profile or fail because Edge has the files locked.
  if (
    isWithin(SELENIUM_USER_DATA_DIR, ORIGINAL_USER_DATA_DIR) ||
    isWithin(ORIGINAL_USER_DATA_DIR, SELENIUM_USER_DATA_DIR)
  ) {
    throw new Error("SELENIUM_USER_DATA_DIR and ORIGINAL_USER_DATA_DIR must be separate directories.");
  }
} else if (!fs.existsSync(SELENIUM_USER_DATA_DIR)) {
  throw new Error(`Edge User Data directory not found:\n${SELENIUM_USER_DATA_DIR}`);
}
