/**
 * Switch between the Microsoft accounts signed in to the Bing app.
 *
 * The Bing app keeps several accounts on one phone. The switcher lives behind
 * the profile button in the top-left corner of the home screen:
 *
 *     home ──Profile──▶ profile page ──account row──▶ Accounts page
 *          (sa_profile_button)  (name, email, points)   ("Signed in as",
 *                                                        "Switch to another
 *                                                         account" list)
 *
 * On the Accounts page a tap on a row only *selects* it (a check mark appears)
 * and turns the bottom-right button from "Sign out" into "Switch now". Both
 * labels live on the same resource id (`sapphire_amp_action_button`), so this
 * module checks the label before every tap and never presses "Sign out" or
 * "Remove account".
 *
 * After "Switch now" the app lands on the profile page of the new account,
 * which also shows "Total points", "Daily points" (e.g. `99/120`) and "Daily
 * streaks"; `readProfileStats` reads those for the recap.
 */
import {
  MOBILE_APP_DWELL_MAX,
  MOBILE_APP_DWELL_MIN,
  MOBILE_APP_MAX_SWIPES,
  MOBILE_APP_NEWS_MAX,
  MOBILE_APPIUM_APP_PACKAGE,
  MOBILE_APPIUM_WAIT,
} from "../config/settings";
import { sleep } from "../utils/delay";
import { InterruptedError, throwIfInterrupted } from "../utils/interrupt";
import { type AppArticle, type AppNewsResult, type Log, dismissPopups, readAppFeed } from "./app-news";
import { POINTS_PER_ARTICLE, type RewardsResult, checkReadProgress, runRewards } from "./app-rewards";
import {
  type AppiumDriver,
  type UiNode,
  currentPackage,
  goBack,
  launchApp,
  readNodes,
  screenSize,
  setDialogLog,
  tapNode,
} from "./appium";

function say(log: Log, message: string): void {
  log?.(message);
}

/** Labels that must never be tapped by this module. */
const FORBIDDEN = ["sign out", "remove account", "keluar", "hapus akun"];

const SWITCH_WORDS = ["switch now", "beralih sekarang", "ganti sekarang"];

// ============================================================
// Screen recognition (pure)
// ============================================================

/** Nodes whose resource id ends with `suffix`. */
export function byId(nodes: UiNode[], suffix: string): UiNode[] {
  return nodes.filter((node) => node.resourceId.endsWith(suffix));
}

export function firstId(nodes: UiNode[], suffix: string): UiNode | undefined {
  return byId(nodes, suffix)[0];
}

export function withLabel(nodes: UiNode[], label: string): UiNode[] {
  const wanted = label.trim().toLowerCase();
  return nodes.filter((node) => node.label.trim().toLowerCase() === wanted);
}

export function isAccountsPage(nodes: UiNode[]): boolean {
  return Boolean(firstId(nodes, "sapphire_amp_profile_account_hint"));
}

/**
 * The profile page, even before its points have loaded. "Total points" /
 * "Daily points" come from the network and can be missing for a few seconds;
 * the General menu below them is static.
 */
export function isProfilePage(nodes: UiNode[]): boolean {
  if (withLabel(nodes, "Daily points").length && withLabel(nodes, "Total points").length) {
    return true;
  }

  return (
    ["History", "Bookmarks", "Settings"].every((label) => withLabel(nodes, label).length > 0) &&
    !firstId(nodes, "sa_search_box")
  );
}

export function isHome(nodes: UiNode[]): boolean {
  return Boolean(firstId(nodes, "sa_search_box")) || Boolean(firstId(nodes, "sa_profile_button"));
}

/** Email shown under "Signed in as" on the Accounts page. */
export function accountsCurrent(nodes: UiNode[]): string {
  const node = firstId(nodes, "sapphire_amp_profile_account_hint");
  return node ? node.label.trim().toLowerCase() : "";
}

/** `[name, email]` pairs of the "Switch to another account" rows. */
export function accountsListed(nodes: UiNode[]): Array<[string, string]> {
  const names = byId(nodes, "profile_display_name");
  const emails = byId(nodes, "profile_display_email");
  const pairs: Array<[string, string]> = [];

  for (const email of emails) {
    // The name sits directly above its email, in the same row.
    const name =
      names.find((item) => Math.abs(item.rect[0] - email.rect[0]) < 8 && email.rect[1] - item.rect[3] >= 0 && email.rect[1] - item.rect[3] < 12)
        ?.label ?? "";

    pairs.push([name.trim(), email.label.trim().toLowerCase()]);
  }

  return pairs;
}

