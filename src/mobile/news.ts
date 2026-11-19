/**
 * Read MSN articles on a mobile-emulated tab.
 *
 * The flow follows what the rewards task expects:
 *
 * 1. Open the MSN feed.
 * 2. Pick one news card (ad boxes are skipped).
 * 3. Click it, stay for a short dwell, then go back to the feed.
 * 4. Scroll and pick the next unused card.
 *
 * MSN renders the feed inside web components with open shadow roots
 * (`ENTRY-POINT-HP-MOBILE` > `UNIFIED-MOBILE-FEED` > `CSM-CARD`), so every
 * query here walks the shadow trees as well; a plain
 * `document.querySelectorAll('a')` finds nothing on that page.
 *
 * Links are handled by clicking the card first, because that is what a user
 * does; direct navigation is only the fallback when the click does not move
 * the page.
 */
import fs from "node:fs";
import path from "node:path";

import type { WebDriver, WebElement } from "selenium-webdriver";

import { MOBILE_NEWS_DWELL_MAX, MOBILE_NEWS_DWELL_MIN, MOBILE_NEWS_SCROLL } from "../config/settings";
import { sleep } from "../utils/delay";
import { throwIfInterrupted } from "../utils/interrupt";
import { type MobileDriver, openMobileTab } from "./browser";
import { MAX_MOBILE_WIDTH } from "./probe";

const ARTICLE_MARKERS = ["/ar-", "/a/", "/article/"];

/** Buttons that block the feed: cookie walls, app prompts, paywalls. */
export const DISMISS_WORDS = [
  "accept all", "accept", "agree", "allow all", "got it", "continue in browser",
  "continue on this site", "not now", "maybe later", "no thanks", "terima semua",
  "terima", "setuju", "izinkan", "tetap di browser", "lanjutkan di browser",
  "nanti saja", "tidak sekarang",
];

/**
 * MSN renders the feed in web components with open shadow roots, so a plain
 * document.querySelectorAll() sees no links at all.
 */
const DEEP_ALL_JS = String.raw`
const deepAll = (selector) => {
    const found = [];
    const walk = (root) => {
        root.querySelectorAll(selector).forEach((node) => found.push(node));
        root.querySelectorAll('*').forEach((node) => {
            if (node.shadowRoot) {
                walk(node.shadowRoot);
            }
        });
    };
    walk(document);
    return found;
};
`;

const CARD_JS =
  "return (() => {\n" +
  DEEP_ALL_JS +
  String.raw`
    const AD_WORDS = [
        "advert", "advertisement", "sponsor", "sponsored",
        "promoted", "promo", "dfp", "gpt",
    ];
    const AD_TOKENS = [
        "ad", "ads", "adslot", "ad-slot", "ad-container", "ad-wrapper",
        "adunit", "ad-unit", "adsbygoogle", "advert", "advertisement",
    ];
    const attrsOf = (node) => {
        try {
            return [
                node.getAttribute && node.getAttribute("data-ad"),
                node.getAttribute && node.getAttribute("data-ad-slot"),
                node.getAttribute && node.getAttribute("aria-label"),
                node.id,
                node.className && String(node.className),
            ].filter(Boolean).join(" ").toLowerCase();
        } catch (error) {
            return "";
        }
    };
    const isAd = (node) => {
        let current = node;
        for (let depth = 0; current && depth < 12; depth++) {
            const text = attrsOf(current);
            if (text) {
                if (AD_WORDS.some((word) => text.includes(word))) {
                    return true;
                }
                const tokens = text.split(/[^a-z0-9-]+/).filter(Boolean);
                if (tokens.some((token) => AD_TOKENS.includes(token))) {
                    return true;
                }
            }
            const root = current.getRootNode ? current.getRootNode() : null;
            current = root && root.host ? root.host : current.parentElement;
        }
        return false;
    };
    const anchors = deepAll("a[href]");
    window.__edgetsNews = anchors;
    const cards = [];
    for (let index = 0; index < anchors.length; index++) {
        const anchor = anchors[index];
        let parsed = null;
        try {
            parsed = new URL(anchor.href);
        } catch (error) {
            continue;
        }
        if (!/(^|\.)msn\.com$/i.test(parsed.hostname)) {
            continue;
        }
        let text = (
            anchor.innerText
            || anchor.textContent
            || anchor.getAttribute("aria-label")
            || (anchor.querySelector("img[alt]") || {}).alt
            || ""
        ).trim().replace(/\s+/g, " ");
        let node = anchor;
        for (let depth = 0; node && depth < 4 && !text; depth++) {
            text = (node.innerText || node.textContent || "")
                .trim()
                .replace(/\s+/g, " ");
            const root = node.getRootNode ? node.getRootNode() : null;
            node = root && root.host ? root.host : node.parentElement;
        }
        const rect = anchor.getBoundingClientRect();
        cards.push({
            index: index,
            href: anchor.href,
            text: text.slice(0, 140),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            ad: isAd(anchor),
        });
    }
    return cards;
})();
`;

