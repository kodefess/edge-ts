/**
 * Drive the real Bing Android app through Appium.
 *
 * Read to Earn is only credited inside the Bing/MSN app, so an emulated
 * desktop browser can never earn those points even though it looks like a
 * phone to the website. This module attaches to an Appium server that is
 * connected to a real Android phone, so the signed-in Bing account on that
 * phone gets the credit.
 *
 * The app UI changes often, so nothing here hard-codes the news selectors.
 * `readNodes` returns the current UI tree, `findNodes` looks for text or
 * content descriptions, and the diagnostic script writes the raw XML so
 * selectors can be derived from a real screen instead of guessed.
 *
 * Appium speaks the W3C WebDriver protocol, so this is a small fetch-based
 * client instead of a library: no extra dependency is needed.
 */
import fs from "node:fs";
import path from "node:path";

import {
  MOBILE_APPIUM_APP_ACTIVITY,
  MOBILE_APPIUM_APP_PACKAGE,
  MOBILE_APPIUM_DEVICE_NAME,
  MOBILE_APPIUM_NO_RESET,
  MOBILE_APPIUM_PLATFORM_VERSION,
  MOBILE_APPIUM_SERVER,
  MOBILE_APPIUM_TIMEOUT,
  MOBILE_APPIUM_UDID,
} from "../config/settings";
import { sleep } from "../utils/delay";

export class AppiumUnavailable extends Error {
  override name = "AppiumUnavailable";
}

// ============================================================
// UI tree helpers (no Appium dependency)
// ============================================================

export type Rect = [number, number, number, number];

/** One node from the Android accessibility tree. */
export class UiNode {
  text = "";
  desc = "";
  resourceId = "";
  className = "";
  package = "";
  clickable = false;
  enabled = true;
  bounds = "";
  x = 0;
  y = 0;
  /** Rectangle of the nearest clickable ancestor (or the node itself): the card a tap lands in. */
  container: Rect = [0, 0, 0, 0];
  depth = 0;

  constructor(init: Partial<UiNode> = {}) {
    Object.assign(this, init);
  }

  get rect(): Rect {
    return parseRect(this.bounds);
  }

  inside(rect: Rect): boolean {
    const [x1, y1, x2, y2] = rect;
    return x1 <= this.x && this.x <= x2 && y1 <= this.y && this.y <= y2;
  }

  get label(): string {
    return (this.text || this.desc || "").trim();
  }

