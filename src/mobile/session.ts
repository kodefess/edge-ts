/**
 * The mobile run with its terminal output, shared by `just mobile run` and the
 * end of `just web run` (MOBILE_BACKEND=appium).
 *
 * Layout follows the web session so both read the same way:
 *
 *     ── mobile ─────────────────────────────
 *       akun       29  · semua akun di aplikasi Bing
 *       target     10 artikel/akun  · dwell 15–30s
 *
 *     ┌ Handoko Gudang (ptv.gudang2@gmail.com)        2/29
 *     │ ▶ membaca berita · target 10 · daily 0/120
 *     └ ■ selesai   10/10 baca   daily 0/120 → 30/120   +30   5m12s
 *
 *     ── rekap mobile ───────────────────────
 */
import {
  MOBILE_ADB_WIFI_AUTO,
  MOBILE_APP_ACCOUNTS,
  MOBILE_APP_ACTIVITIES,
  MOBILE_APP_CHECKIN,
  MOBILE_APP_CLOSE_TABS,
  MOBILE_APP_DWELL_MAX,
  MOBILE_APP_DWELL_MIN,
  MOBILE_APP_MAX_SWIPES,
  MOBILE_APP_NEWS_MAX,
  MOBILE_APP_READ_ROUNDS,
  MOBILE_APP_RESTORE_ACCOUNT,
  MOBILE_APP_RETRY,
  MOBILE_APP_SKIP_FULL,
  MOBILE_APPIUM_APP_ACTIVITY,
  MOBILE_APPIUM_APP_PACKAGE,
  MOBILE_APPIUM_AUTOSTART,
  MOBILE_APPIUM_SERVER,
  MOBILE_APPIUM_UDID,
  MOBILE_APPIUM_WAIT,
} from "../config/settings";
import { console } from "../utils/console";
import { InterruptedError } from "../utils/interrupt";
import * as ui from "../utils/ui";
import * as mobileUi from "../utils/ui-mobile";
import { AccountSession, runAccounts, type AccountRun } from "./app-accounts";
import { ensureConnected, isWireless } from "./adb-wifi";
import { createAppDriver } from "./appium";
import { AppiumServer } from "./appium-server";

export interface MobileSessionOptions {
  accounts?: string[];
  count?: number;
  dwellMin?: number;
  dwellMax?: number;
  maxSwipes?: number;
  server?: string;
  udid?: string;
  package?: string;
  activity?: string;
  wait?: number;
  restore?: boolean;
  skipFull?: boolean;
  autostart?: boolean;
  checkin?: boolean;
  activities?: boolean;
  retries?: number;
  readRounds?: number;
  closeTabs?: boolean;
  dryRun?: boolean;
}

export interface MobileSessionResult {
  session: AccountSession;
  imperfect: AccountRun[];
  interrupted: boolean;
}

/**
 * Run every account and print blocks plus the recap. Throws `AppiumUnavailable`
 * when no phone or server can be reached (nothing has run yet in that case).
 */
