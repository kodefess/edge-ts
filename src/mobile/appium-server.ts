/**
 * Start a local Appium server for a standalone mobile run.
 *
 * `just mobile run` should work with one command, so when nothing listens on
 * MOBILE_APPIUM_SERVER (and it points at this machine) the run starts
 * `appium` itself, with ANDROID_HOME filled in when it is missing, and stops
 * it afterwards. A server that was already running is left alone.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { sleep } from "../utils/delay";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

function hostPort(url: string): [string, number] {
  const parsed = new URL(url);
  return [parsed.hostname.replace(/^\[|\]$/g, "") || "127.0.0.1", Number(parsed.port) || 4723];
}

export function isListening(url: string, timeoutMs = 1000): Promise<boolean> {
  const [host, port] = hostPort(url);

  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** A folder that contains `platform-tools/adb`, or "". */
export function findAndroidHome(): string {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates = [
    process.env["ANDROID_HOME"] ?? "",
    process.env["ANDROID_SDK_ROOT"] ?? "",
    path.join(process.env["LOCALAPPDATA"] ?? "", "Android", "Sdk"),
    "C:\\ProgramData\\chocolatey\\lib\\adb\\tools",
    path.join(os.homedir(), "Android", "Sdk"),
    path.join(os.homedir(), "Library", "Android", "sdk"),
  ];

  return candidates.find((folder) => folder && fs.existsSync(path.join(folder, "platform-tools", exe))) ?? "";
}

/** Find an executable on PATH (like Python's shutil.which). */
export function which(name: string): string {
  const extensions = process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];

  for (const folder of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!folder) continue;

    for (const extension of ["", ...extensions]) {
      const candidate = path.join(folder, name + extension.toLowerCase());

      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
  }

  return "";
}

/** Ensure a server; stop it only if we started it. Use `start()` / `stop()`. */
export class AppiumServer {
  private process: ChildProcess | undefined;
  readonly logPath = path.join(os.tmpdir(), "edgets-appium.log");

  constructor(
    private readonly url: string,
    private readonly autostart = true,
    private readonly log?: (message: string) => void,
    private readonly timeout = 60,
  ) {}

  private say(message: string): void {
    this.log?.(message);
  }

  async start(): Promise<this> {
    if (await isListening(this.url)) {
      return this;
    }

    const [host, port] = hostPort(this.url);

    if (!this.autostart || !LOCAL_HOSTS.has(host)) {
      return this;
    }

    const command = which("appium");

    if (!command) {
      this.say("appium tidak ditemukan di PATH · jalankan `just mobile setup`");
      return this;
    }

    const env = { ...process.env };
    const home = findAndroidHome();

    if (home) {
      env["ANDROID_HOME"] = home;
    } else {
      this.say("platform-tools tidak ditemukan · set ANDROID_HOME");
    }

    this.say(`menyalakan Appium di port ${port}`);

    const handle = fs.openSync(this.logPath, "w");

    this.process = spawn(command, ["-p", String(port)], {
      stdio: ["ignore", handle, handle],
      env,
      windowsHide: true,
      // appium is a .cmd shim on Windows.
      shell: process.platform === "win32",
    });

    const deadline = Date.now() + this.timeout * 1000;

    while (Date.now() < deadline) {
      if (await isListening(this.url)) {
        return this;
      }
      if (this.process.exitCode !== null) {
        break;
      }
      await sleep(500);
    }

    this.say(`Appium tidak menyala · log: ${this.logPath}`);
    return this;
  }

  stop(): void {
    const child = this.process;

    if (!child || child.exitCode !== null || child.pid === undefined) {
      return;
    }

    try {
      if (process.platform === "win32") {
        // appium is a .cmd shim: kill the node child too.
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // Ignore.
    }
  }
}
