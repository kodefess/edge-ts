import { By, until, type WebDriver } from "selenium-webdriver";
import { SEARCH_URL } from "../config/settings.js";
import { humanTyping, sleep } from "../utils/delay.js";
import { loadKeywords } from "../utils/keywords.js";
import { formatError } from "../utils/console.js";
import { taskFailure, taskSuccess } from "../utils/ui.js";

const KEYWORDS = loadKeywords();

/** Stop retrying a profile after this many failed tasks. */
const MAX_FAILURES = 5;

export interface TaskFailure {
  keyword: string;
  reason: string;
}

export interface TaskResult {
  completed: number;
  failures: TaskFailure[];
  /** Set when the profile stopped before reaching its target. */
  aborted?: string;
}

export async function runBrowserTasks(
  driver: WebDriver,
  maxTasks: number,
): Promise<TaskResult> {
  await driver.get(SEARCH_URL);

  const failures: TaskFailure[] = [];
  const used = new Set<string>();

  let completed = 0;

  while (completed < maxTasks && failures.length < MAX_FAILURES) {
    let available = KEYWORDS.filter((keyword) => !used.has(keyword));

    if (available.length === 0) {
      used.clear();
      available = KEYWORDS;
    }

    const keyword = available[Math.floor(Math.random() * available.length)];

    if (!keyword) {
      break;
    }

    used.add(keyword);

    const current = completed + 1;

    try {
      const searchBox = await driver.wait(
        until.elementLocated(By.name("q")),
        10_000,
      );

      await searchBox.clear();
      await humanTyping(searchBox, keyword);
      await searchBox.sendKeys("");

      completed++;

      taskSuccess(current, maxTasks, keyword);

      await sleep(5_000);
    } catch (error) {
      const reason = formatError(error);

      failures.push({ keyword, reason });

      taskFailure(current, maxTasks, keyword, reason);
    }

    try {
      await driver.get(SEARCH_URL);
    } catch (error) {
      // Browser is unusable; keep what was done so far and stop this profile.
      return { completed, failures, aborted: formatError(error) };
    }
  }

  if (failures.length >= MAX_FAILURES && completed < maxTasks) {
    return {
      completed,
      failures,
      aborted: `berhenti setelah ${MAX_FAILURES} tugas gagal`,
    };
  }

  return { completed, failures };
}