export async function runMobileSession(options: MobileSessionOptions = {}): Promise<MobileSessionResult> {
  const accounts = options.accounts ?? MOBILE_APP_ACCOUNTS;
  const count = options.count ?? MOBILE_APP_NEWS_MAX;
  const dwellMin = options.dwellMin ?? MOBILE_APP_DWELL_MIN;
  const dwellMax = options.dwellMax ?? MOBILE_APP_DWELL_MAX;
  const server = options.server ?? MOBILE_APPIUM_SERVER;
  const checkin = options.checkin ?? MOBILE_APP_CHECKIN;
  const activities = options.activities ?? MOBILE_APP_ACTIVITIES;
  const readRounds = options.readRounds ?? MOBILE_APP_READ_ROUNDS;
  const closeTabs = options.closeTabs ?? MOBILE_APP_CLOSE_TABS;
  const dryRun = options.dryRun ?? false;
  const pkg = options.package ?? MOBILE_APPIUM_APP_PACKAGE;
  let udid = options.udid ?? MOBILE_APPIUM_UDID;

  const session = new AccountSession();
  const started = Date.now();
  let interrupted = false;
  const state = { article: 0, readSoFar: 0, roundTarget: 0, retry: 0 };

  ui.section("mobile");

  // Already shown by the article and account lines.
  const quiet = ["baca ·", "pilih akun", "switch now", "check in", "aktivitas ·"];

  const log = (message: string): void => {
    if (message.startsWith("kembali ke akun awal")) {
      console.print();
      ui.field("akun awal", `[dim]${message.split("·").slice(1).join("·").trim() || message}[/dim]`);
    } else if (!quiet.some((prefix) => message.startsWith(prefix))) {
      mobileUi.mobileNote(message);
    }
  };

  // Phone over USB, or reconnect it over Wi-Fi (`just mobile wifi`).
  if (MOBILE_ADB_WIFI_AUTO) {
    const serial = await ensureConnected((message) => ui.field("adb", `[dim]${message}[/dim]`));

    if (serial) {
      ui.field("hp", `${serial}  [dim]· ${isWireless(serial) ? "wifi" : "usb"}[/dim]`);
      // Pin the session to it: the same phone can be listed twice (USB and
      // Wi-Fi) and Appium would otherwise pick either.
      udid = udid || serial;
    }
  }

  const appium = new AppiumServer(server, options.autostart ?? MOBILE_APPIUM_AUTOSTART, (message) =>
    ui.field("appium", `[dim]${message}[/dim]`),
  );

  try {
    await appium.start();

    const driver = await createAppDriver({
      server,
      udid: udid || null,
      appPackage: pkg,
      appActivity: (options.activity ?? MOBILE_APPIUM_APP_ACTIVITY) || null,
    });

    try {
      await runAccounts(driver, {
        accounts,
        count,
        dwellMin,
        dwellMax,
        maxSwipes: options.maxSwipes ?? MOBILE_APP_MAX_SWIPES,
        package: pkg,
        wait: options.wait ?? MOBILE_APPIUM_WAIT,
        restore: options.restore ?? MOBILE_APP_RESTORE_ACCOUNT,
        skipFull: options.skipFull ?? MOBILE_APP_SKIP_FULL,
        dryRun,
        log,
        checkin,
        activities,
        retries: options.retries ?? MOBILE_APP_RETRY,
        readRounds,
        closeTabs,
        session,
        onPlan: (plan) => {
          const scope = accounts.length ? `${accounts.length} dipilih` : "semua akun di aplikasi Bing";
          ui.field("akun", `[bold white]${plan.total}[/bold white]  [dim]· ${scope}[/dim]`);

          const steps = (
            [
              ["check in", checkin],
              ["more activities", activities],
              ["baca sampai 30/30", count > 0],
              ["tutup tab", closeTabs],
            ] as Array<[string, boolean]>
          )
            .filter(([, on]) => on)
            .map(([name]) => name);

          ui.field("tugas", steps.join(" → "));
          ui.field(
            "target",
            `maks [bold white]${count}[/bold white] artikel/putaran · ${readRounds} putaran  ` +
              `[dim]· dwell ${dwellMin}–${dwellMax}s${dryRun ? " · dry-run" : ""}[/dim]`,
          );

          if (plan.original) {
            ui.field("aktif", `[dim]${plan.original}[/dim]`);
          }
        },
        onRetry: (roundNo, failed) => {
          state.retry = roundNo;
          mobileUi.mobileRetry(roundNo, failed);
        },
        onStart: (index, total, name, email) => {
          state.article = 0;
          state.readSoFar = 0;
          mobileUi.mobileAccountHeader(name, email, index, total, Boolean(state.retry));
        },
        onRewards: (run) => mobileUi.mobileRewards(run.rewards),
        onReady: (run) => {
          // Numbering restarts with every reading round.
          state.article = 0;
          state.roundTarget = run.target - state.readSoFar;
          state.readSoFar = run.target;
          mobileUi.mobileAccountReady(state.roundTarget, run.before, run.rewards, run.readRound, [run.readEnd, run.readCap]);
        },
        onArticle: (article) => {
          // Number only the articles that were read; a card that did not open
          // is shown without a number and retried with the next card.
          if (article.ok) {
            state.article += 1;
          }
          mobileUi.mobileArticle(article.ok ? state.article : 0, state.roundTarget || count, article);
        },
        onAccount: (run) => mobileUi.mobileAccountFooter(run),
      });
    } finally {
      await driver.quit().catch(() => undefined);
    }
  } catch (error) {
    if (!(error instanceof InterruptedError)) {
      throw error;
    }

    interrupted = true;
    console.print();
  } finally {
    appium.stop();
  }

  let imperfect: AccountRun[] = [];

  if (session.planned.length || session.runs.length) {
    imperfect = mobileUi.mobileRecap(session, (Date.now() - started) / 1000, interrupted);
  }

  return { session, imperfect, interrupted };
}