  matches(words: Iterable<string>): boolean {
    const label = this.label.toLowerCase();

    if (!label) {
      return false;
    }

    for (const word of words) {
      if (label.includes(word.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  asDict(): Record<string, unknown> {
    return {
      text: this.text,
      desc: this.desc,
      resource_id: this.resourceId,
      class: this.className,
      package: this.package,
      clickable: this.clickable,
      enabled: this.enabled,
      bounds: this.bounds,
      x: this.x,
      y: this.y,
    };
  }
}

/** Turn `[x1,y1][x2,y2]` into `[x1, y1, x2, y2]`. */
export function parseRect(bounds: string | undefined): Rect {
  const digits: number[] = [];

  for (const chunk of String(bounds ?? "").replace(/[[\]]/g, " ").split(/\s+/).filter(Boolean)) {
    for (const part of chunk.split(",")) {
      const value = Number.parseInt(part, 10);
      digits.push(Number.isNaN(value) ? 0 : value);
    }
  }

  if (digits.length < 4) {
    return [0, 0, 0, 0];
  }

  return [digits[0]!, digits[1]!, digits[2]!, digits[3]!];
}

/** Turn `[x1,y1][x2,y2]` into a centre point. */
export function parseBounds(bounds: string | undefined): [number, number] {
  const [x1, y1, x2, y2] = parseRect(bounds);
  return [Math.floor((x1 + x2) / 2), Math.floor((y1 + y2) / 2)];
}

// --- A small XML reader for UiAutomator dumps --------------------------------

interface XmlElement {
  tag: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? match;
  });
}

/** Parse the (well-formed, attribute-only) XML UiAutomator2 produces. Returns undefined on malformed input. */
function parseXml(source: string): XmlElement | undefined {
  const token = /<(\/?)([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<[?!][^>]*>/g;
  const attribute = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

  const root: XmlElement = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];

  for (const match of source.matchAll(token)) {
    const [, closing, tag, rawAttrs, selfClosing] = match;

    if (tag === undefined) {
      continue; // declaration / comment
    }

    if (closing) {
      if (stack.length < 2 || stack[stack.length - 1]!.tag !== tag) {
        return undefined;
      }
      stack.pop();
      continue;
    }

    const attrs: Record<string, string> = {};
    for (const found of (rawAttrs ?? "").matchAll(attribute)) {
      attrs[found[1]!] = decodeEntities(found[2] ?? found[3] ?? "");
    }

    const element: XmlElement = { tag, attrs, children: [] };
    stack[stack.length - 1]!.children.push(element);

    if (!selfClosing) {
      stack.push(element);
    }
  }

  if (stack.length !== 1 || root.children.length !== 1) {
    return undefined;
  }

  return root.children[0];
}

/**
 * Return every node in an Android `page_source` dump.
 *
 * Nodes keep document order. Each one also records the rectangle of its
 * nearest clickable ancestor, so a title and a "Sponsored" badge in the same
 * card can be grouped without a selector for the card itself.
 */
export function parseHierarchy(source: string | undefined): UiNode[] {
  if (!source || !source.trim()) {
    return [];
  }

  const root = parseXml(source);

  if (!root) {
    return [];
  }

  // UiAutomator2 names elements after their class
  // (<android.widget.TextView .../>); older dumps use <node .../>. Both carry
  // the same attributes, so every element is a node.
  const nodes: UiNode[] = [];

  const walk = (element: XmlElement, container: Rect, depth: number): void => {
    for (const child of element.children) {
      const bounds = child.attrs["bounds"] ?? "";
      const rect = parseRect(bounds);
      const [x, y] = parseBounds(bounds);
      const clickable = child.attrs["clickable"] === "true";
      const own: Rect = clickable && rect.some(Boolean) ? rect : container;

      nodes.push(
        new UiNode({
          text: child.attrs["text"] ?? "",
          desc: child.attrs["content-desc"] ?? "",
          resourceId: child.attrs["resource-id"] ?? "",
          className: child.attrs["class"] || child.tag,
          package: child.attrs["package"] ?? "",
          clickable,
          enabled: child.attrs["enabled"] !== "false",
          bounds,
          x,
          y,
          container: own,
          depth,
        }),
      );

      walk(child, own, depth + 1);
    }
  };

  walk(root, [0, 0, 0, 0], 0);

  return nodes;
}

/** Nodes whose visible label contains one of `words`. */
export function findNodes(nodes: UiNode[], words: Iterable<string>, clickableOnly = false): UiNode[] {
  const list = [...words];

  return nodes.filter((node) => (!clickableOnly || node.clickable) && node.matches(list));
}

// ============================================================
// Appium session (W3C over HTTP)
// ============================================================

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** Minimal Appium/W3C client: just what the Bing app driver needs. */
export class AppiumDriver {
  /** Capabilities the server reported. */
  capabilities: Record<string, unknown> = {};

  private constructor(
    private readonly server: string,
    private readonly sessionId: string,
  ) {}

  static async create(server: string, capabilities: Record<string, unknown>): Promise<AppiumDriver> {
    const base = server.replace(/\/+$/, "");
    const response = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      value?: { sessionId?: string; capabilities?: Record<string, unknown>; error?: string; message?: string };
    };

    const value = body.value ?? {};

    if (!response.ok || !value.sessionId) {
      throw new Error(value.message || value.error || `HTTP ${response.status}`);
    }

    const driver = new AppiumDriver(base, value.sessionId);
    driver.capabilities = value.capabilities ?? {};
    return driver;
  }

  private async request<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.server}/session/${this.sessionId}${route}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const parsed = (await response.json().catch(() => ({}))) as {
      value?: T & { error?: string; message?: string };
    };

    if (!response.ok) {
      const value = parsed.value as { error?: string; message?: string } | undefined;
      throw new Error(value?.message || value?.error || `HTTP ${response.status}`);
    }

    return parsed.value as T;
  }