/** Email on the profile page (first e-mail shaped label at the top). */
export function profileEmail(nodes: UiNode[]): string {
  const height = Math.max(0, ...nodes.map((n) => n.rect[3]));

  for (const node of nodes) {
    const label = node.label.trim();

    if (label.includes("@") && !label.includes(" ") && node.y < height * 0.35) {
      return label.toLowerCase();
    }
  }

  return "";
}

export type ProfileStats = Record<string, string>;

/**
 * `{"total": "13,229", "daily": "99/120", "streak": "112 days"}`. Each value
 * sits directly above its caption in the same column.
 */
export function readProfileStats(nodes: UiNode[]): ProfileStats {
  const captions: Record<string, string> = { total: "Total points", daily: "Daily points", streak: "Daily streaks" };
  const stats: ProfileStats = {};

  for (const [key, caption] of Object.entries(captions)) {
    const label = withLabel(nodes, caption)[0];

    if (!label) continue;

    const [lx1, ly1, lx2] = label.rect;

    const above = nodes.filter(
      (node) =>
        node.label && node !== label && lx1 - 5 <= node.x && node.x <= lx2 + 5 && node.rect[3] <= ly1 + 5 && ly1 - node.rect[3] < 60,
    );

    if (above.length) {
      stats[key] = above.reduce((best, n) => (ly1 - n.rect[3] < ly1 - best.rect[3] ? n : best)).label;
    }
  }

  return stats;
}

/** `"13,229"` / `"13.229"` → `13229`; undefined when unknown. */
export function parsePoints(value: unknown): number | undefined {
  const digits = [...String(value ?? "")].filter((ch) => ch >= "0" && ch <= "9").join("");
  return digits ? Number(digits) : undefined;
}

/** `"99/120"` → `[99, 120]`; `[undefined, undefined]` when unknown. */
export function dailyPoints(stats: ProfileStats | undefined): [number | undefined, number | undefined] {
  const parts = String(stats?.["daily"] ?? "").replace(/,/g, "").split("/");

  if (parts.length !== 2) {
    return [undefined, undefined];
  }

  const earned = Number.parseInt(parts[0]!, 10);
  const cap = Number.parseInt(parts[1]!, 10);

  return Number.isNaN(earned) || Number.isNaN(cap) ? [undefined, undefined] : [earned, cap];
}

// ============================================================
// Navigation
// ============================================================

async function tap(driver: AppiumDriver, node: UiNode | undefined, log?: Log, why = ""): Promise<boolean> {
  if (!node) {
    return false;
  }

  if (FORBIDDEN.some((word) => node.label.toLowerCase().includes(word))) {
    throw new Error(`menolak menekan ${JSON.stringify(node.label)}`);
  }

  if (why) {
    say(log, why);
  }

  const ok = await tapNode(driver, node);
  await sleep(2000);
  return ok;
}

async function scrollToTop(driver: AppiumDriver, times = 5): Promise<void> {
  const [width, height] = await screenSize(driver);

  for (let i = 0; i < times; i += 1) {
    try {
      await driver.swipe(Math.floor(width / 2), Math.trunc(height * 0.3), Math.floor(width / 2), Math.trunc(height * 0.9), 300);
    } catch {
      return;
    }
    await sleep(400);
  }
}

/** Give the profile page time to show its email and points. */
export async function waitProfileLoaded(driver: AppiumDriver, nodesIn: UiNode[], timeout = 12): Promise<UiNode[]> {
  let nodes = nodesIn;
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    if (profileEmail(nodes) && withLabel(nodes, "Daily points").length) {
      return nodes;
    }

    await sleep(800);
    nodes = await readNodes(driver);
  }

  return nodes;
}

/**
 * Navigate to the profile page and return its nodes.
 *
 * A screen that is none of the known ones and does not leave with back presses
 * (the search page "Ask anything · Recent searches" does this) gets one
 * restart of the app, which always lands on the home screen.
 */
