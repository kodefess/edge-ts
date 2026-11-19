/**
 * Read to Earn inside the real Bing Android app through Appium.
 *
 * 1. open the app and close first-run popups,
 * 2. reach the news feed (home feed, or a Discover / News tab),
 * 3. pick an article card that is not an ad and was not read yet,
 * 4. tap it, stay for the dwell time while swiping like a reader,
 * 5. go back to the feed, swipe, repeat until the target is reached.
 *
 * The app's resource ids are obfuscated and change between releases, so cards
 * are found from the accessibility tree by shape, not by id: a long,
 * multi-word label inside a clickable container, between the top bar and the
 * bottom navigation. A card is rejected when any node in the same container
 * says "Sponsored" / "Ad", which is how the feed marks its ad cards.
 *
 * Everything that touches the phone goes through ./appium; the card scanner
 * itself is pure so it can be tested against a saved XML dump (`just mobile
 * inspect` writes one to %TEMP%\edgets-app.xml).
 */
import os from "node:os";
import path from "node:path";

import {
  MOBILE_APP_DWELL_MAX,
  MOBILE_APP_DWELL_MIN,
  MOBILE_APP_MAX_SWIPES,
  MOBILE_APP_NEWS_MAX,
  MOBILE_APPIUM_APP_PACKAGE,
  MOBILE_APPIUM_WAIT,
} from "../config/settings";
import { sleep } from "../utils/delay";
import { throwIfInterrupted } from "../utils/interrupt";
import {
  type AppDriverOptions,
  type AppiumDriver,
  type UiNode,
  createAppDriver,
  currentPackage,
  dumpHierarchy,
  dumpScreenshot,
  findNodes,
  goBack,
  launchApp,
  readNodes,
  screenSize,
  setDialogLog,
  swipeUp,
  tapNode,
} from "./appium";

export type Log = ((message: string) => void) | undefined;

function say(log: Log, message: string): void {
  log?.(message);
}

