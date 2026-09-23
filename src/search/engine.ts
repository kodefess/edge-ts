import { By, until, type WebDriver } from "selenium-webdriver";

import { SEARCH_URL } from "../config/settings.js";

import { humanTyping, randomDelay, sleep } from "../utils/delay.js";

import { loadKeywords } from "../utils/keywords.js";

import { console } from "../utils/console.js";

const KEYWORDS = loadKeywords();

export async function runBrowserTasks(
  driver: WebDriver,
  maxTasks: number,
): Promise<number> {
  await driver.get(SEARCH_URL);

  let completed = 0;

  const used = new Set<string>();

  while (completed < maxTasks) {
    const available = KEYWORDS.filter((keyword) => !used.has(keyword));

    if (available.length === 0) {
      used.clear();
    }

    const keyword = available[Math.floor(Math.random() * available.length)];

    if (!keyword) {
      break;
    }

    used.add(keyword);

    try {
      const wait = driver.wait.bind(driver);

      const searchBox = await wait(until.elementLocated(By.name("q")), 10_000);

      await searchBox.clear();

      await humanTyping(searchBox, keyword);

      await searchBox.sendKeys("\uE007");

      completed++;

      console.success(
        `  ✓ ${String(completed).padStart(2, "0")}/${maxTasks} ${keyword}`,
      );

      await sleep(5_000);

      await driver.get(SEARCH_URL);
    } catch (error) {
      console.error(
        `  ✗ task failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await driver.get(SEARCH_URL);
    }
  }

  return completed;
}
