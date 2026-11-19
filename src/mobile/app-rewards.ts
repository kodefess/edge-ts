/**
 * Rewards tasks inside the Bing app: daily check-in and More activities.
 *
 * Reached from the profile page by tapping "Total points":
 *
 *     profile ──Total points──▶ Rewards page (TemplateActivity, a WebView)
 *
 *     Streaks
 *       Check in            50  (○)     ← (○) expands the 7-day streak
 *       Search 1 time        3  (○)
 *       Daily set          100  (○)
 *     Today's points            105/120
 *     Daily activities
 *       Read to earn, …, 15 out of 30 points earned
 *     More activities           10/15
 *       Do you know the answer?, …, earn 5 points     ← only open cards
 *     Redeem your points · Contact support · …
 *
 * - **Check in.** When today's check-in is recorded, the row collapses to
 *   "Check in ··· 50 ✓". While it is open, a countdown ("15h 44m") and the 7
 *   day circles show; tapping today's circle checks in. The accessibility tree
 *   has no "done" flag, so the collapsed row is the signal.
 * - **More activities.** Finished cards disappear and the counter rises
 *   (10/15 → 15/15). Opening a card is enough: it starts a Bing search in the
 *   in-app browser; back on the Rewards page the card is gone. Cards still
 *   listed are open, so each is tapped once.
 * - **Read to earn.** "N out of 30 points earned" tells how many articles are
 *   still worth reading (3 points each).
 */
import { sleep } from "../utils/delay";
import { type AppiumDriver, type UiNode, goBack, readNodes, screenSize, swipeUp, tapNode } from "./appium";
import type { Log } from "./app-news";

function say(log: Log, message: string): void {
  log?.(message);
}

const PROGRESS = /^\s*(\d+)\s*\/\s*(\d+)\s*$/;
const READ_PROGRESS = /(\d+)\s+out\s+of\s+(\d+)/i;

/** Rows below "More activities" that are links, not activities. */
const FOOTER_LINKS = ["redeem your points", "contact support", "order history", "go to rewards dashboard"];

export const POINTS_PER_ARTICLE = 3;

// ============================================================
// Results
// ============================================================

/** What the Rewards page step did for one account. */
export class RewardsResult {
  /** checked_in · already · failed · missing · off */
  checkin = "off";
  checkinNote = "";
  activitiesBefore = "";
  activitiesAfter = "";
  activitiesOpened: string[] = [];
  activitiesLeft: string[] = [];
  readEarned: number | undefined;
  readCap: number | undefined;
  error = "";

  /** True when the counter is full (or there was nothing to do). */
  get activitiesDone(): boolean {
    const [done, total] = parseProgress(this.activitiesAfter || this.activitiesBefore);

    if (done === undefined) {
      return !this.activitiesLeft.length;
    }

    return done >= (total ?? 0);
  }

  /** Articles still worth reading for Read to Earn, or undefined. */
  get articlesNeeded(): number | undefined {
    if (this.readEarned === undefined || !this.readCap) {
      return undefined;
    }

    const left = Math.max(0, this.readCap - this.readEarned);
    return Math.ceil(left / POINTS_PER_ARTICLE);
  }
}

export function parseProgress(text: string | undefined): [number | undefined, number | undefined] {
  const match = PROGRESS.exec(text ?? "");

  if (!match) {
    return [undefined, undefined];
  }

  return [Number(match[1]), Number(match[2])];
}

// ============================================================
// Page reading (pure)
// ============================================================

export function labelled(nodes: UiNode[], label: string): UiNode[] {
  const wanted = label.toLowerCase();
  return nodes.filter((n) => n.label.trim().toLowerCase() === wanted);
}

export function isRewardsPage(nodes: UiNode[]): boolean {
  return ["Streaks", "More activities", "Today's points", "Daily activities"].some(
    (label) => labelled(nodes, label).length > 0,
  );
}