export async function openProfilePage(driver: AppiumDriver, appPackage?: string, log?: Log, rounds = 14): Promise<UiNode[]> {
  const pkg = (appPackage || MOBILE_APPIUM_APP_PACKAGE).trim();
  await launchApp(driver, pkg);
  let unknown = 0;
  let restarted = false;

  for (let i = 0; i < rounds; i += 1) {
    throwIfInterrupted();

    // Crashed, or a back press left the app: bring it back first.
    if ((await currentPackage(driver)) !== pkg) {
      say(log, "Bing tidak di depan · buka ulang");
      await launchApp(driver, pkg);
      continue;
    }

    await dismissPopups(driver, 1);
    const nodes = await readNodes(driver);

    if (isProfilePage(nodes)) {
      return waitProfileLoaded(driver, nodes);
    }

    if (isAccountsPage(nodes)) {
      await tap(driver, firstId(nodes, "sa_amp_header_action_back"));
      continue;
    }

    const profileButton = firstId(nodes, "sa_profile_button");

    if (profileButton) {
      await tap(driver, profileButton);
      continue;
    }

    if (isHome(nodes)) {
      // Home scrolled down: the profile button is only at the top.
      await scrollToTop(driver);
      continue;
    }

    // Another page of the app (Rewards, an article, Copilot…): the bottom
    // bar's Home tab returns to the home screen.
    const homeTab = withLabel(nodes, "Home").find((node) => node.clickable || node.container.some(Boolean));

    if (homeTab && homeTab.y > nodes[0]!.rect[3] * 0.85) {
      await tap(driver, homeTab);
      continue;
    }

    // Splash or a page still loading: give it time before backing out, a back
    // press on the home screen would close the app.
    unknown += 1;

    if (unknown <= 3) {
      await sleep(2000);
      continue;
    }

    if (unknown >= 6 && !restarted) {
      say(log, "halaman tidak dikenal · restart Bing");
      await restartApp(driver, pkg);
      restarted = true;
      unknown = 0;
      continue;
    }

    await goBack(driver);
    await sleep(1500);
  }

  throw new Error("halaman profil Bing tidak ditemukan");
}

/** Navigate to the Accounts (switcher) page and return its nodes. */
export async function openAccountsPage(driver: AppiumDriver, appPackage?: string, log?: Log, rounds = 6): Promise<UiNode[]> {
  for (let i = 0; i < rounds; i += 1) {
    let nodes = await readNodes(driver);

    if (isAccountsPage(nodes)) {
      return nodes;
    }

    if (!isProfilePage(nodes)) {
      nodes = await openProfilePage(driver, appPackage, log);
    }

    const email = profileEmail(nodes);
    const row = nodes.find((node) => node.label.trim().toLowerCase() === email);

    await tap(driver, row);
  }

  throw new Error("halaman Accounts Bing tidak ditemukan");
}

/**
 * From any app page back to the home feed.
 *
 * The bottom bar's Home tab is used whenever it is there (profile page,
 * Rewards page, Tabs, articles): the Rewards WebView's own Back button
 * sometimes ignores taps, which once left the reader stuck on that page
 * ("feed berita tidak ditemukan"). Pages without the bar (Accounts) use their
 * Back button, then the system back.
 */
export async function returnHome(driver: AppiumDriver, rounds = 5): Promise<boolean> {
  for (let i = 0; i < rounds; i += 1) {
    const nodes = await readNodes(driver);

    if (isHome(nodes) && !isProfilePage(nodes)) {
      return true;
    }

    const bottom = (nodes[0]?.rect[3] ?? 0) * 0.85;
    const homeTab = withLabel(nodes, "Home").find((node) => (node.clickable || node.container.some(Boolean)) && node.y > bottom);

    if (homeTab) {
      await tap(driver, homeTab);
      continue;
    }

    const back = firstId(nodes, "sa_amp_header_action_back") ?? withLabel(nodes, "Back")[0];

    if (back) {
      await tap(driver, back);
    } else {
      await goBack(driver);
      await sleep(1500);
    }
  }

  return isHome(await readNodes(driver));
}

/** Close and reopen the Bing app, to recover from a hang or crash. */
export async function restartApp(driver: AppiumDriver, appPackage?: string): Promise<void> {
  const pkg = (appPackage || MOBILE_APPIUM_APP_PACKAGE).trim();

  try {
    await driver.terminateApp(pkg);
  } catch {
    // Ignore.
  }

  await sleep(2000);
  await launchApp(driver, pkg);
  await sleep(3000);
}

// ============================================================
// Account runs
// ============================================================

/** What happened for one account. */
export class AccountRun {
  name = "";
  before: ProfileStats = {};
  after: ProfileStats = {};
  news: AppNewsResult | undefined;
  rewards: RewardsResult | undefined;
  error = "";
  skipped = "";
  interrupted = false;
  duration = 0;
  target = 0;
  attempt = 1;
  previousProblem = "";
  readOff = false;
  /** Read to earn points (e.g. 0 → 30 of 30), from the Rewards page. */
  readStart: number | undefined;
  readEnd: number | undefined;
  readCap: number | undefined;
  readRound = 1;
  tabsClosed: number | undefined | null;
  readBalanceStart: number | undefined;

