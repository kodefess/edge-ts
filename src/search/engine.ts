import pc from "picocolors";
import { By, until, type WebDriver } from "selenium-webdriver";
import { SEARCH_URL } from "../config/settings.js";
import { humanTyping, sleep } from "../utils/delay.js";
import { loadKeywords } from "../utils/keywords.js";
import { console, formatError } from "../utils/console.js";

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
  profileTag: string,
): Promise<TaskResult> {
  await driver.get(SEARCH_URL);

  const failures: TaskFailure[] = [];
  const used = new Set<string>();
  const width = String(maxTasks).length;

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

    const counter = `${String(completed + 1).padStart(width, "0")}/${maxTasks}`;

    try {
      const searchBox = await driver.wait(
        until.elementLocated(By.name("q")),
        10_000,
      );

      await searchBox.clear();
      await humanTyping(searchBox, keyword);
      await searchBox.sendKeys("");

      completed++;

      console.print(
        `  ${pc.dim(profileTag)} ${pc.green("✓")} ${pc.dim(counter)}  ${keyword}`,
      );

      await sleep(5_000);
    } catch (error) {
      const reason = formatError(error);

      failures.push({ keyword, reason });

      console.print(
        `  ${pc.dim(profileTag)} ${pc.red("✗")} ${pc.dim(counter)}  ${pc.red(keyword)} ${pc.dim(`· ${reason}`)}`,
      );
    }

    try {
      await driver.get(SEARCH_URL);
    } catch (error) {
      // Browser is unusable; keep what was done so far and stop this profile.
      return { completed, failures, aborted: formatError(error) };
    }
  }

  if (failures.length >= MAX_FAILURES && completed < maxTasks) {
    const aborted = `stopped after ${MAX_FAILURES} failed tasks`;

    console.warning(`  ${profileTag} ! ${aborted}`);

    return { completed, failures, aborted };
  }

  return { completed, failures };
}