const DISMISS_JS =
  "return (() => {\n" +
  DEEP_ALL_JS +
  String.raw`
    const words = arguments[0];
    const nodes = deepAll('button, [role="button"], a');
    for (const node of nodes) {
        const text = (node.innerText || "").trim().toLowerCase();
        if (!text || text.length > 40) {
            continue;
        }
        if (!words.some((word) => text === word || text.startsWith(word))) {
            continue;
        }
        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) {
            continue;
        }
        node.click();
        return text;
    }
    return "";
})();
`;

const FIT_VIEWPORT_JS = String.raw`
return (() => {
    const layout = () => {
        const root = document.documentElement;
        return {
            innerWidth: window.innerWidth || 0,
            layoutWidth: root ? root.clientWidth : 0,
            devicePixelRatio: window.devicePixelRatio || 1,
        };
    };
    const before = layout();
    let added = false;
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta && document.head) {
        meta = document.createElement("meta");
        meta.setAttribute("name", "viewport");
        document.head.appendChild(meta);
        added = true;
    }
    if (meta) {
        const content = (meta.getAttribute("content") || "").toLowerCase();
        if (!content.includes("width=device-width")) {
            meta.setAttribute("content", "width=device-width, initial-scale=1");
            added = true;
        }
    }
    return Object.assign(before, {
        layoutWidthAfter: layout().layoutWidth,
        meta: !!meta,
        added: added,
    });
})();
`;

const DEBUG_JS =
  "return (() => {\n" +
  DEEP_ALL_JS +
  String.raw`
    const anchors = deepAll('a[href]');
    const msn = anchors.filter((anchor) => /msn\.com/i.test(anchor.href));
    const all = deepAll('*');
    const shadowHosts = all.filter((node) => node.shadowRoot);
    const body = document.body;
    return {
        title: document.title || "",
        readyState: document.readyState || "",
        anchors: anchors.length,
        msnAnchors: msn.length,
        shadowHosts: shadowHosts.length,
        elements: all.length,
        iframes: document.querySelectorAll('iframe').length,
        sample: msn.slice(0, 15).map((anchor) => anchor.href),
        text: (body && body.innerText || "")
            .replace(/\s+/g, " ")
            .slice(0, 400),
    };
})();
`;

/** What one article read looked like. */
export class NewsArticle {
  title = "";
  finalUrl = "";
  dwell = 0;
  scrolls = 0;
  hasArticle = false;
  handle: string | null | undefined;
  screenshot = "";
  layoutWidth = 0;
  viewportMeta = false;
  error = "";

  constructor(public url: string) {}

  get ok(): boolean {
    return !this.error;
  }

  get label(): string {
    const line = (this.title || "").trim().split(/\r?\n/)[0] || "(tanpa judul)";
    return line.slice(0, 70);
  }

