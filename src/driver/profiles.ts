import fs from "node:fs/promises";
import path from "node:path";

import {
  ORIGINAL_USER_DATA_DIR,
  SELENIUM_USER_DATA_DIR,
} from "../config/settings.js";

import { console } from "../utils/console.js";

export async function ensureProfileCopied(
  profileName: string,
): Promise<string> {
  if (!ORIGINAL_USER_DATA_DIR || !SELENIUM_USER_DATA_DIR) {
    throw new Error("Profile directories are not configured.");
  }

  const srcProfilePath = path.join(ORIGINAL_USER_DATA_DIR, profileName);

  const dstProfilePath = path.join(SELENIUM_USER_DATA_DIR, profileName);

  const srcLocalState = path.join(ORIGINAL_USER_DATA_DIR, "Local State");

  const dstLocalState = path.join(SELENIUM_USER_DATA_DIR, "Local State");

  await fs.mkdir(SELENIUM_USER_DATA_DIR, {
    recursive: true,
  });

  try {
    await fs.access(dstLocalState);
  } catch {
    try {
      await fs.access(srcLocalState);

      console.success("  · copying Edge local state...");

      await fs.copyFile(srcLocalState, dstLocalState);

      console.success("  ✓ local state copied");
    } catch {
      // Source Local State doesn't exist.
    }
  }

  try {
    await fs.access(dstProfilePath);
  } catch {
    try {
      await fs.access(srcProfilePath);
    } catch {
      throw new Error(`Profile not found: ${srcProfilePath}`);
    }

    console.success(`  · copying profile ${profileName}...`);

    await fs.cp(srcProfilePath, dstProfilePath, {
      recursive: true,
    });

    console.success("  ✓ profile copied");
  }

  return dstProfilePath;
}
