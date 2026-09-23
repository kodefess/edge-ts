import edge from "selenium-webdriver/edge";

import { Builder, type WebDriver } from "selenium-webdriver";

import { EDGE_DRIVER_PATH, SELENIUM_USER_DATA_DIR } from "../config/settings";

export async function createDriver(profileName: string): Promise<WebDriver> {
  if (!EDGE_DRIVER_PATH || !SELENIUM_USER_DATA_DIR) {
    throw new Error("Edge configuration is incomplete.");
  }

  const options = new edge.Options();

  options.addArguments(
    "--disable-infobars",
    `--user-data-dir=${SELENIUM_USER_DATA_DIR}`,
    `--profile-directory=${profileName}`,
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