  asDict(): Record<string, unknown> {
    return {
      url: this.url,
      title: this.title,
      final_url: this.finalUrl,
      dwell: Math.round(this.dwell * 10) / 10,
      scrolls: this.scrolls,
      has_article: this.hasArticle,
      layout_width: this.layoutWidth,
      viewport_meta: this.viewportMeta,
      screenshot: this.screenshot,
      error: this.error,
    };
  }
}

export interface FeedCard {
  index: number;
  href: string;
  text: string;
  top: number;
  width: number;
  height: number;
  ad: boolean;
}

function uniform(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).trim();
}

/** True when `url` looks like an MSN article, not a section page. */
export function isNewsUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = parsed.hostname.toLowerCase();

  if (!(host === "msn.com" || host.endsWith(".msn.com"))) {
    return false;
  }

  const pathname = parsed.pathname.toLowerCase();

  if (!pathname || pathname.replace(/^\/+|\/+$/g, "") === "") {
    return false;
  }

  if (ARTICLE_MARKERS.some((marker) => pathname.includes(marker))) {
    return true;
  }

  const segments = pathname.split("/").filter(Boolean);

  return segments.includes("news") && segments.length >= 4;
}

/** The MSN cards on the current page, ads included. */
export async function scanFeed(driver: WebDriver): Promise<FeedCard[]> {
  try {
    const cards = ((await driver.executeScript(CARD_JS)) as unknown[] | null) ?? [];
    return cards.filter((card): card is FeedCard => typeof card === "object" && card !== null);
  } catch {
    return [];
  }
}

const AD_LABELS = new Set(["ad", "ads", "iklan", "sponsored"]);