  constructor(
    readonly email: string,
    init: Partial<AccountRun> = {},
  ) {
    Object.assign(this, init);
  }

  /** Reading ran but Read to earn is still below its cap. */
  get readGoalMissed(): boolean {
    if (this.readOff || this.skipped || !this.news) return false;
    if (this.readEnd === undefined || !this.readCap) return false;
    if (this.dailyCapped) return false;
    return this.readEnd < this.readCap;
  }

  /** Daily points hit the app's cap (120/120): nothing more pays today. */
  get dailyCapped(): boolean {
    const [earned, cap] = dailyPoints(Object.keys(this.after).length ? this.after : this.before);
    return earned !== undefined && Boolean(cap) && earned >= (cap ?? 0);
  }

  get ok(): boolean {
    return this.outcome === "ok" || this.outcome === "full";
  }

  /** Why check-in / More activities are not finished, or "". */
  get rewardsProblem(): string {
    const rw = this.rewards;

    if (!rw) return "";
    if (rw.error) return rw.error;
    if (rw.checkin === "failed" || rw.checkin === "missing") return `check in: ${rw.checkinNote || rw.checkin}`;
    if (rw.activitiesLeft.length) return "aktivitas belum selesai: " + rw.activitiesLeft.join(", ");
    return "";
  }

  /** ok · full · partial · error · interrupted */
  get outcome(): "ok" | "full" | "partial" | "error" | "interrupted" {
    if (this.interrupted) return "interrupted";
    if (this.error) return "error";
    if (this.rewardsProblem) return "partial";
    if (this.skipped) return "full";
    if (this.readOff) return "ok";
    if (this.readGoalMissed) return "partial";
    // Read until the app stopped paying; that is as far as it goes.
    if (this.news && this.dailyCapped) return "ok";
    // The goal is the 30 points; a card that did not open on the way does not
    // matter once they are in.
    if (this.readEnd !== undefined && this.readCap && this.readEnd >= this.readCap) return "ok";
    if (!this.news || !this.news.complete) return "partial";
    return "ok";
  }

  get read(): number {
    return this.news ? this.news.read : 0;
  }

  get problem(): string {
    if (this.error) return this.error;

    if (this.readGoalMissed) {
      return (
        `read to earn baru ${this.readEnd}/${this.readCap} setelah ${this.readRound} putaran` +
        (this.news?.error ? ` · ${this.news.error}` : "")
      );
    }

    return this.news?.error || this.rewardsProblem || "";
  }

  get totalBefore(): number | undefined {
    return parsePoints(this.before["total"]);
  }

  get totalAfter(): number | undefined {
    return parsePoints(this.after["total"]);
  }

  /** Gain in total points during this run, from the profile page. */
  get pointsEarned(): number | undefined {
    const before = this.totalBefore;
    const after = this.totalAfter;

    if (before === undefined || after === undefined) {
      return undefined;
    }

    return Math.max(0, after - before);
  }

  asDict(): Record<string, unknown> {
    return {
      email: this.email,
      name: this.name,
      before: this.before,
      after: this.after,
      read: this.read,
      target: this.news ? this.news.target : 0,
      error: this.error || (this.news ? this.news.error : ""),
      skipped: this.skipped,
    };
  }
}

/**
 * Accounts to run, in the order of `wanted` (all when empty). Returns
 * `[selected, missing]` where `missing` are wanted emails the app does not
 * have.
 */
export function selectAccounts(
  available: Array<[string, string]>,
  wanted: string[],
): [Array<[string, string]>, string[]] {
  if (!wanted.length) {
    return [[...available], []];
  }

  const byEmail = new Map(available.map(([name, email]) => [email, [name, email] as [string, string]]));
  const selected: Array<[string, string]> = [];
  const missing: string[] = [];

  for (const raw of wanted) {
    const email = raw.trim().toLowerCase();
    const found = byEmail.get(email);

    if (found) {
      selected.push(found);
    } else if (email) {
      missing.push(email);
    }
  }

  return [selected, missing];
}

/** Shared with the caller so a Ctrl+C still leaves a full recap. */
export class AccountSession {
  runs: AccountRun[] = [];
  planned: Array<[string, string]> = [];
  missing: string[] = [];
  original = "";

  get total(): number {
    return this.planned.length;
  }

  get notStarted(): string[] {
    const done = new Set(this.runs.map((run) => run.email));
    return this.planned.filter(([, email]) => !done.has(email)).map(([, email]) => email);
  }
}

/**
 * Estimate `readEnd` from the balance gain when the card was unread.
 *
 * The balance also includes points credited late for check-in and More
 * activities, so it never overrides a counter read from the Rewards page:
 * doing so reported 30/30 (and skipped the retry) at 27/30.
 */
