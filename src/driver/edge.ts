import edge from "selenium-webdriver/edge.js";

import { Builder, type WebDriver } from "selenium-webdriver";

import {
  EDGE_DRIVER_PATH,
  SELENIUM_USER_DATA_DIR,
} from "../config/settings.js";

import { ensureProfileCopied } from "./profiles.js";

export async function createDriver(profileName: string): Promise<WebDriver> {
  if (!EDGE_DRIVER_PATH || !SELENIUM_USER_DATA_DIR) {
    throw new Error("Edge configuration is incomplete.");
  }

  await ensureProfileCopied(profileName);

  const options = new edge.Options();

  options.addArguments(`user-data-dir=${SELENIUM_USER_DATA_DIR}`);

  options.addArguments(`profile-directory=${profileName}`);

  options.addArguments(
    "--start-maximized",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-logging",
    "--log-level=3",
  );

  const service = new edge.ServiceBuilder(EDGE_DRIVER_PATH).setStdio("ignore");

  return new Builder()
    .forBrowser("MicrosoftEdge")
    .setEdgeService(service)
    .setEdgeOptions(options)
    .build();
}