/** Drop query and fragment so the same article is not read twice. */
function cleanUrl(href: string): string {
  let parsed: URL;

  try {
    parsed = new URL(href);
  } catch {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "";
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

/** The cards that can be clicked as a news article. */
function candidates(cards: FeedCard[], visited: Set<string>): FeedCard[] {
  return cards.filter((card) => {
    const href = card.href || "";

    if (card.ad) return false;
    if (visited.has(cleanUrl(href))) return false;
    if (!isNewsUrl(href)) return false;
    if ((card.width ?? 0) < 40 || (card.height ?? 0) < 30) return false;

    const text = (card.text || "").trim();

    return Boolean(text) && !AD_LABELS.has(text.toLowerCase());
  });
}

export interface ReadFeedOptions {
  count?: number;
  dwellMin?: number;
  dwellMax?: number;
  scrolls?: number;
  screenshotDir?: string;
  onStatus?: (markup: string) => void;
}

/** Read `count` news cards from the feed, one click at a time. */
export async function readFeed(driver: MobileDriver, feedUrl: string, options: ReadFeedOptions = {}): Promise<NewsArticle[]> {
  const {
    count = 3,
    dwellMin = MOBILE_NEWS_DWELL_MIN,
    dwellMax = MOBILE_NEWS_DWELL_MAX,
    scrolls = MOBILE_NEWS_SCROLL,
    screenshotDir = "",
    onStatus,
  } = options;

  const results: NewsArticle[] = [];
  const visited = new Set<string>();
  const feedHandle = await currentHandle(driver);
  const targetCount = Math.max(1, Math.trunc(count));

  await navigate(driver, feedUrl);

  await waitReady(driver, 30);
  await dismissConsent(driver);
  await sleep(uniform(1.2, 2.0) * 1000);

  // MSN hydrates the feed after the shell loads. Card elements can exist with
  // a zero-size rect until the layout settles, so wait for one usable card
  // before starting the click loop.
  const deadline = Date.now() + 25_000;

  while (Date.now() < deadline) {
    throwIfInterrupted();

    if (candidates(await scanFeed(driver), visited).length) break;

    await scrollFeed(driver);
    await sleep(800);
  }

  let attempts = 0;
  const maxAttempts = Math.max(12, targetCount * 6);
  const scrollsBetween = Math.max(1, Math.trunc(scrolls));

  while (results.length < targetCount && attempts < maxAttempts) {
    throwIfInterrupted();
    attempts += 1;

    if ((await currentUrl(driver)) && !(await onFeed(driver, feedUrl))) {
      await driver.get(feedUrl);
      await waitReady(driver, 20);
      await dismissConsent(driver);
    }

    const pool = candidates(await scanFeed(driver), visited);

    // Prefer a card that is already on screen; otherwise the first unused one
    // is scrolled into view when clicked.
    const viewport = await viewportHeight(driver);
    const visible = pool.filter((card) => -60 <= (card.top ?? 0) && (card.top ?? 0) <= viewport);
    const card = (visible.length ? visible : pool)[0];

    if (!card) {
      let scrolled = 0;

      for (let i = 0; i < scrollsBetween; i += 1) {
        if (!(await scrollFeed(driver))) break;
        scrolled += 1;
      }

      if (scrolled) {
        await sleep(uniform(0.6, 1.2) * 1000);
        continue;
      }

      break;
    }

    visited.add(cleanUrl(card.href));

    onStatus?.(`[dim]news · ${results.length + 1}/${targetCount} · ${(card.text || card.href).slice(0, 50)}[/dim]`);

    const article = await readCard(driver, card, feedHandle, dwellMin, dwellMax, screenshotDir, results.length + 1);
    results.push(article);

    await returnToFeed(driver, feedHandle, feedUrl);
    await sleep(uniform(0.8, 1.6) * 1000);

    for (let i = 0; i < scrollsBetween; i += 1) {
      await scrollFeed(driver);
      await sleep(uniform(0.5, 1.0) * 1000);
    }
  }

  return results;
}

/** Read one URL directly. */
export async function readArticle(
  driver: MobileDriver,
  url: string,
  options: { dwellMin?: number; dwellMax?: number; scrolls?: number; newTab?: boolean } = {},
): Promise<NewsArticle> {
  const { dwellMin = MOBILE_NEWS_DWELL_MIN, dwellMax = MOBILE_NEWS_DWELL_MAX, scrolls = 0, newTab = false } = options;

  const started = Date.now();
  const article = new NewsArticle(url);
  const target = dwellTarget(dwellMin, dwellMax);

  try {
    if (newTab) {
      try {
        article.handle = await openMobileTab(driver);
      } catch {
        article.handle = null;
      }
    }

    await navigate(driver, url);

    await waitReady(driver);
    await dismissConsent(driver);
    await sleep(uniform(0.8, 1.6) * 1000);

    await recordViewport(article, driver);

    article.title = (await driver.getTitle()) || "";
    article.finalUrl = await currentUrl(driver);
    article.hasArticle = await hasArticle(driver);

    for (let i = 0; i < Math.max(0, Math.trunc(scrolls)); i += 1) {
      const remaining = target - (Date.now() - started) / 1000;

      if (remaining <= 0) break;

      await scrollOnce(driver);
      article.scrolls += 1;
      await sleep(Math.min(remaining, uniform(0.6, 1.2)) * 1000);
    }

    const remaining = target - (Date.now() - started) / 1000;

    if (remaining > 0) {
      await sleep(remaining * 1000);
    }

    article.dwell = (Date.now() - started) / 1000;
    return article;
  } catch (error) {
    // Report, never abort the run.
    article.dwell = (Date.now() - started) / 1000;
    article.error = errorText(error);
    return article;
  }
}

export interface PageDebug {
  url: string;
  title: string;
  readyState: string;
  anchors: number;
  msnAnchors: number;
  shadowHosts: number;
  elements: number;
  iframes: number;
  sample: string[];
  text: string;
  error: string;
}

/** Collect enough page state to explain why no article was found. */
export async function debugPage(driver: WebDriver): Promise<PageDebug> {
  const info: PageDebug = {
    url: await currentUrl(driver),
    title: "",
    readyState: "",
    anchors: 0,
    msnAnchors: 0,
    shadowHosts: 0,
    elements: 0,
    iframes: 0,
    sample: [],
    text: "",
    error: "",
  };

  try {
    const data = (await driver.executeScript(DEBUG_JS)) as Partial<PageDebug> | null;

    if (data && typeof data === "object") {
      Object.assign(info, data);
    }
  } catch (error) {
    info.error = errorText(error);
  }

  return info;
}

/** Write the current HTML to `file` for selector debugging. */
export async function dumpPage(driver: WebDriver, file: string): Promise<string> {
  let html: string;

  try {
    html = (await driver.getPageSource()) || "";
  } catch {
    return "";
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html, "utf-8");
    return file;
  } catch {
    return "";
  }
}

/** Wait for the document to be readable, without throwing. */
export async function waitReady(driver: WebDriver, timeout = 25): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, Math.trunc(timeout)) * 1000;

  while (Date.now() < deadline) {
    let state: unknown = null;

    try {
      state = await driver.executeScript("return document.readyState");
    } catch {
      state = null;
    }

    if (state === "interactive" || state === "complete") {
      return true;
    }

    await sleep(400);
  }

  return false;
}