function settleReadProgress(run: AccountRun): void {
  if (
    run.readEnd !== undefined ||
    run.readBalanceStart === undefined ||
    run.readStart === undefined ||
    !run.readCap ||
    run.readOff
  ) {
    return;
  }

  const final = parsePoints(run.after["total"]);

  if (final === undefined) {
    return;
  }

  const estimate = Math.min(run.readCap, run.readStart + Math.max(0, final - run.readBalanceStart));

  if (run.readEnd === undefined || estimate > run.readEnd) {
    run.readEnd = estimate;
  }
}

/** Headlines already opened for this account today (all rounds and the earlier attempt). */
function readTitles(run: AccountRun, previous?: AccountRun): string[] {
  const titles: string[] = [];

  for (const item of [previous, run]) {
    if (item?.news) {
      titles.push(...item.news.articles.map((article) => article.title));
    }
  }

  return titles;
}

/** Add one reading round to the account's running result. */
function mergeNews(total: AppNewsResult | undefined, batch: AppNewsResult): AppNewsResult {
  if (!total) {
    return batch;
  }

  total.target += batch.target;
  total.articles.push(...batch.articles);
  total.error = batch.error;
  total.screenshot = batch.screenshot || total.screenshot;
  total.xml = batch.xml || total.xml;
  return total;
}

/**
 * Tabs (bottom bar) → More → Close all tabs. Returns tabs closed.
 *
 * Every article and activity opens a tab in the Bing app; they pile up across
 * accounts and slow the phone down. `null` when the Tabs page could not be
 * reached.
 */
export async function closeAllTabs(driver: AppiumDriver, log?: Log): Promise<number | null> {
  const tabsButton = (nodes: UiNode[]): UiNode | undefined => {
    const bottom = (nodes[0]?.rect[3] ?? 0) * 0.85;
    return withLabel(nodes, "Tabs").find((node) => (node.clickable || node.container.some(Boolean)) && node.y > bottom);
  };

  let nodes = await readNodes(driver);

  if (!firstId(nodes, "sa_tabs_title")) {
    let button = tabsButton(nodes);

    if (!button) {
      await returnHome(driver);
      nodes = await readNodes(driver);
      button = tabsButton(nodes);
    }

    if (!button) {
      return null;
    }

    await tap(driver, button);

    let reached = false;

    for (let i = 0; i < 6; i += 1) {
      nodes = await readNodes(driver);

      if (firstId(nodes, "sa_tabs_title")) {
        reached = true;
        break;
      }

      await sleep(800);
    }

    if (!reached) {
      return null;
    }
  }

  const count = byId(nodes, "sa_tab_close").length;

  if (count) {
    await tap(driver, firstId(nodes, "sa_tabs_more"));

    let close: UiNode | undefined;

    for (let i = 0; i < 5; i += 1) {
      nodes = await readNodes(driver);
      close = nodes.find((node) => node.clickable && node.label.toLowerCase().startsWith("close all tabs"));

      if (close) break;

      await sleep(600);
    }

    if (!close) {
      await goBack(driver);
      return null;
    }

    say(log, `tutup ${count} tab`);
    await tap(driver, close);

    if (byId(await readNodes(driver), "sa_tab_close").length) {
      return null;
    }
  }

  // Back to the home screen for whatever comes next.
  const home = withLabel(await readNodes(driver), "Home").find((n) => n.clickable);

  if (home) {
    await tap(driver, home);
  } else {
    await goBack(driver);
  }

  return count;
}

/** Scroll the account list by about six rows. */
async function scrollList(driver: AppiumDriver, down = true): Promise<boolean> {
  const [width, height] = await screenSize(driver);
  const low = Math.trunc(height * 0.8);
  const high = Math.trunc(height * 0.38);
  const [start, end] = down ? [low, high] : [high, low];

  try {
    await driver.swipe(Math.floor(width / 2), start, Math.floor(width / 2), end, 700);
  } catch {
    return false;
  }

  await sleep(800);
  return true;
}

async function scrollListTop(driver: AppiumDriver, maxPages = 12): Promise<void> {
  for (let i = 0; i < maxPages; i += 1) {
    const before = JSON.stringify(accountsListed(await readNodes(driver)));
    await scrollList(driver, false);

    if (JSON.stringify(accountsListed(await readNodes(driver))) === before) {
      break;
    }
  }
}

