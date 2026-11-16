/**
 * Run Bing Rewards tasks in a second tab next to the search session.
 *
 * Requested flow (dashboard first, then earn):
 * 1. Claim 3 Daily set tasks.
 * 2. Claim "Ready to claim" points.
 * 3. Complete photo/visual search task.
 * 4. Handle "Your perks" if present.
 * 5. On /earn, complete all unchecked "Keep earning" tasks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { error, type WebDriver } from "selenium-webdriver";

import {
  REWARDS_EARN_URL,
  REWARDS_ENABLED,
  REWARDS_PHOTO_DIR,
  REWARDS_PHOTO_MAX_ATTEMPTS,
  REWARDS_TASK_TIMEOUT,
  REWARDS_URL,
} from "../config/settings";
import { sleep } from "../utils/delay";
import { rewardNote } from "../utils/ui";
import * as page from "./page";
import type { Card } from "./page";
import { collectPhotos, shuffle } from "./photos";

export const NAV_TITLES = new Set([
  "home", "beranda", "rewards", "redeem", "tukar",
  "sign in", "masuk", "profile", "profil", "settings", "pengaturan",
  "help", "bantuan", "privacy", "privasi", "terms", "ketentuan",
  "feedback", "masukan", "about", "tentang",
]);

export const PHOTO_WORDS = [
  "visual search",
  "photo",
  "foto",
  "gambar",
  "search with an image",
  "search using an image",
  "image search",
  "upload an image",
] as const;

export const QUIZ_URL_WORDS = [
  "quiz", "poll", "challenge", "prediction", "voting", "survei", "survey",
] as const;

export const PRERENDER_URL_WORDS = [
  "ntp.msn.com/edge/ntp",
  "prerender=1",
] as const;

/** Python's `except WebDriverException`. */
function isWebDriverError(e: unknown): boolean {
  return e instanceof error.WebDriverError;
}

/** Python's `type(e).__name__`. */
function errorName(e: unknown): string {
  if (e instanceof Error) return e.name || e.constructor.name;
  return typeof e;
}

/** Python's `str(e)`. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Python's `random.uniform(a, b)` in seconds. */
function uniform(min: number, max: number): number {
  return min + (max - min) * Math.random();
}

/** Python's `str.strip("/")`. */
function stripSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

/** Outcome and stats of the rewards part of one profile. */
export class RewardResult {
  enabled = true;
  opened = false;
  signedOut = false;
  error?: string = undefined;

  // account (fetched from web)
  accountName = "";
  accountEmail = "";

  // points
  pointsStart?: number = undefined;
  pointsEnd?: number = undefined;

  // ready-to-claim
  readyToClaimStart = 0;
  claims = 0;
  claimPoints = 0;
  /** True once the dashboard was checked for ready-to-claim points. */
  claimChecked = false;
  /** Points still shown as ready after the last check (not clickable). */
  claimLeft = 0;

  // daily set
  dailyTotal = 0;
  dailyDone = 0;
  dailyPoints = 0;

  // photo / visual search
  photoAvailable = false;
  photoFound = false;
  photoAttempts = 0;
  photoCompleted = false;
  photoPoints = 0;

  // perks
  perksFound = false;
  perksTotal = 0;
  perksDone = 0;

  // keep earning (/earn)
  earnTotal = 0;
  earnDone = 0;
  earnPoints = 0;

  // generic task counter (back-compat for old UI fields)
  tasks = 0;
  notes: string[] = [];

  constructor(init: Partial<RewardResult> = {}) {
    Object.assign(this, init);
  }

  get pointsEarned(): number {
    if (this.pointsStart === undefined || this.pointsEnd === undefined) {
      // fall back to known claimed points if balance unreadable
      return Math.max(0, this.claimPoints + this.dailyPoints + this.photoPoints + this.earnPoints);
    }
    return Math.max(0, this.pointsEnd - this.pointsStart);
  }

  get summary(): string {
    const parts: string[] = [];

    if (this.dailyTotal || this.dailyDone) {
      parts.push(`daily ${this.dailyDone}/${this.dailyTotal}`);
    }
    if (this.claims || this.claimPoints) {
      parts.push(`klaim ${this.claims} (+${this.claimPoints})`);
    }
    if (this.photoFound || this.photoCompleted) {
      parts.push(this.photoCompleted ? "foto ✓" : "foto ✗");
    }
    if (this.perksFound) {
      parts.push(`perks ${this.perksDone}/${this.perksTotal}`);
    }
    if (this.earnTotal || this.earnDone) {
      parts.push(`earn ${this.earnDone}/${this.earnTotal}`);
    }
    if (this.pointsEarned) {
      parts.push(`+${this.pointsEarned} poin`);
    }
    if (this.signedOut) {
      parts.push("belum login");
    }
    if (this.error && !parts.length) {
      parts.push("error");
    }

    return parts.length ? parts.join("  ·  ") : "tidak ada tugas";
  }
}