/** Click a consent or app prompt if one is in the way. */
export async function dismissConsent(driver: WebDriver): Promise<string> {
  for (let i = 0; i < 2; i += 1) {
    let clicked: unknown;

    try {
      clicked = await driver.executeScript(DISMISS_JS, DISMISS_WORDS);
    } catch {
      return "";
    }

    if (!clicked) {
      return "";
    }

    await sleep(800);
  }

  return "";
}

/**
 * Force a device-width layout and report the real layout width.
 *
 * MSN syndicates articles from many publishers. A page that ships no
 * `width=device-width` meta viewport is laid out for a ~980px screen and then
 * scaled down, which looks like a wide desktop page even though the tab is
 * emulated at phone width. Adding the meta makes Chromium relayout at the
 * emulated width.
 */
export async function fitViewport(driver: MobileDriver): Promise<Record<string, unknown>> {
  const info: Record<string, unknown> = {};

  try {
    Object.assign(info, (await driver.executeScript(FIT_VIEWPORT_JS)) ?? {});
  } catch {
    return info;
  }

  // CDP metrics are per tab. If the article was opened in a separate window
  // they may be missing, which shows up as a desktop layout.
  if (Number(info["innerWidth"] ?? 0) > MAX_MOBILE_WIDTH) {
    await applyEmulation(driver);

    try {
      Object.assign(info, (await driver.executeScript(FIT_VIEWPORT_JS)) ?? {});
    } catch {
      // Keep what was measured.
    }
  }

  return info;
}

/** Measure the article layout width and keep it on the result. */
async function recordViewport(article: NewsArticle, driver: MobileDriver): Promise<Record<string, unknown>> {
  const info = await fitViewport(driver);

  article.layoutWidth = Math.trunc(Number(info["layoutWidthAfter"] ?? info["layoutWidth"] ?? 0)) || 0;
  article.viewportMeta = Boolean(info["meta"]);

  return info;
}

/** Scroll a random, phone-sized step down the page. */
export async function scrollOnce(driver: WebDriver): Promise<number> {
  let viewport = 600;

  try {
    viewport = Number(await driver.executeScript("return window.innerHeight || 0;")) || 600;
  } catch {
    viewport = 600;
  }

  const distance = Math.floor(uniform(viewport * 0.45, viewport * 1.05));

  try {
    await driver.executeScript("window.scrollBy(0, arguments[0]);", distance);
  } catch {
    // Ignore.
  }

  return distance;
}

