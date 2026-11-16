import fs from "node:fs";
import path from "node:path";

import { KEYWORDS_FILE } from "../config/settings";

export const GENERATE_HINT = "Generate them with: just keyword 500";

/**
 * Read keywords from a plain text file, one keyword per line.
 *
 * Blank lines and lines starting with # are ignored, and duplicates are
 * dropped (case-insensitive) while keeping the original order.
 */
export function loadKeywords(file: string = KEYWORDS_FILE): string[] {
  if (!fs.existsSync(file)) {
    throw new Error(`Keywords file not found: ${file}. ${GENERATE_HINT}`);
  }

  // Strip a UTF-8 BOM, like Python's "utf-8-sig".
  const content = fs.readFileSync(file, "utf8").replace(/^﻿/, "");

  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const line of content.split(/\r\n|\r|\n/)) {
    const keyword = line.split(/\s+/).filter(Boolean).join(" ");

    if (!keyword || keyword.startsWith("#")) {
      continue;
    }

    const key = keyword.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    keywords.push(keyword);
  }

  if (keywords.length === 0) {
    throw new Error(`No keywords in ${path.basename(file)}. ${GENERATE_HINT}`);
  }

  return keywords;
}