function sameRow(nodes: UiNode[], anchor: UiNode, tolerance = 24): UiNode[] {
  const [, ay1, , ay2] = anchor.rect;
  const cy = Math.floor((ay1 + ay2) / 2);
  return nodes.filter((n) => n !== anchor && Math.abs(n.y - cy) <= tolerance);
}

export type StreakDay = [label: string, checked: boolean, circle: UiNode];

/**
 * The 7 streak days of the expanded Check in row, left to right. Each "Day N"
 * caption has its circle directly above it: the circle reads "checked" when
 * that day is done, otherwise the points it pays ("10", "50").
 */
export function streakDays(nodes: UiNode[]): StreakDay[] {
  const days: StreakDay[] = [];

  for (const caption of nodes) {
    const label = caption.label.trim();

    if (!/^Day\s+\d+$/i.test(label)) continue;

    const [cx1, cy1, cx2] = caption.rect;

    const above = nodes.filter(
      (n) => n.label && n !== caption && cx1 - 15 <= n.x && n.x <= cx2 + 15 && n.rect[3] <= cy1 + 4 && cy1 - n.rect[3] < 45,
    );

    if (!above.length) continue;

    const circle = above.reduce((best, n) => (cy1 - n.rect[3] < cy1 - best.rect[3] ? n : best));
    days.push([label, circle.label.trim().toLowerCase() === "checked", circle]);
  }

  return days.sort((a, b) => a[2].x - b[2].x);
}

/**
 * `[state, detail, target]` for the Check in row.
 *
 * - **pending**: the row is open (countdown + Day 1–7 circles), today's one
 *   not "checked" yet. `target` is that circle; tapping it checks in.
 * - **done**: the row is collapsed to "Check in ··· 50 ✓".
 * - **missing**: no Check in row on screen.
 */
export function checkinState(nodes: UiNode[]): [string, string, UiNode | undefined] {
  const heading = labelled(nodes, "Check in").find((n) => !n.clickable);

  if (!heading) {
    return ["missing", "", undefined];
  }

  // Only the circles between "Check in" and the next streak row.
  const nextRow = Math.min(
    10 ** 6,
    ...nodes
      .filter(
        (n) =>
          n.y > heading.y + 10 && ["search 1 time", "daily set", "today's points"].includes(n.label.trim().toLowerCase()),
      )
      .map((n) => n.y),
  );

  const days = streakDays(nodes).filter((d) => heading.y < d[2].y && d[2].y < nextRow);

  if (!days.length) {
    // Collapsed: today's check-in is recorded.
    return ["done", "", undefined];
  }

  const open = days.filter((d) => !d[1]);

  if (!open.length) {
    return ["done", `${days.length}/${days.length} hari`, undefined];
  }

  const [day, , circle] = open[0]!;
  return ["pending", day, circle];
}

/** A "Check in" button in the expanded row (below the heading). */
export function checkinAction(nodes: UiNode[], headingY: number): UiNode | undefined {
  return nodes.find((node) => {
    const label = node.label.trim().toLowerCase();
    return node.clickable && node.y > headingY + 30 && ["check in", "check in now", "claim", "check-in"].includes(label);
  });
}

/** `[progress, cards]` of More activities on the current screen. */
export function activitiesSection(nodes: UiNode[]): [string, UiNode[]] {
  const header = labelled(nodes, "More activities")[0];

  if (!header) {
    return ["", []];
  }

  const progress = sameRow(nodes, header).find((n) => PROGRESS.test(n.label || ""))?.label.trim() ?? "";

  const stopY = Math.min(
    10 ** 6,
    ...nodes.filter((n) => FOOTER_LINKS.includes(n.label.trim().toLowerCase()) && n.y > header.y).map((n) => n.y),
  );

  const cards: UiNode[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    const label = node.label.trim();

    if (
      node.clickable &&
      label &&
      header.y < node.y &&
      node.y < stopY &&
      !FOOTER_LINKS.includes(label.toLowerCase()) &&
      !seen.has(label)
    ) {
      // Outer and inner views repeat the same description.
      seen.add(label);
      cards.push(node);
    }
  }

  return [progress, cards];
}