// ------------------------------------------------------------
// Internal flow
// ------------------------------------------------------------

/** Click one card, dwell on the article, and return the result. */
async function readCard(
  driver: MobileDriver,
  card: FeedCard,
  feedHandle: string | null,
  dwellMin: number,
  dwellMax: number,
  screenshotDir: string,
  index: number,
): Promise<NewsArticle> {
  const article = new NewsArticle(card.href);
  article.title = card.text || "";

  const target = dwellTarget(dwellMin, dwellMax);
  const beforeUrl = await currentUrl(driver);
  const beforeHandles = new Set(await handles(driver));

  const clicked = await clickCard(driver, card);

  if (!clicked) {
    await navigate(driver, card.href);
  }

  const handle = await waitNavigation(driver, beforeUrl, beforeHandles, 5);
  article.handle = handle;

  if (handle && feedHandle && handle !== feedHandle) {
    // A click can open the article in a new tab. CDP metrics are scoped to one
    // tab, so that tab starts desktop-wide with a desktop UA; emulate it and
    // load the article again so it renders at phone width like the feed.
    await applyEmulation(driver);
    await navigate(driver, card.href);
    await waitReady(driver);
    await dismissConsent(driver);
  }

  if (!clicked && !handle && (await currentUrl(driver)) === beforeUrl) {
    await navigate(driver, card.href);
  }

  await waitReady(driver);
  await dismissConsent(driver);

  if ((await currentUrl(driver)) === beforeUrl && !handle) {
    // The click was swallowed (overlay, lazy card): load the target.
    await navigate(driver, card.href);
    await waitReady(driver);
    await dismissConsent(driver);
  }

  await sleep(uniform(0.4, 0.8) * 1000);

  // Some syndicated article pages have no viewport meta and would lay out at
  // ~980px. Fix that before the dwell so the screenshot and the time spent on
  // the page match what a phone user sees.
  await recordViewport(article, driver);

  // The dwell starts once the article is on screen, so navigation time does
  // not eat into the seconds the task expects.
  const arrived = Date.now();

  article.title = (await driver.getTitle()) || article.title;
  article.finalUrl = await currentUrl(driver);
  article.hasArticle = await hasArticle(driver);

  await sleep(target * 1000);

  article.dwell = (Date.now() - arrived) / 1000;

  if (screenshotDir && article.ok) {
    article.screenshot = await screenshot(driver, screenshotDir, index);
  }

  return article;
}

/** Apply the phone profile to the current tab, if one is attached. */
async function applyEmulation(driver: MobileDriver): Promise<boolean> {
  if (!driver.mobileEmulation) {
    return false;
  }

  try {
    await driver.mobileEmulation.apply(driver);
    return true;
  } catch {
    // Best effort: the probe reports the rest.
    return false;
  }
}

/** Click a scanned card with a real Selenium click. */
async function clickCard(driver: WebDriver, card: FeedCard): Promise<boolean> {
  let element: WebElement | null;

  try {
    element = (await driver.executeScript("return (window.__edgetsNews || [])[arguments[0]] || null;", card.index ?? -1)) as WebElement | null;
  } catch {
    return false;
  }

  if (!element) {
    return false;
  }

  try {
    await driver.executeScript(
      "const node = arguments[0];" + "if (node.tagName === 'A' && node.target) {" + "    node.target = '_self';" + "}",
      element,
    );
    await driver.executeScript("arguments[0].scrollIntoView({ block: 'center' });", element);
    await sleep(400);
    await element.click();
    return true;
  } catch {
    try {
      await driver.executeScript("arguments[0].click();", element);
      return true;
    } catch {
      return false;
    }
  }
}

