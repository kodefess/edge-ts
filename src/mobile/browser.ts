/**
 * Create Edge WebDriver sessions that look like an Android phone.
 *
 * This is the mobile counterpart of driver/edge.ts. It reuses the same profile
 * copy and anti-automation switches, then applies the CDP emulation before the
 * first navigation.
 */
import edge from "selenium-webdriver/edge";

import { Builder, type WebDriver } from "selenium-webdriver";

import {
  EDGE_DRIVER_PATH,
  MOBILE_LOCALE,
  MOBILE_WINDOW_MODE,
  PAGE_LOAD_TIMEOUT,
  SELENIUM_USER_DATA_DIR,
} from "../config/settings";
import { ensureProfileCopied } from "../driver/profile";
import type { Device } from "./devices";
import { MobileEmulation } from "./emulation";

const OFFSCREEN_POSITION = "-32000,-32000";

/** The real window is only a frame around the emulated viewport and stays offscreen. */
const WINDOW_EXTRA_WIDTH = 20;
const WINDOW_EXTRA_HEIGHT = 140;

const WEBDRIVER_PATCH = "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })";

export type MobileDriver = WebDriver & { mobileEmulation?: MobileEmulation };

/**
 * Start Edge for `profileName` and emulate `device`.
 *
 * The emulation object is also attached as `driver.mobileEmulation` so
 * `openMobileTab` can re-apply it to new tabs.
 */
export async function createMobileDriver(
  profileName: string,
  device: Device,
  emulation?: MobileEmulation,
  windowMode?: string,
): Promise<MobileDriver> {
  ensureProfileCopied(profileName);

  const mode = (windowMode || MOBILE_WINDOW_MODE || "offscreen").trim().toLowerCase();

  const options = new edge.Options();

  options.addArguments(`user-data-dir=${SELENIUM_USER_DATA_DIR}`, `profile-directory=${profileName}`);

  // The UA is set at browser level so tabs that are opened by the page itself
  // never start as desktop. The client hints still come from CDP.
  options.addArguments(`--user-agent=${device.userAgent}`, `--lang=${MOBILE_LOCALE}`);

  options.excludeSwitches("enable-automation", "enable-logging");
  (options.get("ms:edgeOptions") as Record<string, unknown>).useAutomationExtension = false;

  options.addArguments(
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    "--log-level=3",
  );

  const width = device.viewportWidth + WINDOW_EXTRA_WIDTH;
  const height = device.viewportHeight + WINDOW_EXTRA_HEIGHT;

  if (mode === "offscreen") {
    options.addArguments(`--window-position=${OFFSCREEN_POSITION}`, `--window-size=${width},${height}`);
  } else if (mode === "maximized") {
    options.addArguments("--start-maximized");
  }
  // "minimized" opens normally and is minimized below.

  const service = new edge.ServiceBuilder(EDGE_DRIVER_PATH).setStdio("ignore");

  const driver = (await new Builder()
    .forBrowser("MicrosoftEdge")
    .setEdgeService(service)
    .setEdgeOptions(options)
    .build()) as MobileDriver;

  if (mode === "minimized") {
    try {
      await driver.manage().window().minimize();
    } catch {
      // Not fatal: the emulated viewport is unaffected.
    }
  }

  await driver.manage().setTimeouts({ pageLoad: PAGE_LOAD_TIMEOUT * 1000, script: PAGE_LOAD_TIMEOUT * 1000 });
  await driver.executeScript(WEBDRIVER_PATCH);

  const active = emulation ?? new MobileEmulation(device);
  await active.apply(driver);

  driver.mobileEmulation = active;

  return driver;
}

/**
 * Open a new tab and emulate the device before it is navigated.
 *
 * The CDP overrides are per tab, so a plain `switchTo().newWindow` would leave
 * the new tab reporting a desktop UA and desktop viewport.
 */
export async function openMobileTab(driver: MobileDriver, emulation?: MobileEmulation): Promise<string> {
  const active = emulation ?? driver.mobileEmulation;

  if (!active) {
    throw new Error("No mobile emulation attached to this driver.");
  }

  await driver.switchTo().newWindow("tab");
  await active.apply(driver);

  return driver.getWindowHandle();
}
