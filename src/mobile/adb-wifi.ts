/**
 * Connect the phone to adb over Wi-Fi, so the mobile run needs no cable.
 *
 * Two ways, both on the same Wi-Fi network as the PC:
 *
 * - **Cable once** (`just mobile wifi usb`). With the phone plugged in,
 *   `adb tcpip 5555` switches its adb to TCP and the PC connects to
 *   `<phone ip>:5555`. The cable can then be removed. Works on any Android
 *   version; it lasts until the phone restarts.
 *
 * - **No cable at all** (`just mobile wifi pair`), Android 11+. Developer
 *   options → Wireless debugging → Pair device with pairing code shows an
 *   address and a 6-digit code; `adb pair` uses them once. After that the
 *   phone announces itself over mDNS whenever Wireless debugging is on, and
 *   `ensureConnected` finds and connects it.
 *
 * The address that worked is saved as MOBILE_ADB_WIFI in `.env`; every mobile
 * run calls `ensureConnected` first and reconnects when the phone is not
 * attached.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PROJECT_ROOT } from "../config/settings";
import { sleep } from "../utils/delay";
import { findAndroidHome, which } from "./appium-server";

const ENV_FILE = path.join(PROJECT_ROOT, ".env");
const ENV_KEY = "MOBILE_ADB_WIFI";
const SERIAL_KEY = "MOBILE_ADB_WIFI_DEVICE";

export const TCP_PORT = 5555;
const ADDRESS = /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/;

// ============================================================
// adb
// ============================================================

/** The adb Appium uses (ANDROID_HOME), so both talk to one server. */
export function adbPath(): string {
  const exe = process.platform === "win32" ? "adb.exe" : "adb";
  const home = findAndroidHome();

  if (home) {
    const candidate = path.join(home, "platform-tools", exe);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return which("adb") || "adb";
}

/** Run adb; returns `[exitCode, output]`. Never throws. */
export function adb(args: string[], timeoutSeconds = 30): Promise<[number, string]> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;

    const finish = (code: number, text: string) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve([code, text.trim()]);
      }
    };

    let child;

    try {
      child = spawn(adbPath(), args, { windowsHide: true });
    } catch (error) {
      resolve([1, String(error)]);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(1, "timeout");
    }, timeoutSeconds * 1000);

    child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));
    child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf-8")));
    child.once("error", (error) => finish(1, String(error)));
    child.once("close", (code) => finish(code ?? 1, output));
  });
}

/** `[serial, state]` from `adb devices`. */
export async function devices(): Promise<Array<[string, string]>> {
  const [, out] = await adb(["devices"]);
  const found: Array<[string, string]> = [];

  for (const line of out.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      found.push([parts[0]!, parts[1]!]);
    }
  }

  return found;
}

export async function readyDevices(): Promise<string[]> {
  return (await devices()).filter(([, state]) => state === "device").map(([serial]) => serial);
}

export function isWireless(serial: string): boolean {
  return ADDRESS.test(serial) || serial.includes("_adb-tls-connect");
}

export async function usbDevices(): Promise<string[]> {
  return (await readyDevices()).filter((serial) => !isWireless(serial));
}

export async function wirelessDevices(): Promise<string[]> {
  return (await readyDevices()).filter((serial) => isWireless(serial));
}

/** The phone's Wi-Fi IPv4 address, read over the current connection. */
export async function phoneIp(serial?: string): Promise<string> {
  const args = serial ? ["-s", serial] : [];
  const [, out] = await adb([...args, "shell", "ip", "-f", "inet", "addr", "show", "wlan0"]);
  return /inet (\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? "";
}

/** `adb connect`; true once the address is listed as a device. */
export async function connect(address: string, tries = 2): Promise<boolean> {
  for (let i = 0; i < tries; i += 1) {
    const [, out] = await adb(["connect", address], 15);
    await sleep(1000);

    if ((await readyDevices()).includes(address)) {
      return true;
    }

    const lowered = out.toLowerCase();
    if (lowered.includes("refused") || lowered.includes("failed")) {
      break;
    }
  }

  return false;
}

export type Endpoint = [serial: string, kind: "tcp" | "tls", address: string];

/**
 * Phones announcing adb on this network. `kind` is `tcp` for `adb tcpip` (port
 * 5555, no pairing) and `tls` for Wireless debugging. The phone keeps
 * announcing both after it changes network, so its new IP is found without a
 * cable.
 */
export async function mdnsEndpoints(): Promise<Endpoint[]> {
  const [, out] = await adb(["mdns", "services"]);
  const endpoints: Endpoint[] = [];

  for (const line of out.split(/\r?\n/)) {
    const match = /(\d+\.\d+\.\d+\.\d+:\d+)/.exec(line);

    if (!match) continue;

    const name = line.trim().split(/\s+/)[0] ?? "";
    const serial = name.replace(/^adb-/, "").split("-")[0] ?? "";

    if (line.includes("_adb-tls-connect")) {
      endpoints.push([serial, "tls", match[1]!]);
    } else if (line.includes("_adb._tcp")) {
      endpoints.push([serial, "tcp", match[1]!]);
    }
  }

  // Port 5555 first: it stays the same and needs no pairing.
  return endpoints.sort((a, b) => Number(a[1] !== "tcp") - Number(b[1] !== "tcp"));
}

export async function deviceSerial(address: string): Promise<string> {
  const [, out] = await adb(["-s", address, "shell", "getprop", "ro.serialno"]);
  return out.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

// ============================================================
// .env
// ============================================================

function readEnv(key: string): string {
  let value = process.env[key] ?? "";

  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, "utf-8").replace(/^﻿/, "").split(/\r?\n/)) {
      if (line.trim().startsWith(`${key}=`)) {
        value = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
  }

  return value.trim();
}

export function savedAddress(): string {
  return readEnv(ENV_KEY);
}

export function savedSerial(): string {
  return readEnv(SERIAL_KEY);
}

/** Remember the address (and the phone's serial) in .env. */
export async function saveAddress(address: string, serial = ""): Promise<void> {
  writeEnv(ENV_KEY, address);

  const resolved = serial || (await deviceSerial(address));

  if (resolved) {
    writeEnv(SERIAL_KEY, resolved);
  }
}

/** Write `key=value` into .env, keeping other lines. */
export function writeEnv(key: string, value: string): void {
  if (!fs.existsSync(ENV_FILE)) {
    fs.writeFileSync(ENV_FILE, "");
  }

  const raw = fs.readFileSync(ENV_FILE, "utf-8").replace(/^﻿/, "");
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  const entry = `${key}=${value}`;
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));

  if (index >= 0) {
    lines[index] = entry;
  } else {
    lines.push(entry);
  }

  fs.writeFileSync(ENV_FILE, lines.join(newline) + newline);
  process.env[key] = value;
}

