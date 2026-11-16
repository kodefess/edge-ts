import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { sleep } from "./delay";

const execFileAsync = promisify(execFile);

/**
 * Close existing Edge and EdgeDriver processes.
 *
 * Edge locks the profile directory, so any running instance must be stopped
 * before Selenium can use the copied profile.
 *
 * Note: on Windows this terminates *all* msedge.exe processes, including
 * windows the user opened manually. Set CLOSE_EXISTING_EDGE=false in .env to
 * skip this step.
 */
export async function closeRunningEdge(): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  for (const image of ["msedge.exe", "msedgedriver.exe"]) {
    try {
      await execFileAsync("taskkill", ["/F", "/IM", image, "/T"], { windowsHide: true });
    } catch {
      // Process may not be running.
    }
  }

  await sleep(2000);
}
