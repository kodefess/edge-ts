import { execFile } from "node:child_process";

import { promisify } from "node:util";

import { sleep } from "./delay.js";

const execFileAsync = promisify(execFile);

export async function closeRunningEdge(): Promise<void> {
  try {
    await execFileAsync("taskkill", ["/F", "/IM", "msedge.exe", "/T"]);
  } catch {
    // Process may not be running.
  }

  try {
    await execFileAsync("taskkill", ["/F", "/IM", "msedgedriver.exe", "/T"]);
  } catch {
    // Process may not be running.
  }

  await sleep(2000);
}