// ============================================================
// Flows
// ============================================================

/** Cable plugged in → switch adb to TCP → connect over Wi-Fi. */
export async function setupOverUsb(log: (message: string) => void = console.log): Promise<string> {
  const usb = await usbDevices();

  if (!usb.length) {
    throw new Error("HP tidak terlihat lewat USB. Colok kabel, izinkan USB debugging, lalu ulangi.");
  }

  const serial = usb[0]!;
  const ip = await phoneIp(serial);

  if (!ip) {
    throw new Error("HP belum tersambung ke Wi-Fi (wlan0 tanpa IP).");
  }

  log(`HP ${serial} · Wi-Fi ${ip}`);
  log(`adb tcpip ${TCP_PORT}`);

  const [code, out] = await adb(["-s", serial, "tcpip", String(TCP_PORT)]);

  if (code !== 0) {
    throw new Error(`adb tcpip gagal: ${out}`);
  }

  // adbd restarts on the phone before it listens on the port.
  await sleep(3000);

  const address = `${ip}:${TCP_PORT}`;

  if (!(await connect(address, 3))) {
    throw new Error(`tidak bisa connect ke ${address}. PC dan HP harus di jaringan Wi-Fi yang sama.`);
  }

  await saveAddress(address, serial);
  return address;
}

/** Wireless debugging pairing (Android 11+), then connect. */
export async function pair(
  pairAddress: string,
  code: string,
  log: (message: string) => void = console.log,
): Promise<string> {
  const target = pairAddress.trim();

  if (!ADDRESS.test(target)) {
    throw new Error(`alamat pairing harus IP:PORT, misalnya 192.168.1.5:37123, dapat: ${JSON.stringify(target)}`);
  }

  log(`adb pair ${target}`);
  const [status, out] = await adb(["pair", target, String(code).trim()], 40);

  if (status !== 0 || !out.toLowerCase().includes("success")) {
    throw new Error(`pairing gagal: ${out || "tanpa keterangan"}`);
  }

  log("pairing berhasil · mencari HP lewat mDNS");

  const ip = target.split(":")[0]!;
  const address = await connectMdns(ip, 15, log);

  if (!address) {
    throw new Error(
      "pairing berhasil, tapi port koneksi tidak ditemukan. Jalankan " +
        "`just mobile wifi connect IP:PORT` dengan alamat di layar " +
        "Wireless debugging (bukan yang di dialog pairing).",
    );
  }

  await saveAddress(address);
  return address;
}

/** Connect to this phone (saved serial) as found over mDNS. */
async function connectMdns(preferIp = "", waitSeconds = 8, log?: (message: string) => void): Promise<string> {
  const mine = savedSerial();
  const deadline = Date.now() + waitSeconds * 1000;

  while (Date.now() < deadline) {
    let endpoints = await mdnsEndpoints();

    if (mine) {
      const ours = endpoints.filter((e) => e[0] === mine);
      endpoints = ours.length ? ours : endpoints;
    }

    endpoints.sort(
      (a, b) =>
        Number(a[1] !== "tcp") - Number(b[1] !== "tcp") ||
        Number(!a[2].startsWith(`${preferIp}:`)) - Number(!b[2].startsWith(`${preferIp}:`)),
    );

    for (const [, kind, address] of endpoints) {
      if ((await readyDevices()).includes(address)) {
        return address;
      }

      log?.(`adb connect ${address}  (${kind})`);

      if (await connect(address)) {
        return address;
      }
    }

    await sleep(1500);
  }

  return "";
}

/**
 * Make sure the phone is attached; reconnect over Wi-Fi when needed.
 *
 * Order: a phone already attached (USB first) → the phone found over mDNS on
 * this network (works after switching between home and office Wi-Fi: the
 * phone announces its new IP) → the last saved address. Returns the serial to
 * use, "" when none.
 */
export async function ensureConnected(log?: (message: string) => void, requireWireless = false): Promise<string> {
  const ready = await readyDevices();

  if (ready.length && !requireWireless) {
    const usb = ready.filter((serial) => !isWireless(serial));
    return (usb.length ? usb : ready)[0]!;
  }

  const wireless = await wirelessDevices();

  if (wireless.length) {
    return wireless[0]!;
  }

  const saved = savedAddress();

  const address = await connectMdns(saved ? saved.split(":")[0] : "", 8, log);

  if (address) {
    if (address !== saved) {
      await saveAddress(address);
    }
    return address;
  }

  if (saved) {
    log?.(`adb connect ${saved}`);

    if (await connect(saved)) {
      return saved;
    }
  }

  return ready[0] ?? "";
}

export async function disconnectAll(): Promise<string> {
  const [, out] = await adb(["disconnect"]);
  return out;
}