  /** `mobile: <command>` extension call. */
  mobile<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>("POST", "/execute/sync", { script: `mobile: ${command}`, args: [args] });
  }

  async pageSource(): Promise<string> {
    return (await this.request<string>("GET", "/source")) || "";
  }

  async windowSize(): Promise<{ width: number; height: number }> {
    const rect = await this.request<{ width?: number; height?: number }>("GET", "/window/rect");
    return { width: Math.trunc(rect?.width ?? 0), height: Math.trunc(rect?.height ?? 0) };
  }

  async back(): Promise<void> {
    await this.request("POST", "/back", {});
  }

  async setPageLoadTimeout(seconds: number): Promise<void> {
    await this.request("POST", "/timeouts", { pageLoad: seconds * 1000 });
  }

  async setImplicitWait(seconds: number): Promise<void> {
    await this.request("POST", "/timeouts", { implicit: seconds * 1000 });
  }

  async currentPackage(): Promise<string> {
    return (await this.request<string>("GET", "/appium/device/current_package")) || "";
  }

  async currentActivity(): Promise<string> {
    return (await this.request<string>("GET", "/appium/device/current_activity")) || "";
  }

  async activateApp(appId: string): Promise<void> {
    await this.mobile("activateApp", { appId });
  }

  async terminateApp(appId: string): Promise<boolean> {
    return Boolean(await this.mobile("terminateApp", { appId }));
  }

  async startActivity(appPackage: string, activity?: string): Promise<void> {
    await this.mobile("startActivity", { intent: activity ? `${appPackage}/${activity}` : appPackage });
  }

  async pressKeyCode(keycode: number): Promise<void> {
    await this.mobile("pressKey", { keycode });
  }

  async tap(x: number, y: number): Promise<void> {
    await this.mobile("clickGesture", { x, y });
  }

  async longPress(x: number, y: number, durationMs = 800): Promise<void> {
    await this.mobile("longClickGesture", { x, y, duration: durationMs });
  }

  /** Thumb swipe from (x1, y1) to (x2, y2) over `durationMs`. */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs = 400): Promise<void> {
    await this.request("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: x1, y: y1 },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 },
            { type: "pointerMove", duration: durationMs, x: x2, y: y2 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await this.request("DELETE", "/actions").catch(() => undefined);
  }

  /** The screen as PNG bytes. */
  async screenshotPng(): Promise<Buffer> {
    const data = await this.request<string>("GET", "/screenshot");
    return Buffer.from(data, "base64");
  }

  async screenshot(file: string): Promise<void> {
    fs.writeFileSync(file, await this.screenshotPng());
  }

  async shell(command: string, args: string[] = []): Promise<string> {
    return String((await this.mobile("shell", { command, args })) ?? "");
  }

  /** Find an element by UiAutomator selector and return its element id. */
  async findByUiAutomator(selector: string): Promise<string | undefined> {
    try {
      const found = await this.request<Record<string, string>>("POST", "/element", {
        using: "-android uiautomator",
        value: selector,
      });
      return found?.[ELEMENT_KEY];
    } catch {
      return undefined;
    }
  }

  async setClipboard(text: string): Promise<void> {
    await this.mobile("setClipboard", { content: Buffer.from(text, "utf-8").toString("base64"), contentType: "plaintext" });
  }

  async quit(): Promise<void> {
    await fetch(`${this.server}/session/${this.sessionId}`, { method: "DELETE" });
  }
}

/** True when an Appium server answers at `server`. */
export async function appiumAvailable(server = MOBILE_APPIUM_SERVER): Promise<boolean> {
  try {
    const response = await fetch(`${server.replace(/\/+$/, "")}/status`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

export interface AppDriverOptions {
  server?: string;
  udid?: string | null;
  appPackage?: string;
  appActivity?: string | null;
}

/** Connect to Appium and prepare the phone session (the app is launched by `launchApp`). */
export async function createAppDriver(options: AppDriverOptions = {}): Promise<AppiumDriver> {
  const server = (options.server || MOBILE_APPIUM_SERVER).trim();
  const udid = (options.udid ?? MOBILE_APPIUM_UDID).trim();
  const appPackage = (options.appPackage || MOBILE_APPIUM_APP_PACKAGE).trim();
  const appActivity = (options.appActivity ?? MOBILE_APPIUM_APP_ACTIVITY).trim();

  const capabilities: Record<string, unknown> = {
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:deviceName": MOBILE_APPIUM_DEVICE_NAME || "Android",
    "appium:noReset": MOBILE_APPIUM_NO_RESET,
    "appium:newCommandTimeout": Math.max(120, MOBILE_APPIUM_TIMEOUT * 4),
    // OPPO / realme / Xiaomi block `settings delete global hidden_api_policy*`
    // from adb (exit 255), which aborts the session. The policy is only
    // needed for reflection-based helpers we don't use.
    "appium:ignoreHiddenApiPolicyError": true,
    // The first run installs the uiautomator2 server APKs. ColorOS / MIUI
    // hold every USB install behind an on-screen "Install via USB" prompt,
    // so the default 20 s timeout expires before anyone can tap it.
    "appium:uiautomator2ServerInstallTimeout": 120000,
    "appium:adbExecTimeout": 120000,
  };

  if (udid) {
    capabilities["appium:udid"] = udid;
  }

  if (MOBILE_APPIUM_PLATFORM_VERSION) {
    capabilities["appium:platformVersion"] = MOBILE_APPIUM_PLATFORM_VERSION;
  }

  // The session starts without launching the app. Bing opens through an
  // activity alias (LauncherAlias) that immediately hands over to another
  // activity, so Appium's own launch waits for an activity that never
  // appears and fails. launchApp() opens it afterwards with activateApp. An
  // explicit MOBILE_APPIUM_APP_ACTIVITY still launches at start.
  if (appPackage && appActivity) {
    capabilities["appium:appPackage"] = appPackage;
    capabilities["appium:appActivity"] = appActivity;
    capabilities["appium:appWaitActivity"] = "*";
  }

  let driver: AppiumDriver;

  try {
    driver = await AppiumDriver.create(server, capabilities);
  } catch (error) {
    // The server appends its Node stack trace; the first line is enough.
    const reason =
      String(error instanceof Error ? error.message : error)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("at ")) ?? "error";

    throw new AppiumUnavailable(
      `tidak bisa terhubung ke Appium di ${server}: ${reason}\n` +
        "Pastikan server Appium jalan dan HP terlihat di `adb devices`.",
    );
  }

  await driver.setImplicitWait(0).catch(() => undefined);
  await driver.setPageLoadTimeout(MOBILE_APPIUM_TIMEOUT).catch(() => undefined);

  return driver;
}

/** Bring the Bing app to the foreground. */
export async function launchApp(driver: AppiumDriver, appPackage?: string): Promise<boolean> {
  const target = (appPackage || MOBILE_APPIUM_APP_PACKAGE).trim();

  if (!target) {
    return false;
  }

  try {
    await driver.activateApp(target);
  } catch {
    try {
      await driver.startActivity(target, MOBILE_APPIUM_APP_ACTIVITY || undefined);
    } catch {
      return false;
    }
  }

  // A cold start (after a crash or a restart) shows a splash first; wait
  // until the app is in front instead of acting on the launcher.
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    await sleep(1000);

    if ((await currentPackage(driver)) === target) {
      await sleep(1500);
      return true;
    }
  }

  return (await currentPackage(driver)) === target;
}

export async function currentPackage(driver: AppiumDriver): Promise<string> {
  try {
    return await driver.currentPackage();
  } catch {
    // Newer Appium servers dropped the legacy route: read it from the dump.
    try {
      const nodes = parseHierarchy(await driver.pageSource());
      return nodes.find((node) => node.package && node.package !== "com.android.systemui")?.package ?? "";
    } catch {
      return "";
    }
  }
}

export async function screenSize(driver: AppiumDriver): Promise<[number, number]> {
  try {
    const size = await driver.windowSize();
    return [size.width, size.height];
  } catch {
    return [0, 0];
  }
}

// ============================================================
// System dialogs
// ============================================================

// Windows that are not Bing but block it: the "isn't responding" / "keeps
// stopping" dialogs, "storage almost full", the notification shade, and the
// phone maker's security or cleaner pop-ups.
export const SYSTEM_PACKAGES = [
  "android",
  "com.android.systemui",
  "com.android.settings",
  "com.android.permissioncontroller",
  "com.google.android.permissioncontroller",
  "com.android.packageinstaller",
  "com.google.android.packageinstaller",
  "com.miui.",
  "com.xiaomi.",
  "com.coloros.",
  "com.oplus.",
  "com.oppo.",
  "com.heytap.",
  "com.realme.",
  "com.samsung.android.lool",
  "com.samsung.android.sm",
  "com.vivo.",
  "com.iqoo.",
  "com.huawei.systemmanager",
];

const ANR_WORDS = ["isn't responding", "not responding", "tidak merespons", "tidak menanggapi"];
const CRASH_WORDS = ["keeps stopping", "has stopped", "terus berhenti", "telah berhenti"];
const WAIT_BUTTONS = ["wait", "tunggu"];
const CLOSE_APP_BUTTONS = ["close app", "tutup aplikasi", "close", "tutup", "ok"];

// Only answers that leave everything as it was. Never "Clean up", "Free up
// space", "Allow", "Uninstall", "Delete" or "Install".
const SAFE_BUTTONS = [
  "ok", "oke", "got it", "mengerti", "dismiss", "abaikan", "cancel",
  "batal", "close", "tutup", "not now", "tidak sekarang", "later",
  "nanti", "lain kali", "no thanks", "tidak, terima kasih", "skip",
  "lewati", "deny", "tolak", "don't allow", "jangan izinkan",
];

let dialogLog: ((message: string) => void) | undefined;
let anrWaits: number[] = [];

/** Where `readNodes` reports the system dialogs it closes. */
export function setDialogLog(log: ((message: string) => void) | undefined): void {
  dialogLog = log;
}

export function isSystemPackage(name: string | undefined, appPackage?: string): boolean {
  const value = (name ?? "").trim();
  const app = (appPackage || MOBILE_APPIUM_APP_PACKAGE).trim();

  if (!value || value === app) {
    return false;
  }

  return SYSTEM_PACKAGES.some((item) => value === item || (item.endsWith(".") && value.startsWith(item)));
}

/** First clickable node whose label is one of `labels` (exact). */
function button(nodes: UiNode[], labels: string[]): UiNode | undefined {
  for (const wanted of labels) {
    for (const node of nodes) {
      if (node.label.trim().toLowerCase() === wanted && (node.clickable || node.container.some(Boolean))) {
        return node;
      }
    }
  }

  return undefined;
}

/**
 * `[kind, node]` for a system window in front, or `[undefined, undefined]`.
 *
 * `node` is the button to tap; `undefined` with a kind means press back. Pure,
 * so it can be checked against a saved dump.
 */
export function systemDialogAction(
  nodes: UiNode[],
  appPackage?: string,
  anrWaitCount = 0,
): [string | undefined, UiNode | undefined] {
  const app = (appPackage || MOBILE_APPIUM_APP_PACKAGE).trim();

  // Some phones put the status bar (com.android.systemui: clock, date, icons)
  // in every dump, next to the app. It is always there and is never a pop-up,
  // so system windows are judged by what they say, and the app being on
  // screen settles the rest.
  const system = nodes.filter((n) => isSystemPackage(n.package, app));

  if (!system.length) {
    return [undefined, undefined];
  }

  // 1. Android's own "not responding" / "keeps stopping" dialogs.
  const framework = system.filter((n) => n.package === "android");
  const text = framework
    .filter((n) => n.label)
    .map((n) => n.label.toLowerCase())
    .join(" ");

  if (ANR_WORDS.some((word) => text.includes(word))) {
    // Waiting usually lets a slow (low-storage) Bing recover; after two waits
    // it is frozen, so close it and let the caller relaunch.
    if (anrWaitCount < 2) {
      const wait = button(framework, WAIT_BUTTONS);
      if (wait) {
        return ["app tidak merespons · tunggu", wait];
      }
    }

    const close = button(framework, CLOSE_APP_BUTTONS);
    return close ? ["app tidak merespons · tutup", close] : [undefined, undefined];
  }

  if (CRASH_WORDS.some((word) => text.includes(word))) {
    const close = button(framework, CLOSE_APP_BUTTONS);
    return close ? ["app berhenti · tutup", close] : [undefined, undefined];
  }

  // 2. Another system window with a harmless answer (storage almost full,
  //    the phone maker's cleaner or security prompt). The status bar and
  //    navigation bar are skipped: they have no such buttons.
  const owners = system.filter((n) => n.package !== "com.android.systemui");
  const safe = button(owners, SAFE_BUTTONS);

  if (safe) {
    const title = owners.find((n) => n.package === safe.package && n.label.length >= 6)?.label ?? safe.package;
    return [`popup sistem · ${title.slice(0, 40)}`, safe];
  }

  // 3. The notification shade pulled down over the app: the app itself is not
  //    in the dump, only System UI. Back closes the shade. With the app on
  //    screen nothing is pressed: a back there leaves Bing.
  if (nodes.some((n) => n.package === app)) {
    return [undefined, undefined];
  }

  if (nodes.filter((n) => n.package).every((n) => n.package === "com.android.systemui")) {
    return ["panel notifikasi · tutup", undefined];
  }

  return [undefined, undefined];
}

async function handleSystemDialog(driver: AppiumDriver, nodes: UiNode[]): Promise<boolean> {
  const now = Date.now();
  anrWaits = anrWaits.filter((t) => now - t < 90_000);

  const [kind, node] = systemDialogAction(nodes, undefined, anrWaits.length);

  if (kind === undefined) {
    return false;
  }

  if (kind.endsWith("tunggu")) {
    anrWaits.push(now);
  }

  if (node) {
    await tapNode(driver, node);
  } else {
    await goBack(driver);
  }

  dialogLog?.(kind);

  await sleep(kind.endsWith("tunggu") ? 4000 : 1500);
  return true;
}

/**
 * Return the nodes of the current screen.
 *
 * With `guard` a system dialog in front of the app (not responding, stopped,
 * storage full, notification shade…) is closed first, so every caller sees
 * Bing instead of being stuck on a window it doesn't know.
 */
export async function readNodes(driver: AppiumDriver, guard = true): Promise<UiNode[]> {
  let nodes: UiNode[] = [];

  for (let i = 0; i < 4; i += 1) {
    let source: string;

    try {
      source = (await driver.pageSource()) || "";
    } catch {
      return [];
    }

    nodes = parseHierarchy(source);

    if (!guard || !(await handleSystemDialog(driver, nodes))) {
      return nodes;
    }
  }

  return nodes;
}

/** Write the raw XML to `file` for selector debugging. */
export async function dumpHierarchy(driver: AppiumDriver, file: string): Promise<string> {
  let source: string;

  try {
    source = (await driver.pageSource()) || "";
  } catch {
    return "";
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source, "utf-8");
    return file;
  } catch {
    return "";
  }
}

export async function dumpScreenshot(driver: AppiumDriver, file: string): Promise<string> {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await driver.screenshot(file);
    return file;
  } catch {
    return "";
  }
}