/** `[earned, cap]` from the Read to earn card, or `[undefined, undefined]`. */
export function readToEarn(nodes: UiNode[]): [number | undefined, number | undefined] {
  for (const node of nodes) {
    if (node.label.toLowerCase().startsWith("read to earn")) {
      const match = READ_PROGRESS.exec(node.label);

      if (match) {
        return [Number(match[1]), Number(match[2])];
      }
    }
  }

  return [undefined, undefined];
}

/** Balance at the top of the Rewards page ("13.235" next to "pts"). */
export function pagePoints(nodes: UiNode[]): number | undefined {
  const unit = labelled(nodes, "pts")[0];

  if (!unit) {
    return undefined;
  }

  for (const node of sameRow(nodes, unit, 30)) {
    const digits = [...node.label].filter((ch) => ch >= "0" && ch <= "9").join("");

    if (digits && node.x < unit.x) {
      return Number(digits);
    }
  }

  return undefined;
}

export function cardTitle(node: UiNode): string {
  return node.label.split(",")[0]!.trim() || node.label.slice(0, 40);
}

// ============================================================
// Phone actions
// ============================================================

async function scrollTop(driver: AppiumDriver, times = 4): Promise<void> {
  const [width, height] = await screenSize(driver);

  for (let i = 0; i < times; i += 1) {
    try {
      await driver.swipe(Math.floor(width / 2), Math.trunc(height * 0.35), Math.floor(width / 2), Math.trunc(height * 0.85), 350);
    } catch {
      return;
    }
    await sleep(500);
  }
}

async function waitFor(
  driver: AppiumDriver,
  check: (nodes: UiNode[]) => boolean,
  timeout: number,
): Promise<UiNode[] | undefined> {
  const deadline = Date.now() + timeout * 1000;
  let nodes = await readNodes(driver);

  while (Date.now() < deadline) {
    if (check(nodes)) {
      return nodes;
    }
    await sleep(800);
    nodes = await readNodes(driver);
  }

  return check(nodes) ? nodes : undefined;
}

function rewardsLoaded(nodes: UiNode[]): boolean {
  return isRewardsPage(nodes) && (labelled(nodes, "Check in").length > 0 || labelled(nodes, "More activities").length > 0);
}

async function activity(driver: AppiumDriver): Promise<string> {
  try {
    return (await driver.currentActivity()) || "";
  } catch {
    return "";
  }
}

/**
 * From the profile page, tap Total points and wait for the page.
 *
 * On a slow phone the WebView can take well over 20 s, or the first tap lands
 * while the profile page is still settling; the tap is repeated (only while
 * the profile page is still showing) before giving up.
 */
export async function openRewardsPage(
  driver: AppiumDriver,
  profileNodes: UiNode[],
  wait = 25,
  tries = 3,
  log?: Log,
): Promise<UiNode[]> {
  let nodes = profileNodes;

  for (let attempt = 0; attempt < tries; attempt += 1) {
    let target = labelled(nodes, "Total points")[0];

    if (!target && !rewardsLoaded(nodes)) {
      nodes = await readNodes(driver);
      target = labelled(nodes, "Total points")[0];
    }

    if (target) {
      if (attempt) {
        say(log, `buka Rewards · percobaan ${attempt + 1}`);
      }
      await tapNode(driver, target);
    }

    // The WebView content arrives a few seconds after the activity.
    const loaded = await waitFor(driver, rewardsLoaded, wait);

    if (loaded) {
      await scrollTop(driver);
      return readNodes(driver);
    }

    nodes = await readNodes(driver);

    // A blank WebView: reload it with the page's own Refresh button.
    if ((await activity(driver)).includes("Template")) {
      const refresh = nodes.find((n) => n.resourceId.endsWith("header_refresh"));

      if (refresh) {
        say(log, "Rewards kosong · refresh");
        await tapNode(driver, refresh);

        if (await waitFor(driver, rewardsLoaded, wait)) {
          await scrollTop(driver);
          return readNodes(driver);
        }

        nodes = await readNodes(driver);
      }
    }
  }

  throw new Error("halaman Rewards tidak terbuka");
}

