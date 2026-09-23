import fs from "node:fs";

import { KEYWORDS_FILE } from "../config/settings.js";

export function loadKeywords(): string[] {
  if (!fs.existsSync(KEYWORDS_FILE)) {
    throw new Error(`Keywords file not found: ${KEYWORDS_FILE}`);
  }

  const content = fs.readFileSync(KEYWORDS_FILE, "utf8");

  const keywords = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (keywords.length === 0) {
    throw new Error("KEYWORDS is empty in keywords.txt");
  }

  return keywords;
}
