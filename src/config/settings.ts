import "dotenv/config";

import fs from "node:fs";
import path from "node:path";

const SRC_DIR = path.resolve(import.meta.dirname, "..");

export const PROJECT_ROOT = path.resolve(SRC_DIR, "..");

function getEnv(name: string): string | undefined {
  const value = process.env[name];

  if (!value) {
    return undefined;
  }

  return value.trim();
}

function resolveProjectPath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.resolve(PROJECT_ROOT, value);
}

export const EDGE_DRIVER_PATH = resolveProjectPath(getEnv("EDGE_DRIVER_PATH"));

export const SEARCH_URL = getEnv("SEARCH_URL") ?? "https://www.bing.com";

export const ORIGINAL_USER_DATA_DIR = getEnv("ORIGINAL_USER_DATA_DIR");

export const SELENIUM_USER_DATA_DIR = resolveProjectPath(
  getEnv("SELENIUM_USER_DATA_DIR"),
);

export const PROFILES = (getEnv("PROFILES") ?? "")
  .split(",")
  .map((profile) => profile.trim())
  .filter(Boolean);

export const SEARCHES_PER_PROFILE = Number(
  getEnv("SEARCHES_PER_PROFILE") ?? "30",
);

export const KEYWORDS_FILE = path.join(SRC_DIR, "data", "keywords.txt");

const missingConfig: string[] = [];

if (!EDGE_DRIVER_PATH) {
  missingConfig.push("EDGE_DRIVER_PATH");
}

if (!ORIGINAL_USER_DATA_DIR) {
  missingConfig.push("ORIGINAL_USER_DATA_DIR");
}

if (!SELENIUM_USER_DATA_DIR) {
  missingConfig.push("SELENIUM_USER_DATA_DIR");
}

if (missingConfig.length > 0) {
  throw new Error(`Missing environment variables: ${missingConfig.join(", ")}`);
}

if (PROFILES.length === 0) {
  throw new Error("PROFILES is empty in .env");
}

if (!EDGE_DRIVER_PATH || !fs.existsSync(EDGE_DRIVER_PATH)) {
  throw new Error(`EdgeDriver not found:\n${EDGE_DRIVER_PATH}`);
}

if (!ORIGINAL_USER_DATA_DIR || !fs.existsSync(ORIGINAL_USER_DATA_DIR)) {
  throw new Error(
    `Original Edge User Data directory not found:\n${ORIGINAL_USER_DATA_DIR}`,
  );
}

if (!Number.isInteger(SEARCHES_PER_PROFILE) || SEARCHES_PER_PROFILE <= 0) {
  throw new Error("SEARCHES_PER_PROFILE must be a positive integer");
}
