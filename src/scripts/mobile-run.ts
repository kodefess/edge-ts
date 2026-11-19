/**
 * Standalone mobile run: Read to Earn for every account in the Bing app.
 *
 * Usage:
 *   just mobile run
 *   just mobile run --list
 *   just mobile run --accounts a@gmail.com,b@gmail.com
 *   just mobile run --count 3 --dry-run
 *
 * No Edge, no desktop searches: only the phone. For each account (the active
 * one first, then the "Switch to another account" list, or the order given in
 * MOBILE_APP_ACCOUNTS / --accounts) it switches account in the app, does the
 * check-in and More activities, reads until Read to Earn is 30/30, and moves
 * on. At the end it switches back to the account that was active before.
 *
 * The Appium server is started automatically when none is running
 * (MOBILE_APPIUM_AUTOSTART), so one command is enough.
 */
import { parseArgs } from "node:util";

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
import { ensureConnected } from "../mobile/adb-wifi";
import { listAccounts } from "../mobile/app-accounts";
import { AppiumUnavailable, createAppDriver } from "../mobile/appium";
import { AppiumServer } from "../mobile/appium-server";
import { runMobileSession } from "../mobile/session";
import { console } from "../utils/console";
import { InterruptedError, installInterruptHandler } from "../utils/interrupt";
import * as ui from "../utils/ui";

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed)) {
    throw new Error(`${name} must be an integer, got: ${JSON.stringify(value)}`);
  }

  return parsed;
}

const HELP = `Read to Earn in the Bing app for every signed-in account.

  --server URL            Appium server (default ${MOBILE_APPIUM_SERVER})
  --udid SERIAL           phone serial (default: the only attached phone)
  --app PACKAGE           app package (default ${MOBILE_APPIUM_APP_PACKAGE})
  --activity ACTIVITY     app activity (default: launcher)
  --accounts EMAILS       comma-separated emails, in order (default: MOBILE_APP_ACCOUNTS, or all)
  --list                  only list the accounts in the app
  --count N               articles per round (default ${MOBILE_APP_NEWS_MAX})
  --dwell-min S / --dwell-max S   seconds in each article
  --max-swipes N          feed swipes without a new card before giving up
  --wait S                seconds to wait for the feed or a card
  --dry-run               switch accounts, list cards, tap no article
  --no-restore            stay on the last account instead of switching back
  --no-skip-full          read even when Daily points already show the cap
  --no-autostart          do not start an Appium server
  --no-checkin            skip the daily check-in
  --no-activities         skip More activities
  --no-read               only check in and More activities, read no news
  --retry N               extra rounds for failed accounts (default ${MOBILE_APP_RETRY})
  --read-rounds N         reading rounds until Read to earn is 30/30 (default ${MOBILE_APP_READ_ROUNDS})
  --no-close-tabs         leave the Bing app tabs open
  --json                  print the result as JSON`;

async function listOnly(server: string, udid: string, app: string, activity: string, autostart: boolean): Promise<number> {
  const serial = MOBILE_ADB_WIFI_AUTO ? await ensureConnected() : "";
  const appium = await new AppiumServer(server, autostart).start();

  let accounts: Array<[string, string]>;

  try {
    const driver = await createAppDriver({ server, udid: udid || serial || null, appPackage: app, appActivity: activity || null });

    try {
      accounts = await listAccounts(driver, app);
    } finally {
      await driver.quit().catch(() => undefined);
    }
  } finally {
    appium.stop();
  }

  ui.section("akun bing app");

  for (const [offset, [name, email]] of accounts.entries()) {
    const active = offset === 0 ? "  [green]aktif[/green]" : "";
    console.markup(`  [dim]${String(offset + 1).padStart(3)}[/dim]  ${ui.escape(email)}  [dim]${ui.escape(name)}[/dim]${active}`);
  }

  console.print();
  return 0;
}

async function main(): Promise<number> {
  installInterruptHandler();

  const { values } = parseArgs({
    options: {
      server: { type: "string", default: MOBILE_APPIUM_SERVER },
      udid: { type: "string", default: MOBILE_APPIUM_UDID },
      app: { type: "string", default: MOBILE_APPIUM_APP_PACKAGE },
      activity: { type: "string", default: MOBILE_APPIUM_APP_ACTIVITY },
      accounts: { type: "string", default: MOBILE_APP_ACCOUNTS.join(",") },
      list: { type: "boolean", default: false },
      count: { type: "string" },
      "dwell-min": { type: "string" },
      "dwell-max": { type: "string" },
      "max-swipes": { type: "string" },
      wait: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "no-restore": { type: "boolean", default: false },
      "no-skip-full": { type: "boolean", default: false },
      "no-autostart": { type: "boolean", default: false },
      "no-checkin": { type: "boolean", default: false },
      "no-activities": { type: "boolean", default: false },
      "no-read": { type: "boolean", default: false },
      retry: { type: "string" },
      "read-rounds": { type: "string" },
      "no-close-tabs": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.print(HELP);
    return 0;
  }

  const dwellMin = int(values["dwell-min"], MOBILE_APP_DWELL_MIN, "--dwell-min");
  const dwellMax = int(values["dwell-max"], MOBILE_APP_DWELL_MAX, "--dwell-max");

  if (dwellMin > dwellMax) {
    console.markup("[red]✗[/red] --dwell-min harus <= --dwell-max");
    return 2;
  }

  const wanted = (values.accounts ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const autostart = values["no-autostart"] ? false : MOBILE_APPIUM_AUTOSTART;

  ui.banner();

  try {
    if (values.list) {
      return await listOnly(values.server!, values.udid!, values.app!, values.activity!, autostart);
    }

    const { session, imperfect, interrupted } = await runMobileSession({
      accounts: wanted,
      count: values["no-read"] ? 0 : int(values.count, MOBILE_APP_NEWS_MAX, "--count"),
      dwellMin,
      dwellMax,
      maxSwipes: int(values["max-swipes"], MOBILE_APP_MAX_SWIPES, "--max-swipes"),
      server: values.server,
      udid: values.udid,
      package: values.app,
      activity: values.activity,
      wait: int(values.wait, MOBILE_APPIUM_WAIT, "--wait"),
      restore: values["no-restore"] ? false : MOBILE_APP_RESTORE_ACCOUNT,
      skipFull: values["no-skip-full"] ? false : MOBILE_APP_SKIP_FULL,
      autostart,
      checkin: values["no-checkin"] ? false : MOBILE_APP_CHECKIN,
      activities: values["no-activities"] ? false : MOBILE_APP_ACTIVITIES,
      retries: int(values.retry, MOBILE_APP_RETRY, "--retry"),
      readRounds: int(values["read-rounds"], MOBILE_APP_READ_ROUNDS, "--read-rounds"),
      closeTabs: values["no-close-tabs"] ? false : MOBILE_APP_CLOSE_TABS,
      dryRun: values["dry-run"],
    });

    if (values.json) {
      console.print(JSON.stringify(session.runs.map((run) => run.asDict()), null, 2));
    }

    if (interrupted) {
      return 130;
    }

    return session.runs.length && !imperfect.length && !session.notStarted.length ? 0 : 1;
  } catch (error) {
    if (error instanceof AppiumUnavailable) {
      console.markup(`[red]✗[/red] ${ui.escape(error.message)}`);
      return 1;
    }

    if (error instanceof InterruptedError) {
      console.markup("[yellow]‼[/yellow] dihentikan");
      return 130;
    }

    console.markup(
      `[red]✗[/red] ${ui.escape(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`)}`,
    );
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
