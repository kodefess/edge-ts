/**
 * Drive the page inside the desktop app with Selenium.
 *
 * The app is a WebView2 window showing rewards.bing.com. With
 * `--remote-debugging-port` among its browser arguments, msedgedriver can
 * attach to it the same way it attaches to Edge, and the dashboard helpers in
 * `rewards/page.ts` work unchanged.
 *
 * How the argument gets there without admin rights: WebView2 reads
 * `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` from the environment, and a packaged
 * app started with `Invoke-CommandInDesktopPackage` gets the user's
 * environment from the registry (`HKCU\Environment`). So the variable is
 * written, the app is started, and the variable is removed as soon as the app
 * runs (`startWithDebugging`), a few seconds. Any other WebView2 app opened in
 * those seconds gets the argument too; the attach step checks it landed on
 * rewards.bing.com before touching anything. A variable left behind by a crash
 * is removed by `clearLeftover`, which every desktop command runs first.
 *
 * The port listens on 127.0.0.1 only and closes with the app.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import edge from "selenium-webdriver/edge";

import { Builder, type WebDriver } from "selenium-webdriver";

import { DESKTOP_APP_EXE, DESKTOP_APP_ID, DESKTOP_APP_PACKAGE, EDGE_DRIVER_PATH } from "../config/settings";
import { sleep } from "../utils/delay";
import * as app from "./app";

const execFileAsync = promisify(execFile);

const ENV_KEY = "HKCU\\Environment";
const ENV_NAME = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

export const DEFAULT_PORT = 9333;

/** The app could not be reached on its debug port. */
export class DevToolsError extends Error {
  override name = "DevToolsError";
}

// ============================================================
// The temporary user variable
// ============================================================

function flag(port: number): string {
  return `--remote-debugging-port=${Math.trunc(port)}`;
}

async function readVariable(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("reg", ["query", ENV_KEY, "/v", ENV_NAME], { windowsHide: true });
    const match = new RegExp(`${ENV_NAME}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)`, "i").exec(stdout);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

async function writeVariable(value: string | null): Promise<void> {
  if (value === null) {
    try {
      await execFileAsync("reg", ["delete", ENV_KEY, "/v", ENV_NAME, "/f"], { windowsHide: true });
    } catch {
      // Not set: nothing to delete.
    }
    return;
  }

  await execFileAsync("reg", ["add", ENV_KEY, "/v", ENV_NAME, "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true });
}

/** `value` with every remote-debugging-port argument taken out. */
function withoutFlag(value: string | null): string | null {
  const parts = (value ?? "").split(/\s+/).filter((part) => part && !part.startsWith("--remote-debugging-port"));
  return parts.length ? parts.join(" ") : null;
}

/** True when a debug-port argument from an earlier run is still set. */
export async function leftover(): Promise<boolean> {
  return ((await readVariable()) ?? "").includes("--remote-debugging-port");
}

/**
 * Remove a debug-port argument left behind (crash, power loss). Keeps any
 * other argument the user set themselves. Returns true when something was
 * removed.
 */
export async function clearLeftover(): Promise<boolean> {
  const value = await readVariable();

  if (!value || !value.includes("--remote-debugging-port")) {
    return false;
  }

  await writeVariable(withoutFlag(value));
  return true;
}

// ============================================================
// Start the app with a debug port
// ============================================================

async function installLocation(pkg = DESKTOP_APP_PACKAGE): Promise<string> {
  const name = pkg.split("_")[0];
  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-AppxPackage -Name '${name}').InstallLocation`],
    { timeout: 30_000, windowsHide: true },
  );
  const lines = stdout.trim().split(/\r?\n/);
  return stdout.trim() ? lines[lines.length - 1]!.trim() : "";
}

/** Start the app inside its package, with a fresh user environment. */
async function launchInPackage(pkg = DESKTOP_APP_PACKAGE, appId = DESKTOP_APP_ID): Promise<void> {
  const location = await installLocation(pkg);

  if (!location) {
    throw new DevToolsError(`package ${pkg} tidak ditemukan`);
  }

  const exe = `${location}\\${DESKTOP_APP_EXE}`;

  try {
    await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Invoke-CommandInDesktopPackage -PackageFamilyName '${pkg}' -AppId '${appId}' -Command '${exe}' -PreventBreakaway`,
      ],
      { timeout: 30_000, windowsHide: true },
    );
  } catch {
    // The attach step reports an app that did not come up.
  }
}

