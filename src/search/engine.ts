import { By, Key, until, type WebDriver } from "selenium-webdriver";

import { MAX_CONSECUTIVE_FAILURES, REWARDS_ENABLED, REWARDS_SEARCH_TOPUP_ROUNDS, SEARCH_URL } from "../config/settings";
import { RewardResult, RewardsRunner } from "../rewards";
import { humanTyping, sleep } from "../utils/delay";
import { INTERRUPTED, InterruptedError, throwIfInterrupted } from "../utils/interrupt";
import { loadKeywords } from "../utils/keywords";
import * as ui from "../utils/ui";

export const KEYWORDS = loadKeywords();

/** Seconds to wait after submitting a search before the next one (fixed, no extra pre-search delay). */
const WAIT_AFTER_SEARCH = 5;

export { INTERRUPTED };

/** One failed search attempt, shown in the profile recap. */
export interface SearchFailure {
  attempt: number;
  keyword: string;
  error: string;
}

export type Outcome = "ok" | "partial" | "stopped" | "error" | "interrupted";

/** Outcome of one profile's search run, used for the session recap. */
export class ProfileResult {
  searches = 0;
  stoppedEarly = false;
  error: string | undefined;
  /** Seconds. */
  duration = 0;
  failures: SearchFailure[] = [];
  reward: RewardResult | undefined;

  constructor(
    readonly profile: string,
    public target: number,
  ) {}

  get failedSearches(): number {
    return this.failures.length;
  }

  get isPerfect(): boolean {
    return this.outcome === "ok";
  }