/** Python's `x or None` for page.read_points(), which returns int | None. */
function orUndefined(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

/** Two-tab rewards helper bound to one Selenium driver. */
export class RewardsRunner {
  readonly driver: WebDriver;
  readonly result: RewardResult;
  private readonly onStatus?: (markup: string) => void;

  searchHandle: string;
  rewardHandle: string | null = null;
  private readonly ignoredHandles = new Set<string>();

  private lastClaimCheck = 0.0;
  private lastRefresh = 0.0;

  /**
   * Prefer `await RewardsRunner.create(driver, result, onStatus)`.
   *
   * Python reads `driver.current_window_handle` in `__init__`; in JS that is
   * async, so the constructor takes the search handle explicitly.
   */
  constructor(
    driver: WebDriver,
    result: RewardResult,
    searchHandle: string,
    onStatus?: (markup: string) => void,
  ) {
    this.driver = driver;
    this.result = result;
    this.onStatus = onStatus;

    this.searchHandle = searchHandle;
  }

  /** Bind to the driver, using its current tab as the search tab. */
  static async create(
    driver: WebDriver,
    result: RewardResult,
    onStatus?: (markup: string) => void,
  ): Promise<RewardsRunner> {
    const handle = await driver.getWindowHandle();
    return new RewardsRunner(driver, result, handle, onStatus);
  }

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  async focusSearch(): Promise<boolean> {
    const handles = await this.handles();

    if (handles.includes(this.searchHandle)) {
      await this.switch(this.searchHandle);
      return true;
    }

    if (handles.length) {
      this.searchHandle = handles[0]!;
      await this.switch(this.searchHandle);
      return true;
    }

    return false;
  }

  async open(): Promise<boolean> {
    if (!REWARDS_ENABLED) {
      this.result.enabled = false;
      return false;
    }

    try {
      await this.newRewardTab();
      this.result.opened = true;
      return true;
    } catch (e) {
      this.fail("membuka dashboard", e);
      return false;
    }
  }

  /** Full rewards pass in requested order. */
  async prepare(): Promise<void> {
    if (!REWARDS_ENABLED) {
      this.result.enabled = false;
      return;
    }

    if (!(await this.open())) {
      return;
    }

    try {
      await this.dismiss();
      await this.readAccount();
      this.result.pointsStart = orUndefined(await page.readPoints(this.driver));
      this.result.readyToClaimStart = (await page.readClaimable(this.driver)) || 0;

      if (await page.needsLogin(this.driver)) {
        this.result.signedOut = true;
        this.say("belum login · reward dilewati");
        return;
      }

      // Flow (before the searches). Each step is isolated so one
      // failing task never skips the others.
      const steps: [string, () => Promise<unknown>][] = [
        ["daily set", () => this.doDailySet()], // 1) daily set
        ["task foto", () => this.photo()], // 2) photo, skipped if none
        ["your perks", () => this.doPerks()], // 3) perks
        ["keep earning", () => this.earn()], // 4) /earn tasks
      ];
      for (const [name, step] of steps) {
        try {
          await step();
        } catch (e) {
          this.fail(name, e);
        }
      }
      // 5) searches run in the search tab (SearchEngine)
      // 6) "Ready to claim" points are claimed at the end -> finish()
    } catch (e) {
      this.fail("menjalankan reward", e);
    } finally {
      await this.closeTaskTabs();
    }
  }

  /**
   * Close every tab except the search tab to free memory.
   *
   * The rewards tab is closed too; finish() opens a fresh one for the
   * final claim.
   */
  private async closeTaskTabs(): Promise<void> {
    await this.closeExtras();

    if (this.rewardHandle) {
      await page.closeTab(this.driver, this.rewardHandle);
      this.rewardHandle = null;
    }

    await this.focusSearch();
    this.say("tugas selesai · tab reward ditutup");
  }

  /**
   * Called while searches run.
   *
   * Points are claimed only after all searches are done (finish), so
   * the search tab is never interrupted.
   */
  async tick(): Promise<void> {
    return;
  }

  /** After the searches: claim ready points and read the balance. */
  async finish(): Promise<void> {
    if (!this.result.opened || this.result.signedOut) {
      return;
    }

    try {
      await this.ensureRewardTab();
      this.setStatus("[dim]reward · klaim poin[/dim]");
      await this.doClaimReady("setelah search");
      await this.reloadDashboard();
      this.result.pointsEnd = orUndefined(await page.readPoints(this.driver));
    } catch (e) {
      this.fail("klaim poin", e);
    } finally {
      await this.focusSearch();
      await this.closeExtras();

      if (this.rewardHandle) {
        await page.closeTab(this.driver, this.rewardHandle);
        this.rewardHandle = null;
      }

      await this.focusSearch();
    }
  }

  // --------------------------------------------------------
  // Account
  // --------------------------------------------------------

  private async readAccount(): Promise<void> {
    try {
      const acct = await page.readAccount(this.driver);
      this.result.accountName = (acct.name || "").trim();
      this.result.accountEmail = (acct.email || "").trim();
      const label = this.result.accountEmail || this.result.accountName;
      if (label) {
        this.say(`akun · ${label}`);
      }
    } catch {
      // ignore
    }
  }

  // --------------------------------------------------------
  // Tabs / navigation
  // --------------------------------------------------------

  private async handles(): Promise<string[]> {
    try {
      return [...(await this.driver.getAllWindowHandles())];
    } catch (e) {
      if (!isWebDriverError(e)) throw e;
      return [];
    }
  }

  private async switch(handle: string | null): Promise<boolean> {
    try {
      await this.driver.switchTo().window(handle as string);
      return true;
    } catch (e) {
      if (!isWebDriverError(e)) throw e;
      return false;
    }
  }

  private async newRewardTab(): Promise<void> {
    await this.focusSearch();
    await this.driver.switchTo().newWindow("tab");
    this.rewardHandle = await this.driver.getWindowHandle();
    await this.driver.get(REWARDS_URL);
    await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
    await sleep(2000);
  }

  private async ensureRewardTab(reload = false): Promise<boolean> {
    const handles = await this.handles();
    if (this.rewardHandle === null || !handles.includes(this.rewardHandle)) {
      await this.newRewardTab();
    } else {
      await this.switch(this.rewardHandle);
    }
    if (reload) {
      await this.reloadDashboard();
    }
    return true;
  }

  /** Load the dashboard, retrying Bing's temporary error page. */
  private async reloadDashboard(): Promise<boolean> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt) {
        // Bing serves "It's not you, it's us" when it is hit too
        // quickly; back off before trying again.
        await sleep(3000 * attempt);
      }

      await this.driver.get(REWARDS_URL);
      await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
      await sleep(2000);

      if (!(await page.isErrorPage(this.driver))) {
        break;
      }
    }

    await this.dismiss();
    return !(await page.isErrorPage(this.driver));
  }

  private async ensureList(target: "dashboard" | "earn", force = false): Promise<void> {
    await this.ensureRewardTab();
    if (!force && (await this.onList(target))) {
      return;
    }
    if (target === "dashboard") {
      await this.reloadDashboard();
      return;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) {
        await sleep(3000 * attempt);
      }
      await this.driver.get(REWARDS_EARN_URL);
      await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
      await sleep(2000);
      if (!(await page.isErrorPage(this.driver))) {
        break;
      }
    }
    await this.dismiss();
  }

  private async onList(target: "dashboard" | "earn"): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(await page.currentUrl(this.driver));
    } catch {
      return false;
    }
    if (!parsed.host.toLowerCase().includes("rewards.bing.com")) {
      return false;
    }
    const pathname = stripSlashes(parsed.pathname).toLowerCase();
    if (target === "earn") {
      return pathname.startsWith("earn");
    }
    return ["", "dashboard", "index.html", "home"].includes(pathname);
  }

  private async closeExtras(): Promise<void> {
    const keep = new Set(
      [this.searchHandle, this.rewardHandle].filter((h): h is string => Boolean(h)),
    );
    for (const handle of await this.handles()) {
      if (keep.has(handle) || this.ignoredHandles.has(handle)) {
        continue;
      }
      if (!(await this.switch(handle))) {
        continue;
      }
      if (await this.isPrerender()) {
        this.ignoredHandles.add(handle);
        continue;
      }
      try {
        await this.driver.close();
      } catch (e) {
        if (!isWebDriverError(e)) throw e;
        this.ignoredHandles.add(handle);
      }
    }

    if (this.rewardHandle && (await this.handles()).includes(this.rewardHandle)) {
      await this.switch(this.rewardHandle);
    } else {
      await this.focusSearch();
    }
  }

  private async isPrerender(): Promise<boolean> {
    const url = (await page.currentUrl(this.driver)).toLowerCase();
    return PRERENDER_URL_WORDS.some((word) => url.includes(word));
  }

  private async openedHandles(before: Set<string>): Promise<string[]> {
    let previous: string | null = null;
    try {
      previous = await this.driver.getWindowHandle();
    } catch (e) {
      if (!isWebDriverError(e)) throw e;
      previous = null;
    }

    const found: string[] = [];
    for (const handle of await this.handles()) {
      if (before.has(handle) || this.ignoredHandles.has(handle)) {
        continue;
      }
      if (!(await this.switch(handle))) {
        continue;
      }
      if (await this.isPrerender()) {
        this.ignoredHandles.add(handle);
        continue;
      }
      found.push(handle);
    }

    if (previous && (await this.handles()).includes(previous)) {
      await this.switch(previous);
    }
    return found;
  }

  // --------------------------------------------------------
  // Claims
  // --------------------------------------------------------

  /** Claim all ready-to-claim points, including dialogs/pages. */
  private async doClaimReady(label = ""): Promise<boolean> {
    void label;

    await this.ensureList("dashboard", true);

    // The React dashboard renders the claim card a moment after load.
    const readyStart = await page.waitClaimable(this.driver, 12);
    if (readyStart !== null) {
      this.result.readyToClaimStart = Math.max(
        this.result.readyToClaimStart,
        readyStart,
      );
    }

    const pointsBefore = await page.readPoints(this.driver);
    let claimed = 0;
    let confirms = 0;
    let baseline = readyStart;
    let stalled = 0;

    for (let i = 0; i < 10; i += 1) {
      const before = new Set(await this.handles());
      const clicked = await page.clickClaim(this.driver);

      if (!clicked) {
        // Nothing clickable in the claim box. Keep the page so
        // the selectors can be fixed from real markup (but not
        // Bing's temporary error page, which has no markup).
        if (readyStart && !(await page.isErrorPage(this.driver))) {
          const file = await this.dumpClaimDebug();

          if (file) {
            this.say(`klaim tidak ketemu · html disimpan ${file}`);
          }
        }
        break;
      }

      claimed += 1;
      this.say(`klaim · ${clicked}`);

      await sleep(1500);

      // A claim may open a new tab, a dialog, or a claim page.
      const opened = await this.openedHandles(before);

      if (opened.length) {
        await this.switch(opened[opened.length - 1]!);
        await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
      }

      // The card opens a "Claim points" side panel; it slides in,
      // so keep looking for its button for a while.
      let confirmed = "";

      for (let j = 0; j < 10; j += 1) {
        confirmed = await page.confirmClaim(this.driver);

        if (confirmed) {
          confirms += 1;
          this.say(`konfirmasi klaim · ${confirmed}`);
          // Let the claim request finish before anything else.
          await sleep(3000);
          break;
        }

        await sleep(1000);
      }

      if (!confirmed) {
        const file = await this.dumpClaimDebug();
        this.say(
          "tombol 'Claim points' tidak ketemu" +
            (file ? ` · html disimpan ${file}` : ""),
        );
      }

      await this.closeExtras();

      // The React dashboard updates the counter in place once the
      // claim request finishes. Wait for that before reloading, so
      // the request is not cut off by a navigation.
      let readyAfter: number | null = null;
      if ((await this.onList("dashboard")) && !opened.length) {
        readyAfter = await page.waitClaimableDrop(this.driver, baseline, 10);
      }

      if (readyAfter === null) {
        // Return to the dashboard and check the counter there.
        await this.reloadDashboard();
        readyAfter = await page.readClaimable(this.driver);
      }

      if (readyAfter === 0) {
        break;
      }

      if (readyAfter === null) {
        stalled += 1;
        if (stalled >= 2) {
          break;
        }
        continue;
      }

      if (baseline !== null && readyAfter >= baseline) {
        // Nothing changed after a full click/confirm cycle.
        break;
      }

      baseline = readyAfter;
    }

    await this.reloadDashboard();
    const pointsAfter = await page.readPoints(this.driver);

    let gained: number;
    if (pointsBefore !== null && pointsAfter !== null) {
      gained = Math.max(0, pointsAfter - pointsBefore);
    } else {
      gained = 0;
    }

    // A claim only counts when the "Ready to claim" counter dropped.
    const left = (await page.waitClaimable(this.driver, 5)) || 0;
    const moved = Math.max(0, (readyStart || 0) - left);

    this.result.claimChecked = true;
    this.result.claimLeft = left;

    if (confirms && moved) {
      this.result.claims += confirms;
      this.result.claimPoints += moved;
      this.say(
        `klaim berhasil · +${moved} poin` +
          (left ? ` · ${left} poin masih tertunda` : "") +
          (gained ? ` · saldo +${gained}` : ""),
      );
      return true;
    }

    if (readyStart) {
      let why: string;
      if (!claimed) {
        why = "kartu 'Ready to claim' tidak bisa diklik";
      } else if (!confirms) {
        why = "tombol 'Claim points' tidak ketemu";
      } else {
        why = "sudah diklik tapi poin masih tertunda";
      }
      this.say(`klaim gagal · ${readyStart} poin · ${why}`);
    } else if (!claimed) {
      this.say("klaim · tidak ada poin siap diklaim");
    }

    return false;
  }

  private async claimQuiet(): Promise<boolean> {
    if (!(await this.onList("dashboard")) || (await page.isErrorPage(this.driver))) {
      await this.reloadDashboard();
    }

    const before = new Set(await this.handles());
    const ready = (await page.readClaimable(this.driver)) || 0;
    const pointsBefore = await page.readPoints(this.driver);
    const clicked = await page.clickClaim(this.driver);

    if (!clicked) {
      return false;
    }

    this.result.claims += 1;
    await sleep(1200);

    const opened = await this.openedHandles(before);

    if (opened.length) {
      await this.switch(opened[opened.length - 1]!);
      await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
    }

    for (let i = 0; i < 4; i += 1) {
      if (!(await page.confirmClaim(this.driver))) {
        break;
      }

      await sleep(1000);
    }

    await this.closeExtras();

    if ((await this.onList("dashboard")) && !opened.length) {
      await page.waitClaimableDrop(this.driver, ready || null, 8);
    }

    const bal = await page.readPoints(this.driver);

    if (bal !== null) {
      this.result.pointsEnd = bal;
    }

    let gained: number;
    if (pointsBefore !== null && bal !== null) {
      gained = Math.max(0, bal - pointsBefore);
    } else {
      gained = 0;
    }

    if (gained) {
      this.result.claimPoints = Math.max(this.result.claimPoints, gained);
    } else if (ready) {
      this.result.claimPoints = Math.max(this.result.claimPoints, ready);
    }

    return true;
  }

  /** Save the current page so claim selectors can be fixed. */
  private async dumpClaimDebug(): Promise<string> {
    let html: unknown;
    try {
      html = await this.driver.executeScript(
        "return document.documentElement.outerHTML",
      );
    } catch {
      return "";
    }

    try {
      const file = path.join(os.tmpdir(), "edgepy_claim_debug.html");

      fs.writeFileSync(file, typeof html === "string" ? html : "", { encoding: "utf8" });

      return file;
    } catch {
      return "";
    }
  }

  // --------------------------------------------------------
  // Daily set
  // --------------------------------------------------------

  /**
   * Open each daily card itself, then verify it is checked.
   *
   * Daily tasks are usually search cards. Loading the card's own href
   * (or clicking the card when it has no href) is what the rewards
   * dashboard expects; typing a separate search does not count.
   */
  private async doDailySet(): Promise<void> {
    await this.ensureList("dashboard", true);
    this.setStatus("[dim]reward · daily set[/dim]");

    const attempts = new Map<string, number>();

    for (let i = 0; i < 12; i += 1) {
      const cards = await page.scanCards(this.driver);
      const daily = cards.filter(
        (c) => c.group === "daily" && !this.isPhoto(c),
      );

      if (!daily.length) {
        break;
      }

      this.result.dailyTotal = Math.max(this.result.dailyTotal, daily.length);

      const pending = daily.filter(
        (c) =>
          !c.completed &&
          this.actionable(c) &&
          (attempts.get(RewardsRunner.cardKey(c)) ?? 0) < 2,
      );

      if (!pending.length) {
        break;
      }

      const card = pending[0]!;
      const key = RewardsRunner.cardKey(card);
      attempts.set(key, (attempts.get(key) ?? 0) + 1);

      const title = (card.title || card.label || "daily")
        .split("\n")[0]!
        .slice(0, 60);
      const points = card.points || 0;
      this.say(
        `daily set · ${title}` + (points ? ` · ${points} poin` : ""),
      );

      const beforePts = await page.readPoints(this.driver);
      const pendingBefore = daily.filter((c) => !c.completed).length;

      await this.openCard(card, [12, 16], true);
      await this.closeExtras();
      await this.ensureList("dashboard", true);

      let completed = false;

      for (let check = 0; check < 3; check += 1) {
        const cardsAfter = await page.scanCards(this.driver);
        const dailyAfter = cardsAfter.filter(
          (c) => c.group === "daily" && !this.isPhoto(c),
        );
        const pendingAfter = dailyAfter.filter((c) => !c.completed).length;
        const after = await this.cardState("daily", card, cardsAfter);

        if (after && after.completed) {
          completed = true;
          break;
        }

        if (pendingAfter < pendingBefore) {
          completed = true;
          break;
        }

        if (check < 2) {
          await sleep(3000);
          await this.ensureList("dashboard", true);
        }
      }

      if (completed) {
        this.result.dailyDone += 1;
        this.result.tasks += 1;
        const gained = await this.pointsDelta(beforePts);
        this.result.dailyPoints += gained ? gained : points;
        this.say(`daily set tercentang · ${title}`);
      } else if ((attempts.get(key) ?? 0) >= 2) {
        this.say(`daily set belum tercentang · ${title}`);
      }

      await sleep(1000);
    }

    // Final counts: individual cards plus the "Daily set" summary.
    await this.ensureList("dashboard", true);
    const cards = await page.scanCards(this.driver);
    const daily = cards.filter(
      (c) => c.group === "daily" && !this.isPhoto(c),
    );

    const [done, total] = await this.dailyCategoryProgress(cards);

    if (total) {
      this.result.dailyTotal = Math.max(this.result.dailyTotal, total);
      this.result.dailyDone = done;
    } else if (daily.length) {
      this.result.dailyTotal = Math.max(
        this.result.dailyTotal,
        daily.length,
      );
      this.result.dailyDone = daily.filter((c) => c.completed).length;
    }

    if (this.result.dailyTotal) {
      this.say(
        `daily set · ${this.result.dailyDone}/` +
          `${this.result.dailyTotal} tercentang`,
      );
    }
  }

  // --------------------------------------------------------
  // Keep earning (/earn)
  // --------------------------------------------------------

  private async earn(): Promise<void> {
    await this.ensureList("earn", true);
    this.setStatus("[dim]reward · keep earning[/dim]");

    const attempts = new Map<string, number>();

    for (let i = 0; i < 30; i += 1) {
      await this.ensureList("earn");
      const cards = await page.scanCards(this.driver);
      const earn = cards.filter(
        (c) => c.group === "earn" && !this.isPhoto(c),
      );

      if (!earn.length) {
        break;
      }

      this.result.earnTotal = Math.max(this.result.earnTotal, earn.length);

      const pending = earn.filter(
        (c) =>
          !c.completed &&
          this.actionable(c) &&
          (attempts.get(RewardsRunner.cardKey(c)) ?? 0) < 2,
      );

      if (!pending.length) {
        break;
      }

      const card = pending[0]!;
      const key = RewardsRunner.cardKey(card);
      attempts.set(key, (attempts.get(key) ?? 0) + 1);

      const title = (card.title || "earn").split("\n")[0]!.slice(0, 60);
      const points = card.points || 0;
      this.say(
        `keep earning · ${title}` + (points ? ` · ${points} poin` : ""),
      );

      const beforePts = await page.readPoints(this.driver);
      const pendingBefore = earn.filter((c) => !c.completed).length;

      await this.openCard(card, [10, 14], true);
      await this.closeExtras();
      await this.ensureList("earn", true);

      let completed = false;

      for (let check = 0; check < 3; check += 1) {
        const cardsAfter = await page.scanCards(this.driver);
        const earnAfter = cardsAfter.filter(
          (c) => c.group === "earn" && !this.isPhoto(c),
        );
        const pendingAfter = earnAfter.filter((c) => !c.completed).length;
        const after = await this.cardState("earn", card, cardsAfter);

        if (after && after.completed) {
          completed = true;
          break;
        }

        if (pendingAfter < pendingBefore) {
          completed = true;
          break;
        }

        if (check < 2) {
          await sleep(3000);
          await this.ensureList("earn", true);
        }
      }

      if (completed) {
        this.result.earnDone += 1;
        this.result.tasks += 1;
        const gained = await this.pointsDelta(beforePts);
        this.result.earnPoints += gained ? gained : points;
      } else if ((attempts.get(key) ?? 0) >= 2) {
        this.say(`keep earning belum tercentang · ${title}`);
      }

      await sleep(800);
    }

    await this.ensureList("earn", true);
    const cards = await page.scanCards(this.driver);
    const earn = cards.filter(
      (c) => c.group === "earn" && !this.isPhoto(c),
    );

    if (earn.length) {
      this.result.earnTotal = Math.max(
        this.result.earnTotal,
        earn.length,
      );
      this.result.earnDone = earn.filter((c) => c.completed).length;
    }

    await this.ensureList("dashboard", true);
  }

  // --------------------------------------------------------
  // Perks
  // --------------------------------------------------------

  private async doPerks(): Promise<void> {
    await this.ensureList("dashboard", true);
    this.setStatus("[dim]reward · perks[/dim]");
    let perks: page.PerksInfo;
    try {
      perks = await page.readPerks(this.driver);
    } catch {
      perks = { found: false, total: 0, items: [] };
    }

    if (!perks.found) {
      return;
    }

    const items = perks.items || [];
    this.result.perksFound = true;
    this.result.perksTotal = items.length;

    const actionable = items.filter((i) => !i.claimed);
    if (!actionable.length) {
      this.result.perksDone = items.length;
      this.say(`your perks · ${this.result.perksDone}/${this.result.perksTotal} sudah`);
      return;
    }

    this.say(`your perks · ${actionable.length} item`);
    let done = 0;
    for (const item of actionable.slice(0, 5)) {
      const text = (item.text || "").split("\n")[0]!.slice(0, 50);
      // try clicking the perk; many are just info/links
      const res = await page.clickByText(this.driver, text);
      if (res.ok) {
        await sleep(1500);
        await this.closeExtras();
        await this.ensureList("dashboard");
        done += 1;
      }
    }
    this.result.perksDone = done;
  }

  // --------------------------------------------------------
  // Helpers: cards/tasks
  // --------------------------------------------------------

  private pending(cards: Card[], groups?: Iterable<string> | null): Card[] {
    const wanted = groups ? new Set(groups) : null;
    const pending: Card[] = [];
    for (const card of cards) {
      if (wanted && wanted.size && !wanted.has(card.group)) {
        continue;
      }
      if (card.completed) {
        continue;
      }
      if (!this.actionable(card)) {
        continue;
      }
      pending.push(card);
    }
    return pending;
  }

  private actionable(card: Card): boolean {
    const title = (card.title || "").trim();
    const href = (card.href || "").trim();
    if (title.length < 3) {
      return false;
    }
    if (NAV_TITLES.has(title.toLowerCase())) {
      return false;
    }
    const group = card.group;
    if (["daily", "more", "earn", "category"].includes(group)) {
      return true;
    }
    const lowered = href.toLowerCase();
    return !href || lowered.includes("bing.com") || lowered.includes("rewards.bing.com");
  }

  /** Python returns a 4-tuple; a JSON string is the hashable equivalent. */
  private static cardKey(card: Card): string {
    return JSON.stringify([
      (card.group || "").trim().toLowerCase(),
      (card.label || "").trim().toLowerCase(),
      (card.title || "").trim().toLowerCase(),
      (card.href || "").trim().toLowerCase(),
    ]);
  }

  private static sameTask(first: Card, second: Card): boolean {
    for (const key of ["label", "title"] as const) {
      const a = (first[key] || "").trim().toLowerCase();
      const b = (second[key] || "").trim().toLowerCase();
      if (a && a === b) {
        return true;
      }
    }
    const ah = (first.href || "").trim().toLowerCase();
    const bh = (second.href || "").trim().toLowerCase();
    return Boolean(ah && ah === bh);
  }

  private async cardState(
    group: string,
    wanted: Card,
    cards?: Card[] | null,
  ): Promise<Card | null> {
    if (cards === undefined || cards === null) {
      try {
        cards = await page.scanCards(this.driver);
      } catch {
        return null;
      }
    }

    for (const card of cards) {
      if (card.group !== group) {
        continue;
      }
      if (RewardsRunner.sameTask(card, wanted)) {
        return card;
      }
    }

    return null;
  }

  /** Read the Daily set progress from its summary card, if shown. */
  private async dailyCategoryProgress(cards?: Card[] | null): Promise<[number, number]> {
    if (cards === undefined || cards === null) {
      cards = await page.scanCards(this.driver);
    }

    for (const card of cards) {
      if (card.group !== "category") {
        continue;
      }

      const name = `${card.label || ""} ${card.title || ""}`.toLowerCase();

      if (!name.includes("daily set") && !name.includes("set harian")) {
        continue;
      }

      const progress = card.progress || { done: 0, total: 0 };
      const total = progress.total || 0;
      const done = progress.done || 0;

      if (total) {
        return [done, total];
      }
    }

    return [0, 0];
  }

  private async pointsDelta(beforePts: number | null): Promise<number> {
    let after: number | null;
    try {
      after = await page.readPoints(this.driver);
    } catch {
      after = null;
    }
    if (after === null || beforePts === null) {
      return 0;
    }
    return Math.max(0, after - beforePts);
  }

  /**
   * Activate one rewards card the way a user would.
   *
   * A real Selenium click is tried first, because a trusted click
   * lets the card open its own new tab or dialog. If that does not
   * navigate anywhere, the card's href is loaded in a new tab as a
   * fallback. Button cards also follow their flyout action.
   *
   * `wait` is a [min, max] range in seconds.
   */
  private async openCard(
    card: Card,
    wait: [number, number] = [8, 12],
    preferHref = true,
  ): Promise<boolean> {
    await this.ensureRewardTab();

    const before = new Set(await this.handles());
    const beforeUrl = await page.currentUrl(this.driver);
    const href = (card.href || "").trim();
    let actionHref = "";
    let activated = false;

    // 1) Click the card itself.
    let result = await page.nativeClickCard(this.driver, card.index ?? -1);

    if (result.ok) {
      activated = true;
      await sleep(1200);

      const dialog = await page.readDialog(this.driver);

      if (dialog.open) {
        const action = await page.clickDialogAction(this.driver);

        if (action.ok) {
          actionHref = (action.href || "").trim();
          const label = card.label || card.title || "task";
          this.say(`aktivitas · ${label} · ${action.text ?? "None"}`);
          await sleep(1500);
        } else {
          await page.closeDialog(this.driver);
        }
      }
    }

    // 2) The click did nothing: use the card's own URL (or the
    //    flyout action's URL) in a new tab.
    let opened = await this.openedHandles(before);
    let moved = (await page.currentUrl(this.driver)) !== beforeUrl;

    // A new tab can take a moment to appear after a trusted click.
    if (!opened.length && !moved) {
      for (let i = 0; i < 4; i += 1) {
        await sleep(800);
        opened = await this.openedHandles(before);
        moved = (await page.currentUrl(this.driver)) !== beforeUrl;

        if (opened.length || moved) {
          break;
        }
      }
    }

    const targetHref = actionHref || href;

    if (
      !opened.length &&
      !moved &&
      preferHref &&
      targetHref &&
      !["javascript:", "#"].some((prefix) => targetHref.toLowerCase().startsWith(prefix))
    ) {
      try {
        await this.driver.switchTo().newWindow("tab");
        await this.driver.get(targetHref);
        activated = true;
      } catch {
        try {
          await this.switch(this.rewardHandle);
        } catch {
          // ignore
        }
      }
    }

    // 3) Last resort: JavaScript click on the card.
    if (!activated) {
      result = await page.clickCard(this.driver, card.index ?? -1, false);

      if (!result.ok) {
        this.say(
          "task tidak bisa dibuka · " +
            `${result.reason ?? "unknown"}`,
        );
        return false;
      }

      activated = true;
      await sleep(1200);

      const dialog = await page.readDialog(this.driver);

      if (dialog.open) {
        const action = await page.clickDialogAction(this.driver);

        if (action.ok) {
          await sleep(1500);
        } else {
          await page.closeDialog(this.driver);
        }
      }
    }

    opened = await this.openedHandles(before);

    if (opened.length) {
      await this.switch(opened[opened.length - 1]!);
    }

    await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
    await this.dismiss();
    await this.maybeAnswerQuiz();

    await sleep(uniform(...wait) * 1000);
    return true;
  }

  private async maybeAnswerQuiz(): Promise<void> {
    const url = (await page.currentUrl(this.driver)).toLowerCase();
    let looksLikeQuiz = QUIZ_URL_WORDS.some((word) => url.includes(word));
    if (!looksLikeQuiz) {
      try {
        looksLikeQuiz = Boolean(
          await this.driver.executeScript(
            "return !!document.querySelector('[class*=\"quiz\"],[class*=\"question\"],[data-testid*=\"quiz\"],[class*=\"poll\"]');",
          ),
        );
      } catch (e) {
        if (!isWebDriverError(e)) throw e;
        looksLikeQuiz = false;
      }
    }
    if (!looksLikeQuiz) {
      return;
    }
    // try answering a few steps
    for (let i = 0; i < 6; i += 1) {
      let res: page.QuizResult;
      try {
        res = (await page.answerQuiz(this.driver)) || {};
      } catch {
        break;
      }
      if (!(res.option || res.next)) {
        break;
      }
      await sleep(1200);
    }
  }

  // --------------------------------------------------------
  // Photo / visual search
  // --------------------------------------------------------

  private isPhoto(card: Card): boolean {
    const haystack = `${card.title || ""} ${card.label || ""} ${card.href || ""}`.toLowerCase();
    return PHOTO_WORDS.some((word) => haystack.includes(word));
  }

  private async photo(): Promise<void> {
    await this.ensureList("dashboard", true);
    this.setStatus("[dim]reward · task foto[/dim]");

    const photos = collectPhotos(REWARDS_PHOTO_DIR);
    this.result.photoAvailable = photos.length > 0;

    let [card, completed] = await this.findPhoto();
    if (completed && card === null) {
      this.result.photoCompleted = true;
      this.say("task foto sudah tercentang");
      return;
    }

    if (card === null) {
      // no visual search task visible
      this.say("task foto tidak ada · dilewati");
      return;
    }

    if (!photos.length) {
      this.say(`folder foto kosong · task foto dilewati (${REWARDS_PHOTO_DIR})`);
      this.result.photoFound = true;
      return;
    }

    this.result.photoFound = true;
    let index = 0;
    let attempt = 0;

    while (true) {
      attempt += 1;
      this.result.photoAttempts = attempt;
      if (index >= photos.length) {
        shuffle(photos);
        index = 0;
      }
      const photo = photos[index]!;
      index += 1;

      this.say(`task foto · percobaan ${attempt} · ${path.basename(photo)}`);
      this.setStatus(`[dim]reward · upload foto ${attempt}[/dim]`);

      const beforePts = await page.readPoints(this.driver);
      if (await this.photoAttempt(card, photo)) {
        this.result.photoCompleted = true;
        this.result.error = undefined;
        this.result.photoPoints = Math.max(this.result.photoPoints, await this.pointsDelta(beforePts));
        this.say(`task foto tercentang · ${attempt} percobaan`);
        this.result.tasks += 1;
        return;
      }

      const limit = REWARDS_PHOTO_MAX_ATTEMPTS;
      if (limit && attempt >= limit) {
        this.say(`task foto belum tercentang setelah ${attempt} percobaan`);
        return;
      }

      await sleep(uniform(2, 4) * 1000);
      [card, completed] = await this.findPhoto();
      if (card === null && completed) {
        this.result.photoCompleted = true;
        this.result.photoPoints = Math.max(this.result.photoPoints, await this.pointsDelta(beforePts));
        this.say(`task foto tercentang · ${attempt} percobaan`);
        this.result.tasks += 1;
        return;
      }
      if (card === null) {
        this.say("task foto hilang dari halaman · berhenti");
        return;
      }
    }
  }

  /** Return [pendingCard, alreadyCompleted]. */
  private async findPhoto(): Promise<[Card | null, boolean]> {
    await this.ensureRewardTab(true);
    let cards = await page.scanCards(this.driver);
    let pending = cards.filter((c) => this.isPhoto(c) && !c.completed && this.actionable(c));
    if (pending.length) {
      return [pending[0]!, false];
    }
    if (cards.some((c) => this.isPhoto(c) && c.completed)) {
      return [null, true];
    }

    // try /earn
    await this.driver.get(REWARDS_EARN_URL);
    await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
    await sleep(2000);
    await this.dismiss();
    cards = await page.scanCards(this.driver);
    pending = cards.filter((c) => this.isPhoto(c) && !c.completed && this.actionable(c));
    if (pending.length) {
      return [pending[0]!, false];
    }
    if (cards.some((c) => this.isPhoto(c) && c.completed)) {
      return [null, true];
    }
    return [null, false];
  }

  private async photoAttempt(card: Card, photo: string): Promise<boolean> {
    try {
      await this.ensureRewardTab();
      const before = new Set(await this.handles());

      if (card.group === "category") {
        const result = await page.clickCard(this.driver, card.index ?? -1, false);
        if (!result.ok) {
          return false;
        }
        await sleep(1200);
        const action = await page.clickDialogAction(this.driver);
        if (!action.ok) {
          await page.closeDialog(this.driver);
          this.say("dialog visual search tidak punya aksi");
          return false;
        }
        await sleep(1500);
      } else {
        const result = await page.clickCard(this.driver, card.index ?? -1, true);
        if (!result.ok) {
          return false;
        }
        await sleep(1500);
      }

      const opened = await this.openedHandles(before);
      if (opened.length) {
        await this.switch(opened[0]!);
      }

      await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
      await this.dismiss();

      const uploaded = await page.uploadPhoto(this.driver, photo);
      if (!uploaded) {
        this.say("upload tidak tersedia di halaman task");
      }

      await sleep(uniform(5, 7) * 1000);
      return await this.verifyPhoto(card);
    } catch (e) {
      this.fail("task foto", e);
      return false;
    } finally {
      await this.closeExtras();
    }
  }

  private async verifyPhoto(expected: Card): Promise<boolean> {
    await this.ensureRewardTab();
    await this.reloadDashboard();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const cards = await page.scanCards(this.driver);
      const photoCards = cards.filter((c) => this.isPhoto(c));
      const matched = photoCards.filter((c) => RewardsRunner.sameTask(c, expected));
      if (matched.some((c) => c.completed)) {
        return true;
      }
      if (!matched.length && photoCards.length === 1 && photoCards[0]!.completed) {
        return true;
      }
      await sleep(3000);
      if (attempt === 2) {
        await this.driver.get(REWARDS_EARN_URL);
        await page.waitReady(this.driver, REWARDS_TASK_TIMEOUT);
        await sleep(2000);
        await this.dismiss();
      } else {
        await this.reloadDashboard();
      }
    }
    return false;
  }

  // --------------------------------------------------------
  // Small utilities
  // --------------------------------------------------------

  private async dismiss(): Promise<void> {
    try {
      await page.dismissPrompts(this.driver);
    } catch {
      // ignore
    }
  }

  private say(message: string): void {
    this.result.notes.push(message);
    rewardNote(message);
  }

  private setStatus(markup: string): void {
    if (this.onStatus) {
      try {
        this.onStatus(markup);
      } catch {
        // ignore
      }
    }
  }

  private fail(step: string, err: unknown): void {
    this.result.error = `${step}: ${errorName(err)}: ${errorText(err)}`.trim();
    this.say(`gagal ${step} · ${errorName(err)}`);
  }
}
