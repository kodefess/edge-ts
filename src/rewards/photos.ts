/** Pick free photos from a local folder for the image-search task. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REWARDS_PHOTO_MIN_BYTES } from "../config/settings";

export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".gif",
]);

// Pictures folders often contain huge OneDrive trees. Keep the walk short
// and bounded so a session never spends minutes listing files.
export const MAX_DEPTH = 4;
export const MAX_FILES = 5000;

/** Python's os.path.expanduser + os.path.expandvars (%VAR%, $VAR, ${VAR}). */
function expandPath(value: string): string {
  let result = value;

  if (result === "~" || result.startsWith("~/") || result.startsWith("~\\")) {
    result = os.homedir() + result.slice(1);
  }

  result = result
    .replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole)
    .replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      return process.env[name] ?? whole;
    });

  return result;
}

/** Return every usable image below `folder` (recursive). */
export function collectPhotos(folder: string | null | undefined, minBytes?: number | null): string[] {
  if (minBytes === undefined || minBytes === null) {
    minBytes = REWARDS_PHOTO_MIN_BYTES;
  }

  const root = path.resolve(expandPath(folder || ""));

  let isDir = false;
  try {
    isDir = fs.statSync(root).isDirectory();
  } catch {
    isDir = false;
  }

  if (!isDir) {
    return [];
  }

  const photos: string[] = [];

  // Top-down walk like os.walk: files of a folder, then its subfolders.
  const walk = (dir: string, depth: number): boolean => {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // os.walk ignores folders it cannot list.
      return true;
    }

    let dirnames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const filenames = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);

    if (depth >= MAX_DEPTH) {
      dirnames = [];
    }

    // Skip hidden and system folders such as OneDrive cache folders.
    dirnames = dirnames.filter((name) => !name.startsWith(".") && !name.startsWith("$"));

    for (const name of filenames) {
      if (photos.length >= MAX_FILES) {
        return false;
      }

      const extension = path.extname(name).toLowerCase();

      if (!IMAGE_EXTENSIONS.has(extension)) {
        continue;
      }

      const file = path.join(dir, name);

      try {
        if (fs.statSync(file).size < minBytes!) {
          continue;
        }
      } catch {
        continue;
      }

      photos.push(file);
    }

    for (const name of dirnames) {
      if (!walk(path.join(dir, name), depth + 1)) {
        return false;
      }
    }

    return true;
  };

  walk(root, 0);

  return photos;
}

/** In-place Fisher–Yates shuffle (Python's random.shuffle). */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }

  return items;
}

/** Return photos in random order so retries use different images. */
export function shuffledPhotos(folder: string | null | undefined): string[] {
  const photos = collectPhotos(folder);

  shuffle(photos);

  return photos;
}
