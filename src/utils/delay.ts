import type { WebElement } from "selenium-webdriver";

export function randomDelay(minSeconds = 5, maxSeconds = 15): number {
  return Math.random() * (maxSeconds - minSeconds) + minSeconds;
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function humanTyping(
  element: WebElement,
  text: string,
): Promise<void> {
  for (const char of text) {
    await element.sendKeys(char);

    await sleep(randomDelay(0.05, 0.2) * 1000);
  }
}