function uniform(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ============================================================
// Words
// ============================================================

/** Tabs or buttons that lead to the news feed, in order of preference. */
export const FEED_TABS = ["Discover", "News", "Top stories", "For you", "Today", "Feed", "Berita", "Untuk Anda"];

/**
 * First-run sheets, rating prompts and "turn on notifications" banners. Only
 * refusals and close buttons: the reader never grants a permission.
 */
export const DISMISS_WORDS = [
  "Not now", "Maybe later", "No thanks", "Skip", "Got it", "Dismiss", "Close",
  "Don't allow", "Deny", "Later", "Nanti", "Lain kali", "Lewati", "Tutup",
  "Tidak sekarang", "Jangan izinkan",
];

/** Labels that mark an ad card. Matched as substrings, except AD_EXACT (the whole label). */
const AD_WORDS = [
  "sponsored", "advertisement", "promoted", "bersponsor", "iklan", "ad ·", "ad •", "ad choices", "adchoices",
];

const AD_EXACT = new Set(["ad", "ads"]);

/** "Ad" as its own word: "Maximize TikTok Ads Today. Ad, TikTok for Business". */
const AD_TOKEN = /(?:^|[\s.,;:|·•(\[])ad(?:$|[\s.,;:|·•)\]])/;

/** Feed cards span the screen; glance cards and carousel chips are a fraction of it. */
const MIN_CARD_WIDTH = 0.6;

/** Long labels that are UI, not headlines. */
const UI_WORDS = [
  "search", "cari", "sign in", "masuk", "rewards", "points", "poin", "settings",
  "notification", "allow ", "camera", "voice", "copilot",
];

/** Classes that never hold a headline. */
const SKIP_CLASSES = ["EditText", "Button", "ImageButton", "CheckBox", "Switch"];

/** A headline is at least this long and has at least this many words. */
const MIN_TITLE_CHARS = 28;
const MIN_TITLE_WORDS = 5;

/** Header and bottom navigation bands, as a share of the screen height. */
const TOP_BAND = 0.1;
const BOTTOM_BAND = 0.9;

// ============================================================
// Results
// ============================================================

/** One article read in the app. */
export class AppArticle {
  title: string;
  dwell = 0;
  swipes = 0;
  package = "";
  error = "";

  constructor(title: string) {
    this.title = title;
  }

  get ok(): boolean {
    return !this.error;
  }

  get label(): string {
    const line = (this.title || "").trim().split(/\r?\n/)[0];
    return (line || "(tanpa judul)").slice(0, 70);
  }

  asDict(): Record<string, unknown> {
    return {
      title: this.title,
      dwell: Math.round(this.dwell * 10) / 10,
      swipes: this.swipes,
      package: this.package,
      error: this.error,
    };
  }
}

/** Outcome of one Read to Earn run. */
export class AppNewsResult {
  articles: AppArticle[] = [];
  error = "";
  screenshot = "";
  xml = "";

  constructor(public target: number) {}

  get read(): number {
    return this.articles.filter((article) => article.ok).length;
  }

  get complete(): boolean {
    return !this.error && this.read >= this.target;
  }
}

// ============================================================
// Card scanner (pure)
// ============================================================

function norm(text: string | undefined): string {
  return (text ?? "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

/** Stable key for "already read", robust to trailing metadata. */
export function titleKey(label: string): string {
  return norm(label).slice(0, 60);
}

/**
 * True when `label` is a card already read. The same story shows up as
 * "Title" on one card and "Title. Source" on another, so a key that starts
 * with another one counts as the same.
 */
export function alreadyRead(label: string, visited: Set<string>): boolean {
  const key = titleKey(label);

  if (visited.has(key)) {
    return true;
  }

  for (const seen of visited) {
    if (key.length >= 20 && seen.length >= 20 && (key.startsWith(seen) || seen.startsWith(key))) {
      return true;
    }
  }

  return false;
}

export function isAdLabel(label: string): boolean {
  const text = norm(label);

  if (!text) return false;
  if (AD_EXACT.has(text)) return true;
  if (AD_TOKEN.test(text)) return true;

  return AD_WORDS.some((word) => text.includes(word));
}

/** Trailing "· 2h" / "· 35m" / "· 1d" age stamp after a source name. */
const AGE_SUFFIX = /\s*[·•]\s*\d+\s*[a-z]{1,4}\.?$/i;

export function looksLikeHeadline(node: UiNode): boolean {
  // "South China Morning Post · 2h" is the source line, not a headline:
  // measure the label without its age stamp.
  const label = (node.label || "").trim().replace(AGE_SUFFIX, "");

  if (label.length < MIN_TITLE_CHARS) return false;
  if (label.split(/\s+/).filter(Boolean).length < MIN_TITLE_WORDS) return false;

  const short = node.className.split(".").pop() ?? "";

  if (SKIP_CLASSES.includes(short)) return false;

  const text = norm(label);

  return !UI_WORDS.some((word) => text.includes(word));
}

const rectKey = (rect: number[]): string => rect.join(",");

/**
 * Article cards on the current screen, top to bottom.
 *
 * Returns one node per card: the first headline-like label inside each
 * clickable container, skipping ads, narrow glance cards and carousel chips,
 * the header and bottom navigation bands, and titles whose key is in
 * `visited`.
 */
export function scanCards(nodes: UiNode[], heightIn: number, visitedIn: Iterable<string> = [], widthIn = 0): UiNode[] {
  if (!nodes.length) {
    return [];
  }

  // The root node spans the screen; use it when the caller has no size.
  const root = nodes[0]!.rect;

  const height = Math.trunc(heightIn || 0) || root[3] || Math.max(0, ...nodes.map((node) => node.container[3]));
  const width = Math.trunc(widthIn || 0) || root[2] || Math.max(0, ...nodes.map((node) => node.container[2]));

  const top = height * TOP_BAND;
  const bottom = height * BOTTOM_BAND;

  const adContainers = new Set(
    nodes.filter((node) => node.container.some(Boolean) && isAdLabel(node.label)).map((node) => rectKey(node.container)),
  );

  // News cards carry this id; search suggestions and other feed blocks
  // ("which yoga is best for…") don't and are not credited as reading.
  const newsCards = new Set(
    nodes.filter((node) => node.resourceId.endsWith("native_list_item_container")).map((node) => rectKey(node.rect)),
  );

  const seenContainers = new Set<string>();
  const visited = new Set(visitedIn);
  const cards: UiNode[] = [];

  for (const node of nodes) {
    if (!node.enabled || !looksLikeHeadline(node)) continue;

    // A tap must land inside a clickable card.
    const container = node.container;

    if (!container.some(Boolean)) continue;
    if (!(top <= node.y && node.y <= bottom)) continue;

    const key = rectKey(container);

    if (adContainers.has(key) || isAdLabel(node.label)) continue;
    if (newsCards.size && !newsCards.has(key)) continue;
    if (seenContainers.has(key)) continue;

    // The whole screen as "container" means the label is not in a card.
    if (height && container[3] - container[1] >= height * 0.85) continue;

    // Glance cards and carousel chips are narrow or run off the edge.
    if (width) {
      if (container[2] - container[0] < width * MIN_CARD_WIDTH) continue;

      const [x1, , x2] = node.rect;

      if (x1 < 0 || x2 > width) continue;
    }

    if (alreadyRead(node.label, visited)) continue;

    seenContainers.add(key);
    cards.push(node);
  }

  return cards;
}

/** Labels on screen, used to tell whether a tap changed the screen. */
export function screenSignature(nodes: UiNode[]): Set<string> {
  return new Set(nodes.filter((node) => node.label && node.label.length >= 4).map((node) => norm(node.label)));
}

export function overlap(before: Set<string>, after: Set<string>): number {
  if (!before.size || !after.size) {
    return 0;
  }

  let shared = 0;
  for (const item of before) {
    if (after.has(item)) shared += 1;
  }

  return shared / Math.max(1, Math.min(before.size, after.size));
}

// ============================================================
// Phone actions
// ============================================================

/** Close first-run sheets. Returns how many were dismissed. */
export async function dismissPopups(driver: AppiumDriver, rounds = 3, log?: Log): Promise<number> {
  let closed = 0;

  for (let i = 0; i < rounds; i += 1) {
    const nodes = await readNodes(driver);
    const found = findNodes(nodes, DISMISS_WORDS).filter(
      (node) => (node.clickable || node.container.some(Boolean)) && node.label.length <= 24,
    );

    if (!found.length) break;
    if (!(await tapNode(driver, found[0]!))) break;

    say(log, `tutup popup · ${found[0]!.label}`);
    closed += 1;
    await sleep(1200);
  }

  return closed;
}

/** Launch the app and return the nodes of a screen with article cards. */
export async function openFeed(
  driver: AppiumDriver,
  appPackage?: string,
  wait: number = MOBILE_APPIUM_WAIT,
  log?: Log,
): Promise<UiNode[]> {
  const pkg = (appPackage || MOBILE_APPIUM_APP_PACKAGE).trim();

  if (!(await launchApp(driver, pkg))) {
    throw new Error(`tidak bisa membuka ${pkg}`);
  }

  const [, height] = await screenSize(driver);
  const deadline = Date.now() + Math.max(5, Math.trunc(wait)) * 1000;
  const triedTabs = new Set<string>();

  while (Date.now() < deadline) {
    throwIfInterrupted();

    const current = await currentPackage(driver);

    if (current !== "" && current !== pkg) {
      await launchApp(driver, pkg);
      continue;
    }

    await dismissPopups(driver, 3, log);

    const nodes = await readNodes(driver);

    if (scanCards(nodes, height).length) {
      return nodes;
    }

    // Prefer a feed tab that has not been tried yet.
    const tab = findNodes(nodes, FEED_TABS).find(
      (node) => (node.clickable || node.container.some(Boolean)) && node.label.length <= 24 && !triedTabs.has(node.label),
    );

    if (tab) {
      triedTabs.add(tab.label);
      say(log, `buka tab · ${tab.label}`);
      await tapNode(driver, tab);
      await sleep(2000);
      continue;
    }

    // The Bing home screen shows the feed below the search box.
    await swipeUp(driver, 0.45);
    await sleep(1200);
  }

  return [];
}

/** True once the screen differs from the feed it was tapped on. */
async function waitOpened(driver: AppiumDriver, before: Set<string>, pkg: string, timeout: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(2, Math.trunc(timeout)) * 1000;

  while (Date.now() < deadline) {
    await sleep(800);

    const current = await currentPackage(driver);

    if (current !== "" && current !== pkg) {
      return true;
    }

    const after = screenSignature(await readNodes(driver));

    if (after.size && overlap(before, after) < 0.5) {
      return true;
    }
  }

  return false;
}

/** Stay in the article, swiping down the text like a reader. */
async function dwell(driver: AppiumDriver, seconds: number): Promise<[number, number]> {
  const started = Date.now();
  let swipes = 0;

  for (;;) {
    throwIfInterrupted();

    const left = seconds - (Date.now() - started) / 1000;

    if (left <= 0) break;

    await sleep(Math.min(left, uniform(2.5, 4.5)) * 1000);

    if (seconds - (Date.now() - started) / 1000 > 1.5) {
      if (await swipeUp(driver, uniform(0.3, 0.5))) {
        swipes += 1;
      }
    }
  }

  return [(Date.now() - started) / 1000, swipes];
}

/** Press back until the feed (or any card screen) is visible again. */
export async function backToFeed(
  driver: AppiumDriver,
  feed: Set<string>,
  pkg: string,
  height: number,
  wait: number,
  log?: Log,
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await goBack(driver);
    await sleep(1500);

    const current = await currentPackage(driver);

    if (current !== "" && current !== pkg) {
      // Article opened in another app (browser): return to Bing.
      await launchApp(driver, pkg);
      await sleep(1500);
    }

    const nodes = await readNodes(driver);

    if (overlap(feed, screenSignature(nodes)) >= 0.3) return true;
    if (scanCards(nodes, height).length) return true;

    say(log, `kembali ke feed · percobaan ${attempt + 2}`);
  }

  // Last resort: reopen the feed from the app root.
  return (await openFeed(driver, pkg, wait, log)).length > 0;
}

/** Tap `card`, read it, and come back to the feed. */
export async function readCard(
  driver: AppiumDriver,
  card: UiNode,
  feedNodes: UiNode[],
  pkg: string,
  height: number,
  dwellMin: number,
  dwellMax: number,
  wait: number,
  log?: Log,
): Promise<AppArticle> {
  const article = new AppArticle(card.label);
  const before = screenSignature(feedNodes);

  if (!(await tapNode(driver, card))) {
    article.error = "tap gagal";
    return article;
  }

  if (!(await waitOpened(driver, before, pkg, Math.min(wait, 10)))) {
    article.error = "kartu tidak membuka artikel";
    return article;
  }

  article.package = await currentPackage(driver);

  const target = uniform(Math.max(1, dwellMin), Math.max(dwellMin, dwellMax));

  [article.dwell, article.swipes] = await dwell(driver, target);

  if (!(await backToFeed(driver, before, pkg, height, wait, log))) {
    article.error = "tidak bisa kembali ke feed";
  }

  return article;
}

export interface ReadFeedOptions {
  count?: number;
  dwellMin?: number;
  dwellMax?: number;
  maxSwipes?: number;
  package?: string;
  wait?: number;
  dryRun?: boolean;
  log?: Log;
  onArticle?: (article: AppArticle) => void;
  /** Headlines read in an earlier round: a second read is not credited. */
  skipTitles?: Iterable<string>;
}

/** Read `count` articles on an attached Appium driver. */
export async function readAppFeed(driver: AppiumDriver, options: ReadFeedOptions = {}): Promise<AppNewsResult> {
  const {
    count = MOBILE_APP_NEWS_MAX,
    dwellMin = MOBILE_APP_DWELL_MIN,
    dwellMax = MOBILE_APP_DWELL_MAX,
    maxSwipes = MOBILE_APP_MAX_SWIPES,
    wait = MOBILE_APPIUM_WAIT,
    dryRun = false,
    log,
    onArticle,
    skipTitles = [],
  } = options;

  const pkg = (options.package || MOBILE_APPIUM_APP_PACKAGE).trim();
  const result = new AppNewsResult(Math.max(0, Math.trunc(count)));

  if (log) {
    setDialogLog(log);
  }

  if (result.target === 0) {
    return result;
  }

  let nodes = await openFeed(driver, pkg, wait, log);

  if (!nodes.length) {
    result.error = "feed berita tidak ditemukan";
    await capture(driver, result);
    return result;
  }

  const [, height] = await screenSize(driver);
  const visited = new Set([...skipTitles].filter(Boolean).map((title) => titleKey(title)));
  let idleSwipes = 0;
  let failures = 0;

  while (result.read < result.target) {
    throwIfInterrupted();

    const cards = scanCards(nodes, height, visited);

    if (dryRun) {
      for (const card of cards) {
        visited.add(titleKey(card.label));
        const article = new AppArticle(card.label);
        result.articles.push(article);
        onArticle?.(article);

        if (result.read >= result.target) break;
      }
    } else if (cards.length) {
      const card = cards[0]!;
      visited.add(titleKey(card.label));
      say(log, `baca · ${card.label.slice(0, 60)}`);

      const article = await readCard(driver, card, nodes, pkg, height, dwellMin, dwellMax, wait, log);

      result.articles.push(article);
      onArticle?.(article);

      if (article.ok) {
        idleSwipes = 0;
        failures = 0;
      } else {
        failures += 1;

        if (article.error === "tidak bisa kembali ke feed") {
          result.error = article.error;
          break;
        }

        if (failures >= 3) {
          result.error = "tiga kartu berturut-turut gagal";
          break;
        }
      }

      // Pause like a reader picking the next story.
      await sleep(uniform(1.0, 2.5) * 1000);
      nodes = await readNodes(driver);
      continue;
    }

    if (result.read >= result.target) break;

    if (idleSwipes >= maxSwipes) {
      result.error = `tidak ada kartu baru setelah ${maxSwipes} swipe`;
      break;
    }

    await swipeUp(driver, 0.55);
    idleSwipes += 1;
    await sleep(1200);
    nodes = await readNodes(driver);
  }

  if (!result.complete) {
    await capture(driver, result);
  }

  return result;
}

export interface RunAppNewsOptions extends ReadFeedOptions, AppDriverOptions {
  activity?: string | null;
}

/**
 * Connect to Appium, read the feed, and always close the session. Throws
 * `AppiumUnavailable` when the server or phone is missing.
 */
export async function runAppNews(options: RunAppNewsOptions = {}): Promise<AppNewsResult> {
  const driver = await createAppDriver({
    server: options.server,
    udid: options.udid,
    appPackage: options.package,
    appActivity: options.activity,
  });

  try {
    return await readAppFeed(driver, options);
  } finally {
    await driver.quit().catch(() => undefined);
  }
}

async function capture(driver: AppiumDriver, result: AppNewsResult): Promise<void> {
  const stem = path.join(os.tmpdir(), "edgets-app-news");

  result.screenshot = await dumpScreenshot(driver, `${stem}.png`);
  result.xml = await dumpHierarchy(driver, `${stem}.xml`);
}