export interface DevToolsTarget {
  type?: string;
  url?: string;
  title?: string;
}

/** Pages on the debug port (empty while it is not up). */
export async function targets(port = DEFAULT_PORT, timeoutMs = 2000): Promise<DevToolsTarget[]> {
  try {
    const response = await fetch(`http://127.0.0.1:${Math.trunc(port)}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await response.json()) as DevToolsTarget[];
  } catch {
    return [];
  }
}

/**
 * Close the app, start it with a debug port, and remove the variable. Returns
 * once the app answers on `port`; throws `DevToolsError` otherwise. The
 * variable is removed in every case.
 */
export async function startWithDebugging(port = DEFAULT_PORT, wait = 40): Promise<number> {
  await clearLeftover();

  if (!(await app.stop())) {
    throw new DevToolsError("app Microsoft Rewards tidak bisa ditutup");
  }

  const previous = await readVariable();
  const argument = flag(port);
  await writeVariable(previous ? `${previous} ${argument}`.trim() : argument);

  try {
    await launchInPackage();

    // The variable is only read when the app starts: remove it as soon as the
    // process is there.
    const deadline = Date.now() + 20_000;

    while (Date.now() < deadline && !(await app.isRunning())) {
      await sleep(300);
    }
  } finally {
    await writeVariable(previous);
  }

  const deadline = Date.now() + wait * 1000;

  while (Date.now() < deadline) {
    if ((await targets(port)).some((target) => target.type === "page")) {
      return port;
    }
    await sleep(500);
  }

  throw new DevToolsError(`app tidak membuka port debug ${port}`);
}

// ============================================================
// Selenium on the app
// ============================================================

function isRewards(url: string | undefined): boolean {
  const lowered = (url ?? "").toLowerCase();
  return lowered.includes("rewards.bing.com") || lowered.includes("rewards.microsoft.com");
}

/**
 * Selenium driver on the app's rewards page. Refuses to work on anything else:
 * another WebView2 app opened while the variable was set could hold the port
 * instead.
 */
export async function attach(port = DEFAULT_PORT, wait = 30): Promise<WebDriver> {
  const options = new edge.Options();
  options.debuggerAddress(`127.0.0.1:${Math.trunc(port)}`);

  const service = new edge.ServiceBuilder(EDGE_DRIVER_PATH).setStdio("ignore");

  const driver = await new Builder()
    .forBrowser("MicrosoftEdge")
    .setEdgeService(service)
    .setEdgeOptions(options)
    .build();

  // Never wait minutes on a page the app keeps "loading".
  try {
    await driver.manage().setTimeouts({ pageLoad: 30_000, script: 15_000 });
  } catch {
    // Not fatal.
  }

  const deadline = Date.now() + wait * 1000;

  while (Date.now() < deadline) {
    for (const handle of await driver.getAllWindowHandles()) {
      try {
        await driver.switchTo().window(handle);

        if (isRewards(await driver.getCurrentUrl())) {
          return driver;
        }
      } catch {
        continue;
      }
    }

    await sleep(1000);
  }

  const urls: string[] = [];

  for (const handle of await driver.getAllWindowHandles()) {
    try {
      await driver.switchTo().window(handle);
      urls.push(await driver.getCurrentUrl());
    } catch {
      // Ignore.
    }
  }

  await detach(driver);
  throw new DevToolsError("port debug bukan milik app Microsoft Rewards: " + urls.join(", ").slice(0, 200));
}

/** End the Selenium session (the app is closed separately). */
export async function detach(driver: WebDriver | null | undefined): Promise<void> {
  try {
    await driver?.quit();
  } catch {
    // Ignore.
  }
}