/** Tap the centre of `node` without rebuilding a selector. */
export async function tapNode(driver: AppiumDriver, node: UiNode): Promise<boolean> {
  if (node.x <= 0 && node.y <= 0) {
    return false;
  }

  try {
    await driver.tap(node.x, node.y);
    return true;
  } catch {
    return false;
  }
}

/** Tap the first node whose label contains one of `words`. */
export async function tapWords(
  driver: AppiumDriver,
  words: Iterable<string>,
  clickableOnly = true,
  nodes?: UiNode[],
): Promise<UiNode | undefined> {
  const list = nodes ?? (await readNodes(driver));
  const found = findNodes(list, words, clickableOnly);

  if (!found.length) {
    return undefined;
  }

  const node = found[0]!;

  return (await tapNode(driver, node)) ? node : undefined;
}

/** Return the nodes once one of `words` is on screen ([] on timeout). */
export async function waitForWords(
  driver: AppiumDriver,
  words: Iterable<string>,
  timeout: number = MOBILE_APPIUM_TIMEOUT,
): Promise<UiNode[]> {
  const list = [...words];
  const deadline = Date.now() + Math.max(1, Math.trunc(timeout)) * 1000;

  while (Date.now() < deadline) {
    const nodes = await readNodes(driver);

    if (findNodes(nodes, list).length) {
      return nodes;
    }

    await sleep(600);
  }

  return [];
}

