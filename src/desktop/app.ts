/** Find, open and close the Microsoft Rewards desktop app. */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { DESKTOP_APP_EXE, DESKTOP_APP_ID, DESKTOP_APP_PACKAGE } from "../config/settings";
import { sleep } from "../utils/delay";

const execFileAsync = promisify(execFile);

/** `%LOCALAPPDATA%\Packages\<family>`: the app's own data. */
export function packageDir(pkg = DESKTOP_APP_PACKAGE): string {
  return path.join(process.env["LOCALAPPDATA"] ?? "", "Packages", pkg);
}

/** The WebView2 user data folder: cookies, storage, the sign-in. */
export function webviewDir(pkg = DESKTOP_APP_PACKAGE): string {
  return path.join(packageDir(pkg), "LocalState", "webview", "content", "EBWebView");
}

export function installed(pkg = DESKTOP_APP_PACKAGE): boolean {
  return fs.existsSync(packageDir(pkg)) && fs.statSync(packageDir(pkg)).isDirectory();
}

async function tasklist(exe = DESKTOP_APP_EXE): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("tasklist", ["/FI", `IMAGENAME eq ${exe}`, "/FO", "CSV", "/NH"], {
      timeout: 15_000,
      windowsHide: true,
    });

    return stdout.split(/\r?\n/).filter((line) => line.toLowerCase().includes(exe.toLowerCase()));
  } catch {
    return [];
  }
}

export async function isRunning(exe = DESKTOP_APP_EXE): Promise<boolean> {
  return (await tasklist(exe)).length > 0;
}

/** Open the app the way the Start menu does. True once it runs. */
export async function start(pkg = DESKTOP_APP_PACKAGE, appId = DESKTOP_APP_ID, wait = 15): Promise<boolean> {
  try {
    spawn("explorer.exe", [`shell:AppsFolder\\${pkg}!${appId}`], { stdio: "ignore", detached: true }).unref();
  } catch {
    return false;
  }

  const deadline = Date.now() + wait * 1000;

  while (Date.now() < deadline) {
    if (await isRunning()) {
      return true;
    }
    await sleep(500);
  }

  return false;
}

/**
 * Close the app and its WebView2 helpers. True once it is gone. A polite close
 * first (the app writes its cookies on exit), then a forced one when it is
 * still there.
 */
export async function stop(exe = DESKTOP_APP_EXE, wait = 15): Promise<boolean> {
  if (!(await isRunning(exe))) {
    return true;
  }

  for (const force of [false, true]) {
    const args = ["/IM", exe, "/T"];

    if (force) {
      args.push("/F");
    }

    try {
      await execFileAsync("taskkill", args, { timeout: 15_000, windowsHide: true });
    } catch {
      // Not running, or refused: checked below.
    }

    const deadline = Date.now() + (wait / 2) * 1000;

    while (Date.now() < deadline) {
      if (!(await isRunning(exe))) {
        // WebView2 releases its files a moment after the host.
        await sleep(1500);
        return true;
      }
      await sleep(500);
    }
  }

  return !(await isRunning(exe));
}