/** Wait for a click to navigate or open a tab; return the new handle. */
async function waitNavigation(
  driver: WebDriver,
  beforeUrl: string,
  beforeHandles: Set<string>,
  timeout = 5,
): Promise<string | null> {
  const deadline = Date.now() + Math.max(1, timeout) * 1000;

  while (Date.now() < deadline) {
    const created = (await handles(driver)).filter((handle) => !beforeHandles.has(handle));

    if (created.length) {
      const handle = created[created.length - 1]!;

      try {
        await driver.switchTo().window(handle);
      } catch {
        // Ignore.
      }

      return handle;
    }

    if ((await currentUrl(driver)) !== beforeUrl) {
      return null;
    }

    await sleep(200);
  }

  return null;
}

/** Close the article tab or go back, then make sure the feed is open. */
async function returnToFeed(driver: WebDriver, feedHandle: string | null, feedUrl: string): Promise<void> {
  const current = await currentHandle(driver);

  if (feedHandle && current && current !== feedHandle) {
    try {
      await driver.close();
    } catch {
      // Ignore.
    }

    try {
      await driver.switchTo().window(feedHandle);
    } catch {
      // Ignore.
    }
  } else if (current === feedHandle) {
    try {
      await driver.navigate().back();
    } catch {
      // Ignore.
    }
  }

  await waitReady(driver, 15);
  await dismissConsent(driver);

  if (!(await onFeed(driver, feedUrl))) {
    await navigate(driver, feedUrl);
    await waitReady(driver, 20);
    await dismissConsent(driver);
  }
}

async function navigate(driver: WebDriver, url: string): Promise<void> {
  try {
    await driver.get(url);
  } catch {
    // Timeouts and driver errors: the caller checks where the tab is.
  }
}

async function onFeed(driver: WebDriver, feedUrl: string): Promise<boolean> {
  const url = (await currentUrl(driver)).toLowerCase();

  if (!url) return false;

  try {
    if (new URL(url).host.toLowerCase() !== new URL(feedUrl).host.toLowerCase()) {
      return false;
    }
  } catch {
    return false;
  }

  return !isNewsUrl(url);
}

function dwellTarget(dwellMin: number, dwellMax: number): number {
  const low = Math.max(1, Math.trunc(dwellMin));
  const high = Math.max(low, Math.trunc(dwellMax));
  return uniform(low, high);
}

async function viewportHeight(driver: WebDriver): Promise<number> {
  try {
    return Number(await driver.executeScript("return window.innerHeight || 0;")) || 600;
  } catch {
    return 600;
  }
}

async function scrollFeed(driver: WebDriver): Promise<boolean> {
  const before = await scrollTop(driver);
  await scrollOnce(driver);
  await sleep(300);
  return (await scrollTop(driver)) > before;
}

async function scrollTop(driver: WebDriver): Promise<number> {
  try {
    return Number(await driver.executeScript("return Math.round(window.scrollY || 0);")) || 0;
  } catch {
    return 0;
  }
}

async function currentUrl(driver: WebDriver): Promise<string> {
  try {
    return (await driver.getCurrentUrl()) || "";
  } catch {
    return "";
  }
}

async function handles(driver: WebDriver): Promise<string[]> {
  try {
    return await driver.getAllWindowHandles();
  } catch {
    return [];
  }
}

async function currentHandle(driver: WebDriver): Promise<string | null> {
  try {
    return await driver.getWindowHandle();
  } catch {
    return null;
  }
}

async function hasArticle(driver: WebDriver): Promise<boolean> {
  try {
    return Boolean(
      await driver.executeScript(DEEP_ALL_JS + "return deepAll('article, main, [role=\"main\"]').length > 0;"),
    );
  } catch {
    return false;
  }
}

async function screenshot(driver: WebDriver, directory: string, index: number): Promise<string> {
  try {
    fs.mkdirSync(directory, { recursive: true });
  } catch {
    return "";
  }

  const file = path.join(directory, `edgets-news-${index}.png`);

  try {
    fs.writeFileSync(file, await driver.takeScreenshot(), "base64");
    return file;
  } catch {
    return "";
  }
}