/** All accounts in the app as `[name, email]`, current first. */
export async function listAccounts(
  driver: AppiumDriver,
  appPackage?: string,
  log?: Log,
  maxPages = 12,
): Promise<Array<[string, string]>> {
  let nodes = await openAccountsPage(driver, appPackage, log);
  const current = accountsCurrent(nodes);
  const currentName = byId(nodes, "sapphire_amp_profile_display_name")[0];

  const accounts: Array<[string, string]> = [[currentName ? currentName.label : "", current]];
  const seen = new Set([current]);

  for (let page = 0; page < maxPages; page += 1) {
    let fresh = 0;

    for (const [name, email] of accountsListed(nodes)) {
      if (email && !seen.has(email)) {
        seen.add(email);
        accounts.push([name, email]);
        fresh += 1;
      }
    }

    if (!fresh && page > 0) break;

    await scrollList(driver, true);
    nodes = await readNodes(driver);
  }

  await scrollListTop(driver, maxPages);

  return accounts;
}

/** Scroll the list until `email` is visible; return its node. */
async function findRow(driver: AppiumDriver, email: string, maxPages = 12): Promise<UiNode | undefined> {
  // Start from the top of the list, then walk down.
  await scrollListTop(driver, maxPages);

  let previous: string | undefined;

  for (let i = 0; i < maxPages; i += 1) {
    const nodes = await readNodes(driver);
    const match = byId(nodes, "profile_display_email").find((node) => node.label.trim().toLowerCase() === email);

    if (match) {
      return match;
    }

    const listed = JSON.stringify(accountsListed(nodes));

    if (listed === previous) break;

    previous = listed;
    await scrollList(driver, true);
  }

  return undefined;
}

/** Make `email` the active account. Returns the profile page nodes. */
export async function switchAccount(
  driver: AppiumDriver,
  emailIn: string,
  appPackage?: string,
  log?: Log,
  wait: number = MOBILE_APPIUM_WAIT,
): Promise<UiNode[]> {
  const email = emailIn.trim().toLowerCase();
  let nodes = await openAccountsPage(driver, appPackage, log);

  if (accountsCurrent(nodes) === email) {
    await tap(driver, firstId(nodes, "sa_amp_header_action_back"));
    return openProfilePage(driver, appPackage, log);
  }

  const row = await findRow(driver, email);

  if (!row) {
    throw new Error(`akun ${email} tidak ada di daftar aplikasi Bing`);
  }

  await tap(driver, row, log, `pilih akun · ${email}`);

  // Selecting a row turns "Sign out" into "Switch now".
  let deadline = Date.now() + 10_000;
  let button: UiNode | undefined;

  while (Date.now() < deadline) {
    nodes = await readNodes(driver);
    button = byId(nodes, "sapphire_amp_action_button").find((node) => SWITCH_WORDS.includes(node.label.trim().toLowerCase()));

    if (button) break;

    await sleep(600);
  }

  if (!button) {
    throw new Error("tombol 'Switch now' tidak muncul");
  }

  await tap(driver, button, log, "switch now");

  deadline = Date.now() + Math.max(10, Math.trunc(wait)) * 1000;

  while (Date.now() < deadline) {
    throwIfInterrupted();

    await dismissPopups(driver, 1);
    nodes = await readNodes(driver);

    if (isProfilePage(nodes) && profileEmail(nodes) === email) {
      return waitProfileLoaded(driver, nodes);
    }

    await sleep(1000);
  }

  // The app may have landed elsewhere; confirm through the profile page.
  nodes = await openProfilePage(driver, appPackage, log);

  if (profileEmail(nodes) !== email) {
    throw new Error(`setelah switch, akun aktif ${profileEmail(nodes) || "?"} bukan ${email}`);
  }

  return nodes;
}

// ============================================================
// Runner
// ============================================================

export interface RunAccountsOptions {
  accounts?: string[];
  count?: number;
  dwellMin?: number;
  dwellMax?: number;
  maxSwipes?: number;
  package?: string;
  wait?: number;
  restore?: boolean;
  skipFull?: boolean;
  dryRun?: boolean;
  log?: Log;
  onStart?: (index: number, total: number, name: string, email: string) => void;
  onArticle?: (article: AppArticle) => void;
  onAccount?: (run: AccountRun) => void;
  onPlan?: (session: AccountSession) => void;
  onReady?: (run: AccountRun) => void;
  onRewards?: (run: AccountRun) => void;
  checkin?: boolean;
  activities?: boolean;
  retries?: number;
  readRounds?: number;
  closeTabs?: boolean;
  onRetry?: (round: number, failed: number) => void;
  session?: AccountSession;
}

