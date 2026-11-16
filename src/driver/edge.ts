import edge from "selenium-webdriver/edge";

import { Builder, type WebDriver } from "selenium-webdriver";

import {
  EDGE_DRIVER_PATH,
  EDGE_WINDOW_MODE,
  PAGE_LOAD_TIMEOUT,
  SELENIUM_USER_DATA_DIR,
} from "../config/settings";
import { ensureProfileCopied } from "./profile";

/**
 * Far outside any monitor layout, but still a normal (not minimized) window,
 * so pages keep rendering at full speed.
 */
const OFFSCREEN_POSITION = "-32000,-32000";
const OFFSCREEN_SIZE = "1366,900";

/** Create Edge WebDriver using the specified profile. */
export async function createDriver(profileName: string): Promise<WebDriver> {
  ensureProfileCopied(profileName);

  const options = new edge.Options();

  options.addArguments(
    `user-data-dir=${SELENIUM_USER_DATA_DIR}`,
    `profile-directory=${profileName}`,
  );

  // enable-automation: hides the "being controlled by automated test software"
  //   infobar. enable-logging: stops "DevTools listening on ws://..." output.
  options.excludeSwitches("enable-automation", "enable-logging");

  // Same object the Options class keeps for "ms:edgeOptions"; Python's
  // add_experimental_option("useAutomationExtension", False).
  (options.get("ms:edgeOptions") as Record<string, unknown>).useAutomationExtension = false;

  options.addArguments("--disable-blink-features=AutomationControlled");

  if (EDGE_WINDOW_MODE === "offscreen") {
    options.addArguments(`--window-position=${OFFSCREEN_POSITION}`, `--window-size=${OFFSCREEN_SIZE}`);
  } else if (EDGE_WINDOW_MODE === "maximized") {
    options.addArguments("--start-maximized");
  }
  // "minimized" opens normally and is minimized once the driver is up; Edge
  // has no reliable start-minimized switch.

  options.addArguments(
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--log-level=3",
  );

  const service = new edge.ServiceBuilder(EDGE_DRIVER_PATH).setStdio("ignore");

  const driver = await new Builder()
    .forBrowser("MicrosoftEdge")
    .setEdgeService(service)
    .setEdgeOptions(options)
    .build();

  if (EDGE_WINDOW_MODE === "minimized") {
    await minimize(driver);
  }

  // Prevent a single stuck page load from blocking the whole session.
  await driver.manage().setTimeouts({
    pageLoad: PAGE_LOAD_TIMEOUT * 1000,
    script: PAGE_LOAD_TIMEOUT * 1000,
  });

  await driver.executeScript(
    "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })",
  );

  return driver;
}

/** Minimize the Edge window; ignore drivers that cannot. */
export async function minimize(driver: WebDriver): Promise<void> {
  try {
    await driver.manage().window().minimize();
  } catch {
    // Not fatal: the run still works with a visible window.
  }
}
