import type { WebElement } from "selenium-webdriver";

import { onInterrupt } from "./interrupt";

/** Generate a random delay in seconds. */
export function randomDelay(minSeconds = 5, maxSeconds = 15): number {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

/** Sleep for `milliseconds`; ends early when Ctrl+C is pressed. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unregister();
      resolve();
    };

    const timer = setTimeout(done, Math.max(0, milliseconds));
    const unregister = onInterrupt(done);
  });
}

/** Type text with a random delay between characters. */
export async function humanTyping(element: WebElement, text: string): Promise<void> {
  for (const char of text) {
    await element.sendKeys(char);
    await sleep(randomDelay(0.05, 0.2) * 1000);
  }
}