  /** ok · partial · stopped · error · interrupted */
  get outcome(): Outcome {
    if (this.error === INTERRUPTED) return "interrupted";
    if (this.error) return "error";
    if (this.stoppedEarly) return "stopped";
    if (this.failures.length || this.searches < this.target) return "partial";
    return "ok";
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}`.trim() : String(error);
}

/**
 * Run searches for a single Edge profile.
 *
 * Progress is written into `result` as it happens, so the caller still has
 * partial numbers if this function throws.
 */
export async function runSearchesForProfile(
  driver: WebDriver,
  profileName: string,
  maxSearches = 30,
  result = new ProfileResult(profileName, maxSearches),
): Promise<ProfileResult> {
  let searchCount = 0;
  let usedKeywords: string[] = [];
  let consecutiveFailures = 0;
  let failureLimitReached = false;

  const status = new ui.Activity();

  const show = (activity: string, number?: number) => {
    // Default to the search about to run, never past the target (otherwise
    // the spinner reads "8/7" after the last search).
    const current = number ?? Math.min(searchCount + 1, maxSearches);

    // Counter first, lined up with the "✓  2/7   keyword" rows, so it stays
    // visible when a long keyword is cut off.
    const width = String(maxSearches).length;
    status.update(`[dim]${String(current).padStart(width)}/${maxSearches}[/dim]   ${activity}`);
  };

  status.start("[dim]membuka halaman pencarian[/dim]");

  try {
    await driver.get(SEARCH_URL);

    // ----------------------------------------------------
    // Bing Rewards, second tab
    // ----------------------------------------------------

    let rewards: RewardsRunner | undefined;

    if (REWARDS_ENABLED) {
      result.reward = new RewardResult();
      rewards = await RewardsRunner.create(driver, result.reward, (markup) => show(markup));

      show("[dim]membuka reward.bing.com…[/dim]");
      await rewards.prepare();
      throwIfInterrupted();

      // Only the searches that still pay: the Rewards page says how many PC
      // search points are left today (e.g. 45/90 -> 15).
      const needed = rewards.searchesLeft(maxSearches);
      const reward = result.reward;

      if (reward.searchTotal && needed <= 0) {
        ui.profileNote(`poin search sudah penuh (${reward.searchDone}/${reward.searchTotal}) · dilewati`);
      } else if (reward.searchTotal && needed !== maxSearches) {
        ui.profileNote(`poin search ${reward.searchDone}/${reward.searchTotal} · ${needed} pencarian lagi`);
      }

      maxSearches = needed;
      result.target = needed;

      show("[dim]memulai pencarian[/dim]");
    }

    let topups = 0;

    for (;;) {
    while (searchCount < maxSearches) {
      throwIfInterrupted();

      // ------------------------------------------------
      // Get unused keywords
      // ------------------------------------------------

      let availableKeywords = KEYWORDS.filter((keyword) => !usedKeywords.includes(keyword));

      // Reset keyword pool
      if (availableKeywords.length === 0) {
        usedKeywords = [];
        availableKeywords = KEYWORDS;
      }

      const keyword = availableKeywords[Math.floor(Math.random() * availableKeywords.length)] as string;
      usedKeywords.push(keyword);

      const attemptNumber = searchCount + 1;

      try {
        // The rewards helper may have left another tab active.
        if (rewards) {
          await rewards.focusSearch();
        }

        // Replace the previous search's "memuat hasil" while the search box
        // loads (can take up to 10 s).
        show("[dim]menyiapkan pencarian[/dim]");

        const searchBox = await driver.wait(until.elementLocated(By.name("q")), 10_000);

        await searchBox.clear();

        show(`[cyan]mengetik[/cyan] [white]${ui.escape(keyword)}[/white]`);

        await humanTyping(searchBox, keyword);
        throwIfInterrupted();

        await searchBox.sendKeys(Key.ENTER);

        searchCount++;
        result.searches = searchCount;
        consecutiveFailures = 0;

        ui.searchOk(searchCount, maxSearches, keyword);

        // Let the results load, then start over (a fixed wait, no scrolling).
        // The search that just finished, not the next one.
        show("[dim]memuat hasil[/dim]", searchCount);

        // Points are claimed once, after all searches (finish).
        await sleep(WAIT_AFTER_SEARCH * 1000);
        throwIfInterrupted();

        await driver.get(SEARCH_URL);
      } catch (error) {
        if (error instanceof InterruptedError) {
          throw error;
        }

        consecutiveFailures++;

        result.failures.push({ attempt: attemptNumber, keyword, error: errorName(error) });
        ui.searchFailed(attemptNumber, maxSearches, keyword, errorName(error));

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          failureLimitReached = true;
          result.stoppedEarly = true;
          ui.profileNote(`berhenti setelah ${consecutiveFailures} gagal berturut-turut`);
          break;
        }

        // Otherwise the spinner keeps saying "mengetik ...".
        show("[dim]kembali ke halaman pencarian[/dim]", attemptNumber);

        try {
          await driver.get(SEARCH_URL);
        } catch {
          // Ignore; the next attempt reports the problem.
        }
      }
    }

    // Check the counter once the searches are done; a search that did not
    // count leaves it short, so do the missing ones.
    if (
      !rewards ||
      failureLimitReached ||
      searchCount === 0 ||
      topups >= REWARDS_SEARCH_TOPUP_ROUNDS
    ) {
      break;
    }

    show("[dim]cek poin search[/dim]", searchCount);
    const more = await rewards.recheckSearch();

    if (more <= 0) {
      break;
    }

    topups += 1;
    const reward = result.reward as RewardResult;
    ui.profileNote(`poin search baru ${reward.searchDone}/${reward.searchTotal} · tambah ${more} pencarian`);
    maxSearches += more;
    result.target = maxSearches;
    }

    // ----------------------------------------------------
    // Profile completed
    // ----------------------------------------------------

    if (rewards) {
      await rewards.finish();
    }

    // The caller prints the per-profile recap line, since it also knows how
    // long the profile took (including launching Edge).
    return result;
  } catch (error) {
    // Re-throw so the main loop stops instead of moving on to the next
    // profile after the user pressed Ctrl+C.
    if (error instanceof InterruptedError) {
      throw error;
    }

    // Reported once, in the profile footer printed by the caller.
    result.error = errorText(error);
    return result;
  } finally {
    status.stop();
  }
}