/** Scroll the current screen up like a thumb swipe. */
export async function swipeUp(driver: AppiumDriver, ratio = 0.65): Promise<boolean> {
  const [width, height] = await screenSize(driver);

  if (!width || !height) {
    return false;
  }

  const x = Math.floor(width / 2);
  const start = Math.trunc(height * 0.8);
  const end = Math.trunc(height * (0.8 - ratio));

  try {
    await driver.swipe(x, start, x, end, 400);
    return true;
  } catch {
    return false;
  }
}

export async function goBack(driver: AppiumDriver): Promise<boolean> {
  try {
    await driver.back();
    return true;
  } catch {
    return false;
  }
}

/** Unique non-empty labels, in screen order (first node for each). */
export function visibleLabels(nodes: UiNode[]): UiNode[] {
  const seen: UiNode[] = [];
  const labels = new Set<string>();

  for (const node of nodes) {
    const label = node.label;

    if (!label || labels.has(label)) {
      continue;
    }

    labels.add(label);
    seen.push(node);
  }

  return seen;
}

/** Small object for the diagnostic header. */
export async function describeSession(driver: AppiumDriver): Promise<{
  package: string;
  width: number;
  height: number;
  capabilities: Record<string, unknown>;
}> {
  const [width, height] = await screenSize(driver);
  const keep = ["platformName", "platformVersion", "deviceName", "udid", "appPackage", "automationName"];
  const capabilities: Record<string, unknown> = {};

  for (const key of keep) {
    const value = driver.capabilities[key] ?? driver.capabilities[`appium:${key}`];
    if (value) {
      capabilities[key] = value;
    }
  }

  return { package: await currentPackage(driver), width, height, capabilities };
}