/**
 * Leave the in-app browser and wait for the Rewards page.
 *
 * Back is pressed only while the browser is showing: an extra press on a
 * Rewards page that is still reloading would leave it for the profile page.
 */
export async function backToRewards(driver: AppiumDriver, wait = 20): Promise<UiNode[] | undefined> {
  for (let i = 0; i < 4; i += 1) {
    if (!(await activity(driver)).includes("BrowserActivity")) {
      break;
    }

    await goBack(driver);
    await sleep(1500);
  }

  const loaded = await waitFor(driver, rewardsLoaded, wait);

  if (loaded) {
    return loaded;
  }

  // Landed somewhere else (profile page): open Rewards again from there.
  const nodes = await readNodes(driver);

  if (labelled(nodes, "Total points").length) {
    try {
      return await openRewardsPage(driver, nodes, 25, 1);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export async function doCheckin(driverIn: AppiumDriver, nodesIn: UiNode[], result: RewardsResult, log?: Log): Promise<void> {
  const driver = driverIn;
  let nodes = nodesIn;

  // The streak circles render a moment after the page; give them time before
  // deciding the row is collapsed (= done).
  let [state, detail, circle] = checkinState(nodes);

  for (let i = 0; i < 4; i += 1) {
    if (state !== "done" || detail) break;

    await sleep(1000);
    nodes = await readNodes(driver);
    [state, detail, circle] = checkinState(nodes);
  }

  if (state === "done") {
    result.checkin = "already";
    result.checkinNote = detail;
    return;
  }

  if (state === "missing" || !circle) {
    result.checkin = "missing";
    result.checkinNote = "baris Check in tidak ditemukan";
    return;
  }

  const before = pagePoints(nodes);
  let nextCircle: UiNode | undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    say(log, `check in · ${detail}`);
    await tapNode(driver, circle);

    // Confirmed when the row collapses to "N ✓", the day turns "checked", or
    // the balance at the top goes up.
    const deadline = Date.now() + 8000;

    while (Date.now() < deadline) {
      await sleep(1000);
      nodes = await readNodes(driver);
      const after = pagePoints(nodes);
      const gained = before !== undefined && after !== undefined ? after - before : 0;
      let current: string;
      [current, , nextCircle] = checkinState(nodes);

      if (gained > 0 || current === "done" || (nextCircle && nextCircle.x > circle.x + 20)) {
        result.checkin = "checked_in";
        result.checkinNote = gained > 0 ? `${detail} · +${gained}` : detail;
        return;
      }
    }

    if (nextCircle) {
      circle = nextCircle;
    }
  }

  result.checkin = "failed";
  result.checkinNote = `${detail} tidak tercentang setelah 3x ketuk`;
}

export async function doActivities(
  driver: AppiumDriver,
  result: RewardsResult,
  maxCards = 8,
  dwell = 5.0,
  log?: Log,
): Promise<void> {
  let nodes: UiNode[] = [];

  // More activities sits below the fold.
  for (let i = 0; i < 4; i += 1) {
    nodes = await readNodes(driver);

    if (labelled(nodes, "More activities").length) break;

    await swipeUp(driver, 0.45);
    await sleep(1000);
  }

  let [progress, cards] = activitiesSection(nodes);
  result.activitiesBefore = progress;
  result.activitiesAfter = progress;

  let [earned, cap] = readToEarn(nodes);

  if (earned !== undefined) {
    result.readEarned = earned;
    result.readCap = cap;
  }

  const tried = new Set<string>();

  for (let i = 0; i < maxCards; i += 1) {
    const [done, total] = parseProgress(progress);
    const openCards = cards.filter((c) => !tried.has(c.label));

    if ((done !== undefined && done >= (total ?? 0)) || !openCards.length) break;

    const card = openCards[0]!;
    tried.add(card.label);
    say(log, `aktivitas · ${cardTitle(card)}`);

    await tapNode(driver, card);
    await sleep(dwell * 1000);

    const back = await backToRewards(driver);

    if (!back) {
      result.error = "tidak bisa kembali ke halaman Rewards";
      break;
    }

    nodes = back;

    // Re-find the section after the page reloads.
    for (let j = 0; j < 3; j += 1) {
      if (labelled(nodes, "More activities").length) break;

      await swipeUp(driver, 0.45);
      await sleep(1000);
      nodes = await readNodes(driver);
    }

    [progress, cards] = activitiesSection(nodes);
    result.activitiesAfter = progress || result.activitiesAfter;

    if (cards.some((c) => c.label === card.label)) {
      result.activitiesLeft.push(cardTitle(card));
    } else {
      result.activitiesOpened.push(cardTitle(card));
    }

    [earned, cap] = readToEarn(nodes);

    if (earned !== undefined) {
      result.readEarned = earned;
      result.readCap = cap;
    }
  }
}

/**
 * `[earned, cap]` of Read to earn, read fresh from the Rewards page.
 *
 * The page can show a cached counter right after reading. When it is not
 * above `expectAbove` (the value before the round), the page is refreshed
 * with its own Refresh button and read again.
 */
export async function checkReadProgress(
  driver: AppiumDriver,
  profileNodes: UiNode[],
  expectAbove?: number,
  log?: Log,
): Promise<[number | undefined, number | undefined]> {
  const readCounter = async (): Promise<[number | undefined, number | undefined]> => {
    let nodes = await readNodes(driver);

    for (let i = 0; i < 5; i += 1) {
      const [earned, cap] = readToEarn(nodes);

      if (earned !== undefined) {
        return [earned, cap];
      }

      await swipeUp(driver, 0.45);
      await sleep(1000);
      nodes = await readNodes(driver);
    }

    return [undefined, undefined];
  };

  await openRewardsPage(driver, profileNodes, 25, 3, log);
  let [earned, cap] = await readCounter();

  for (let i = 0; i < 2; i += 1) {
    if (earned === undefined || expectAbove === undefined || earned > expectAbove) break;
    if (cap && earned >= cap) break;

    const refresh = (await readNodes(driver)).find((n) => n.resourceId.endsWith("header_refresh"));

    if (!refresh) break;

    say(log, "read to earn belum naik · refresh");
    await sleep(3000);
    await tapNode(driver, refresh);
    await waitFor(driver, rewardsLoaded, 20);
    [earned, cap] = await readCounter();
  }

  return [earned, cap];
}

/** Check in and finish More activities; never throws. */
export async function runRewards(
  driver: AppiumDriver,
  profileNodes: UiNode[],
  options: { checkin?: boolean; activities?: boolean; log?: Log } = {},
): Promise<RewardsResult> {
  const { checkin = true, activities = true, log } = options;
  const result = new RewardsResult();

  if (!checkin && !activities) {
    return result;
  }

  try {
    const nodes = await openRewardsPage(driver, profileNodes, 25, 3, log);

    if (checkin) {
      await doCheckin(driver, nodes, result, log);
    }

    if (activities) {
      await doActivities(driver, result, 8, 5.0, log);
    } else {
      const [earned, cap] = readToEarn(await readNodes(driver));
      result.readEarned = earned;
      result.readCap = cap;
    }
  } catch (error) {
    // Reading still runs.
    result.error = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
  }

  return result;
}
