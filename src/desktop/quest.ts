/**
 * The desktop app's weekly quest: one activity unlocks each day.
 *
 * Earn → Quests → "Rewards App weekly Exclusive Quest" (the name changes; its
 * link is `/earn/quest/…RewardsApp…`). The quest page lists the activities:
 *
 * - done:   a green check badge (`bg-statusSuccess…`), no button;
 * - locked: a lock icon and a "10 points" link with `aria-disabled=true`;
 * - open:   the same link, enabled: today's activity.
 *
 * Clicking the open one is what earns it, and it only counts inside the
 * desktop app. After a few seconds the quest page is loaded again (the app's
 * Home) and the activity must show the check; otherwise it is clicked again.
 */
import type { WebDriver, WebElement } from "selenium-webdriver";

import { sleep } from "../utils/delay";
import { throwIfInterrupted } from "../utils/interrupt";
import * as page from "../rewards/page";

export const EARN_URL = "https://rewards.bing.com/earn";
export const BASE_URL = "https://rewards.bing.com";

const QUEST_WORDS = ["rewards app", "desktop rewards", "desktop app", "exclusive quest"];

const ATTEMPTS = 3;

const QUESTS_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
const out = [];
for (const a of document.querySelectorAll('a[href*="/earn/quest/"]')) {
    const text = norm(a.innerText || a.textContent);
    const progress = text.match(/(\d+)\s*\/\s*(\d+)\s*tasks?/i);
    out.push({
        href: a.href,
        text: text,
        done: progress ? parseInt(progress[1], 10) : null,
        total: progress ? parseInt(progress[2], 10) : null,
    });
}
return out;
`;

const ACTIVITIES_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
const heading = [...document.querySelectorAll('h1,h2,h3')]
    .find((h) => /^activities$/i.test(norm(h.innerText)));

const result = { found: !!heading, status: '', items: [] };
window.__edgetsQuest = [];

if (!heading) return result;

// The section holding the heading, the status line and the items.
let root = heading.parentElement;
for (let i = 0; root && i < 6; i += 1) {
    if (root.querySelectorAll('h3').length >= 2) break;
    root = root.parentElement;
}
if (!root) return result;

const status = norm(root.innerText).match(/(\d+)\s*\/\s*(\d+)\s*tasks?/i);
if (status) result.status = status[0];

for (const title of root.querySelectorAll('h3')) {
    // The row: the widest ancestor that still holds only this title, so
    // it includes the state icon next to the text.
    let row = title;
    while (
        row.parentElement &&
        row.parentElement !== root &&
        row.parentElement.querySelectorAll('h3').length === 1
    ) {
        row = row.parentElement;
    }

    const done = !!row.querySelector('[class*="statusSuccess"]');
    const button = [...row.querySelectorAll('a, button, [role="link"], [role="button"]')]
        .find((el) => /\d+\s*(points?|poin)/i.test(norm(el.innerText)));
    const disabled = !!button && (
        button.getAttribute('aria-disabled') === 'true' ||
        button.hasAttribute('data-disabled') ||
        button.disabled === true
    );

    window.__edgetsQuest.push(button || null);
    result.items.push({
        index: window.__edgetsQuest.length - 1,
        title: norm(title.innerText),
        done: done,
        button: button ? norm(button.innerText) : '',
        open: !!button && !disabled && !done,
        href: button ? (button.getAttribute('href') || '') : '',
    });
}

return result;
`;

export interface QuestCard {
  href: string;
  text: string;
  done: number | null;
  total: number | null;
}

export interface QuestItem {
  index: number;
  title: string;
  done: boolean;
  button: string;
  open: boolean;
  href: string;
}

export interface Activities {
  found: boolean;
  status: string;
  items: QuestItem[];
}

const EMPTY: Activities = { found: false, status: "", items: [] };

export class QuestResult {
  title = "";
  href = "";
  statusBefore = "";
  statusAfter = "";
  clicked: string[] = [];
  completed: string[] = [];
  note = "";
  error = "";

  get ok(): boolean {
    return !this.error && this.completed.length >= this.clicked.length;
  }
}

type Log = ((message: string) => void) | undefined;

function say(log: Log, message: string): void {
  log?.(message);
}

function questScore(quest: QuestCard): number {
  const text = `${quest.text || ""} ${quest.href || ""}`.toLowerCase();
  let score = 0;

  if (text.replace(/ /g, "").includes("rewardsapp") || text.includes("pcparent_rewardsapp")) {
    score += 3;
  }

  return score + QUEST_WORDS.filter((word) => text.includes(word)).length;
}

/** The desktop-app quest card on /earn, or undefined. */
export async function findQuest(driver: WebDriver): Promise<QuestCard | undefined> {
  await driver.get(EARN_URL);
  await page.waitReady(driver, 25);

  let quests: QuestCard[] = [];

  for (let i = 0; i < 6; i += 1) {
    await sleep(1500);

    try {
      quests = ((await driver.executeScript(QUESTS_JS)) as QuestCard[] | null) ?? [];
    } catch {
      quests = [];
    }

    if (quests.length) break;
  }

  const ranked = [...quests].sort((a, b) => questScore(b) - questScore(a));

  if (!ranked.length || questScore(ranked[0]!) === 0) {
    return undefined;
  }

  return ranked[0];
}