/**
 * Read the feed for every account, switching between them in-app.
 *
 * `accounts` is a list of emails (order kept); empty means every account the
 * app has, starting with the active one. Results go into `session` (created
 * when omitted) and its `runs` are returned.
 */
export async function runAccounts(driver: AppiumDriver, options: RunAccountsOptions = {}): Promise<AccountRun[]> {
  const {
    accounts = [],
    count = MOBILE_APP_NEWS_MAX,
    dwellMin = MOBILE_APP_DWELL_MIN,
    dwellMax = MOBILE_APP_DWELL_MAX,
    maxSwipes = MOBILE_APP_MAX_SWIPES,
    wait = MOBILE_APPIUM_WAIT,
    restore = true,
    skipFull = true,
    dryRun = false,
    log,
    onStart,
    onArticle,
    onAccount,
    onPlan,
    onReady,
    onRewards,
    checkin = true,
    activities = true,
    retries = 1,
    readRounds = 3,
    closeTabs = true,
    onRetry,
  } = options;

  const pkg = options.package;
  const session = options.session ?? new AccountSession();

  // System pop-ups (not responding, storage full…) closed on the way show up
  // in the account's log instead of silently stalling it.
  setDialogLog(log);

  const available = await listAccounts(driver, pkg, log);
  const original = available[0]?.[1] ?? "";
  const [targets, missing] = selectAccounts(available, accounts);

  session.original = original;
  session.planned = [...targets];
  session.missing = [...missing];
  const runs = session.runs;

  for (const email of missing) {
    say(log, `akun ${email} tidak ada di aplikasi · dilewati`);
  }

  onPlan?.(session);

  // Leftover tabs from earlier runs slow the first accounts down too.
  if (closeTabs && targets.length) {
    const closed = await closeAllTabs(driver, log);

    if (closed) {
      say(log, `${closed} tab lama ditutup`);
    }
  }

  try {
    for (let roundNo = 1; roundNo <= Math.max(0, Math.trunc(retries)) + 1; roundNo += 1) {
      let batch: Array<[string, string]>;

      if (roundNo === 1) {
        batch = [...targets];
      } else {
        // Accounts that failed or stopped halfway: usually a slow WebView or a
        // laggy phone, not the account itself. They get another go after the
        // last account, on a freshly started app.
        batch = runs.filter((run) => run.outcome === "error" || run.outcome === "partial").map((run) => [run.name, run.email]);

        if (!batch.length) break;

        onRetry?.(roundNo - 1, batch.length);

        await restartApp(driver, pkg);
      }

      for (const [offset, [name, email]] of batch.entries()) {
        const index = offset + 1;
        const run = new AccountRun(email, { name, target: Math.max(0, Math.trunc(count)), attempt: roundNo });
        let previous: AccountRun | undefined;

        if (roundNo === 1) {
          runs.push(run);
        } else {
          const slot = runs.findIndex((item) => item.email === email);
          previous = runs[slot];
          run.previousProblem = previous?.problem ?? "";
          runs[slot] = run;
        }

        const started = Date.now();

        onStart?.(index, batch.length, name, email);

        try {
          let nodes = await switchAccount(driver, email, pkg, log, wait);
          run.before = readProfileStats(nodes);

          // 1. Rewards page: daily check-in, then More activities. Done even
          //    when the daily cap is reached, so the check-in streak never breaks.
          if (checkin || activities) {
            run.rewards = await runRewards(driver, nodes, { checkin, activities, log });
            onRewards?.(run);
          }

          // 2. Read to Earn, only as many articles as still pay.
          const [earned, cap] = dailyPoints(run.before);
          const needed = run.rewards?.articlesNeeded;
          let toRead = needed === undefined ? count : Math.min(count, needed);

          if (skipFull && earned !== undefined && cap && earned >= cap) {
            run.skipped = `daily points sudah penuh (${earned}/${cap})`;
            run.target = 0;
          } else if (count <= 0) {
            // Reading turned off (--no-read): not a skip.
            run.readOff = true;
            run.target = 0;
          } else if (toRead <= 0) {
            const rw = run.rewards;
            run.skipped = `read to earn sudah ${rw?.readEarned}/${rw?.readCap}`;
            run.target = 0;
          } else {
            run.target = toRead;
            onReady?.(run);
          }

          await returnHome(driver);

          if (run.rewards) {
            run.readStart = run.rewards.readEarned;
            run.readEnd = run.rewards.readEarned;
            run.readCap = run.rewards.readCap;
          }

          if (!run.skipped && !run.readOff) {
            // Balance just before reading: the Rewards page's Read to earn
            // counter can lag for minutes, while the balance moves at once
            // (3 points per article).
            let balanceBeforeRead: number | undefined;

            if (run.readCap !== undefined) {
              balanceBeforeRead = run.readBalanceStart = parsePoints(
                readProfileStats(await openProfilePage(driver, pkg, log))["total"],
              );
              await returnHome(driver);
            }

            // Keep reading until Read to earn shows its cap (30/30). Not every
            // article is credited, so the counter is read again after each round.
            for (;;) {
              const roundResult = await readAppFeed(driver, {
                count: toRead,
                dwellMin,
                dwellMax,
                maxSwipes,
                package: pkg,
                wait,
                dryRun,
                log,
                onArticle,
                skipTitles: readTitles(run, previous),
              });

              run.news = mergeNews(run.news, roundResult);

              if (dryRun || run.readCap === undefined) break;

              // Credit shows up a moment after the last article; the balance on
              // the profile page lags a little too.
              await sleep(6000);

              const profile = await openProfilePage(driver, pkg, log);
              run.after = readProfileStats(profile);

              let [earnedNow, capNow] = await checkReadProgress(
                driver,
                profile,
                roundResult.read ? run.readEnd : undefined,
                log,
              );

              const balanceNow = parsePoints(run.after["total"]);

              if (
                balanceBeforeRead !== undefined &&
                balanceNow !== undefined &&
                run.readStart !== undefined &&
                capNow
              ) {
                const estimate = Math.min(capNow, run.readStart + Math.max(0, balanceNow - balanceBeforeRead));

                // The balance also moves for check-in and More activities
                // credited late, so it can claim 30/30 while the card says
                // 27/30. Only fall back to it when the card is unreadable;
                // otherwise one more round runs (an extra article costs time,
                // not points).
                if (earnedNow === undefined) {
                  earnedNow = estimate;
                } else if (estimate > earnedNow) {
                  say(log, `saldo naik tapi read to earn baru ${earnedNow}/${capNow} · baca lagi`);
                }
              }

              if (earnedNow === undefined) break;

              run.readEnd = earnedNow;
              run.readCap = capNow;
              const left = Math.ceil(Math.max(0, (capNow ?? 0) - earnedNow) / POINTS_PER_ARTICLE);

              if (left <= 0) break;

              if (run.dailyCapped) {
                say(log, "daily points penuh · read to earn tidak bertambah lagi");
                break;
              }

              if (run.readRound >= Math.max(1, Math.trunc(readRounds))) break;

              // Feed gave nothing readable; another round would fail the same way.
              if (roundResult.read === 0) break;

              run.readRound += 1;
              toRead = Math.min(count, left);
              run.target += toRead;

              onReady?.(run);

              await returnHome(driver);
            }
          }

          // 3. Close the tabs the articles and activities opened; dozens of
          //    open tabs make the app slow.
          if (closeTabs) {
            run.tabsClosed = await closeAllTabs(driver, log);
          }

          nodes = await openProfilePage(driver, pkg, log);
          run.after = readProfileStats(nodes);

          // Final word on Read to earn: by now the balance has caught up,
          // while the Rewards page counter may not.
          settleReadProgress(run);
        } catch (error) {
          if (error instanceof InterruptedError) {
            run.interrupted = true;
            run.duration = (Date.now() - started) / 1000;
            throw error;
          }

          // The next account still runs.
          run.error = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;

          // Start the next account from a fresh app, so one stuck screen does
          // not fail every account after it.
          try {
            await restartApp(driver, pkg);
          } catch {
            // Ignore.
          }
        }

        run.duration = (Date.now() - started) / 1000;

        if (previous) {
          // Points are counted from the first visit of the day, and the
          // articles of the first attempt still count.
          if (Object.keys(previous.before).length) {
            run.before = previous.before;
          }
          if (previous.readStart !== undefined) {
            run.readStart = previous.readStart;
          }
          if (previous.readBalanceStart !== undefined) {
            run.readBalanceStart = previous.readBalanceStart;
            settleReadProgress(run);
          }
          if (previous.news) {
            const merged = mergeNews(undefined, previous.news);
            run.news = run.news ? mergeNews(merged, run.news) : merged;
            run.target += previous.target;
          }
          run.duration += previous.duration;
        }

        onAccount?.(run);

        if (index < batch.length) {
          await sleep((3 + Math.random() * 4) * 1000);
        }
      }
    }
  } finally {
    if (restore && original && runs.length) {
      try {
        say(log, `kembali ke akun awal · ${original}`);
        await switchAccount(driver, original, pkg, log, wait);
        await returnHome(driver);
      } catch (error) {
        say(log, `gagal kembali ke ${original}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  return runs;
}