export async function readActivities(driver: WebDriver, wait = 15): Promise<Activities> {
  const deadline = Date.now() + wait * 1000;
  let data: Activities = EMPTY;

  while (Date.now() < deadline) {
    try {
      data = ((await driver.executeScript(ACTIVITIES_JS)) as Activities | null) ?? data;
    } catch {
      // The page is still loading.
    }

    if (data.items?.length) break;

    await sleep(1000);
  }

  return data;
}

async function click(driver: WebDriver, index: number): Promise<boolean> {
  let element: WebElement | null;

  try {
    element = (await driver.executeScript("return (window.__edgetsQuest || [])[arguments[0]] || null;", index)) as WebElement | null;
  } catch {
    element = null;
  }

  return element ? page.clickElement(driver, element) : false;
}

/**
 * Load `url` in the app's page and wait for the activities.
 *
 * The navigation is started from the page itself and never waited on by the
 * driver: after an activity the app's page can stay "loading" forever, and
 * `driver.get` would then block for minutes. Returns the activities, or
 * undefined when the page did not come back.
 */
async function go(driver: WebDriver, url: string, wait = 25): Promise<Activities | undefined> {
  try {
    await driver.executeScript("window.location.href = arguments[0];", url);
  } catch {
    return undefined;
  }

  await sleep(2000);
  const data = await readActivities(driver, wait);
  return data.items?.length ? data : undefined;
}

/** The driver on the app, replaceable when the app is restarted. */
export class Connection {
  main = "";

  constructor(
    public driver: WebDriver,
    /** Restarts the app and replaces `driver`. */
    readonly reconnect?: (conn: Connection) => Promise<void>,
  ) {}

  static async create(driver: WebDriver, reconnect?: (conn: Connection) => Promise<void>): Promise<Connection> {
    const conn = new Connection(driver, reconnect);
    conn.main = await driver.getWindowHandle();
    return conn;
  }
}

/**
 * Back to the quest page after an activity (the app's Home). Windows the
 * activity opened belong to the app and are left alone (closing them left the
 * app blank). If the page does not come back, the app is restarted, which
 * always lands on a fresh page.
 */
async function home(conn: Connection, url: string, log?: Log): Promise<Activities> {
  const driver = conn.driver;

  try {
    const handles = await driver.getAllWindowHandles();

    if (handles.includes(conn.main)) {
      await driver.switchTo().window(conn.main);
    } else if (handles.length) {
      await driver.switchTo().window(handles[0]!);
    }
  } catch {
    // Use whatever tab is active.
  }

  const data = await go(driver, url);

  if (data) {
    return data;
  }

  if (!conn.reconnect) {
    return EMPTY;
  }

  say(log, "halaman app macet · buka ulang app");
  await conn.reconnect(conn);
  conn.main = await conn.driver.getWindowHandle();

  try {
    await conn.driver.get(url);
  } catch {
    // Read below.
  }

  return readActivities(conn.driver, 25);
}

/** Do today's open activity of the desktop-app quest. */
export async function runQuest(connIn: Connection | WebDriver, log?: Log, dwell: [number, number] = [8, 12]): Promise<QuestResult> {
  const conn = connIn instanceof Connection ? connIn : await Connection.create(connIn);
  const result = new QuestResult();

  const quest = await findQuest(conn.driver);

  if (!quest) {
    result.note = "quest desktop tidak ada di Earn";
    return result;
  }

  result.href = quest.href;
  result.title = (quest.text || "").replace(/^expires in [^A-Z]*/i, "").slice(0, 60);

  if (quest.total && quest.done !== null && quest.done >= quest.total) {
    result.statusBefore = result.statusAfter = `${quest.done}/${quest.total} tasks`;
    result.note = "quest sudah selesai";
    return result;
  }

  conn.main = await conn.driver.getWindowHandle();
  const data = (await go(conn.driver, result.href)) ?? EMPTY;
  result.statusBefore = result.statusAfter = data.status || "";

  if (!data.found) {
    result.error = "daftar aktivitas quest tidak terbaca";
    return result;
  }

  const todo = data.items.filter((item) => item.open);

  if (!todo.length) {
    result.note = "tidak ada aktivitas terbuka hari ini";
    return result;
  }

  for (const item of todo) {
    const title = item.title;
    result.clicked.push(title);

    let ticked = false;

    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
      throwIfInterrupted();

      say(log, `aktivitas · ${title} · ${item.button}` + (attempt > 1 ? ` · percobaan ${attempt}` : ""));

      const fresh = await readActivities(conn.driver);
      const target = fresh.items.find((i) => i.title === title);

      if (!target) {
        ticked = true; // Nothing left to retry (python breaks out without the "belum" note).
        break;
      }

      if (target.done) {
        result.completed.push(title);
        ticked = true;
        break;
      }

      if (!(await click(conn.driver, target.index))) {
        say(log, "tombol tidak bisa diklik");
        continue;
      }

      await sleep((dwell[0] + Math.random() * (dwell[1] - dwell[0])) * 1000);

      const after = await home(conn, result.href, log);
      result.statusAfter = after.status || result.statusAfter;
      const state = (after.items ?? []).find((i) => i.title === title);

      if (state?.done) {
        result.completed.push(title);
        say(log, `tercentang · ${title}`);
        ticked = true;
        break;
      }

      await sleep(3000);
    }

    if (!ticked) {
      say(log, `belum tercentang · ${title}`);
    }
  }

  if (result.completed.length < result.clicked.length) {
    result.error = "aktivitas belum tercentang: " + result.clicked.filter((t) => !result.completed.includes(t)).join(", ");
  }

  return result;
}
