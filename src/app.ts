import { parseArgs } from "node:util";

import type { WebDriver } from "selenium-webdriver";

import {
  CLOSE_EXISTING_EDGE,
  MOBILE_APP_NEWS_ENABLED,
  MOBILE_APP_NEWS_MAX,
  MOBILE_BACKEND,
  MOBILE_RUN_MODE,
  PROFILES,
  REWARDS_ENABLED,
  RUN_AT,
  SEARCHES_PER_PROFILE,
} from "./config/settings";
import { createDriver, setWindowMode } from "./driver/edge";
import { REDEEM_URL, openWindow, profileAccount, resolveProfile } from "./driver/manual";
import {
  Schedule,
  describeSchedule,
  formatDatetime,
  parseDatetime,
  parseTimeOfDay,
  promptSchedule,
  scheduleFromEnv,
  waitUntil,
} from "./scheduler";
import { INTERRUPTED, KEYWORDS, ProfileResult, runSearchesForProfile } from "./search/engine";
import { console } from "./utils/console";
import { sleep } from "./utils/delay";
import { InterruptedError, installInterruptHandler, isInterrupted } from "./utils/interrupt";
import { closeRunningEdge } from "./utils/process";
import * as ui from "./utils/ui";

// ============================================================
// SCHEDULE RESOLUTION
// ============================================================

const USAGE = `Run the automated search session immediately, once at a specific time, or every day at a fixed time.

  --now              run the session immediately
  --at DATETIME      run once at a date and time, for example "2026-11-12 13:00"
  --daily HH:MM      run every day at a fixed time, for example "00:01"
  --visible          show the Edge windows (maximized) for this run, whatever EDGE_WINDOW_MODE says
  --preview [NAME…]  open the profiles in plain Edge windows at Rewards → Redeem and run no task
                     (all of PROFILES, or the given profile names / emails)
  --no-prompt        never ask interactively; fail if no schedule was provided

A bare time (e.g. 10:00) is the same as --at 10:00.`;

interface Args {
  now: boolean;
  at?: string;
  daily?: string;
  visible: boolean;
  /** Defined (possibly empty) when --preview was given. */
  preview?: string[];
  noPrompt: boolean;
}

/** Parse the command line (port of argparse with a mutually exclusive group). */
function parseArguments(): Args {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      now: { type: "boolean", default: false },
      at: { type: "string" },
      daily: { type: "string" },
      visible: { type: "boolean", default: false },
      preview: { type: "boolean", default: false },
      "no-prompt": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.print(USAGE);
    process.exit(0);
  }

  if (values.preview) {
    return { now: false, visible: values.visible ?? false, preview: positionals, noPrompt: true };
  }

  // edge-ts compatibility: `just web run 10:00` → --at 10:00
  const at = values.at ?? (positionals.join(" ").trim() || undefined);

  const chosen = [values.now, at !== undefined, values.daily !== undefined].filter(Boolean).length;

  if (chosen > 1) {
    throw new Error("Use only one of --now, --at and --daily.");
  }

  return {
    now: values.now ?? false,
    at,
    daily: values.daily,
    visible: values.visible ?? false,
    noPrompt: values["no-prompt"] ?? false,
  };
}

/** Resolve the schedule from CLI arguments, env vars, or a prompt. */
async function resolveSchedule(args: Args): Promise<Schedule> {
  if (args.now) return Schedule.now();
  if (args.at) return new Schedule("once", parseDatetime(args.at));
  if (args.daily) return new Schedule("daily", undefined, parseTimeOfDay(args.daily));

  const envSchedule = scheduleFromEnv();

  if (envSchedule) return envSchedule;

  // Legacy edge-ts setting.
  if (RUN_AT) return new Schedule("once", parseDatetime(RUN_AT));

  if (args.noPrompt || !process.stdin.isTTY) {
    throw new Error("No schedule provided. Use --now, --at, or --daily.");
  }

  return promptSchedule();
}

/** Reject a one-time schedule that is clearly in the past. */
function validateSchedule(schedule: Schedule): void {
  if (schedule.mode !== "once" || !schedule.runAt) {
    return;
  }

  // Allow a small grace period so "--now" and starting the script a few
  // seconds late still work.
  if (schedule.runAt.getTime() < Date.now() - 60_000) {
    throw new Error(
      `Scheduled time is in the past: ${formatDatetime(schedule.runAt)}. Use --now to run immediately.`,
    );
  }
}

/** Wait for the schedule and run the session. */
async function runScheduled(schedule: Schedule): Promise<number> {
  ui.field("jadwal", describeSchedule(schedule));

  for (;;) {
    const target = schedule.nextRun();

    if (target.getTime() > Date.now()) {
      await waitUntil(target);

      if (isInterrupted()) {
        throw new InterruptedError();
      }
    }

    const failedProfiles = await runSession();

    if (schedule.mode === "once") {
      // The recap already reports the outcome.
      return failedProfiles;
    }

    console.markup("[dim]Mode harian aktif · menunggu jadwal berikutnya…[/dim]");
    console.print();
  }
}

// ============================================================
// SESSION
// ============================================================

/** Driver of the profile that is running, so Ctrl+C can still close Edge. */
let currentDriver: WebDriver | undefined;

async function runSession(): Promise<number> {
  const totalProfiles = PROFILES.length;
  const results: ProfileResult[] = [];
  let interrupted = false;

  if (totalProfiles === 0) {
    console.markup("[red]✗[/red] Tidak ada profile yang dikonfigurasi.");
    return 1;
  }

  const sessionStartedAt = performance.now();

  // --------------------------------------------------------
  // Session overview
  // --------------------------------------------------------

  ui.section("sesi");
  ui.field("profiles", `[bold white]${totalProfiles}[/bold white]`);
  ui.profileGrid(PROFILES);
  console.print();
  ui.field(
    "target",
    `[bold white]${SEARCHES_PER_PROFILE}[/bold white] tugas/profile  ` +
      `[dim](${SEARCHES_PER_PROFILE * totalProfiles} total)[/dim]`,
  );
  ui.field("keywords", `[bold white]${KEYWORDS.length}[/bold white]`);

  if (REWARDS_ENABLED) {
    ui.field(
      "reward",
      "[bold white]aktif[/bold white]  [dim]· tab kedua · daily · foto · perks · earn → search → klaim[/dim]",
    );
  }

  // --------------------------------------------------------
  // Close existing Edge
  // --------------------------------------------------------

  if (CLOSE_EXISTING_EDGE) {
    await closeRunningEdge();
  }

  // --------------------------------------------------------
  // Process profiles
  // --------------------------------------------------------

  try {
    for (const [offset, profile] of PROFILES.entries()) {
      const index = offset + 1;
      const result = new ProfileResult(profile, SEARCHES_PER_PROFILE);

      // Register before running so an interrupted profile still appears in
      // the recap.
      results.push(result);

      await runProfile(result, index, totalProfiles);

      // ------------------------------------------------
      // Delay between profiles
      // ------------------------------------------------

      if (index < totalProfiles) {
        const pause = 10 + Math.random() * 10;

        ui.pause(pause);
        await sleep(pause * 1000);

        if (isInterrupted()) {
          throw new InterruptedError();
        }
      }
    }
  } catch (error) {
    if (!(error instanceof InterruptedError)) {
      throw error;
    }

    // Still show what was done before Ctrl+C, then stop.
    interrupted = true;
  }

  // --------------------------------------------------------
  // Final Summary
  // --------------------------------------------------------

  const imperfect = ui.sessionRecap(
    results,
    totalProfiles,
    (performance.now() - sessionStartedAt) / 1000,
    interrupted,
  );

  if (interrupted) {
    throw new InterruptedError();
  }

  // --------------------------------------------------------
  // Read to Earn on the phone, every Bing app account
  // (prints its own blocks and "rekap mobile")
  // --------------------------------------------------------

  if (appNewsWanted()) {
    await runAppNewsPass();
  }

  return imperfect.length;
}

function appNewsWanted(): boolean {
  return (
    MOBILE_RUN_MODE !== "off" && MOBILE_BACKEND === "appium" && MOBILE_APP_NEWS_ENABLED && MOBILE_APP_NEWS_MAX > 0
  );
}

/** Read to Earn on the attached phone. Never fails the session. */
async function runAppNewsPass(): Promise<void> {
  // Imported here so a missing phone setup never breaks the web run.
  const { AppiumUnavailable } = await import("./mobile/appium");
  const { runMobileSession } = await import("./mobile/session");

  try {
    const { interrupted } = await runMobileSession();

    if (interrupted) {
      throw new InterruptedError();
    }
  } catch (error) {
    if (error instanceof InterruptedError) {
      throw error;
    }

    if (error instanceof AppiumUnavailable) {
      console.markup(`  [yellow]![/yellow] mobile dilewati · ${ui.escape(error.message)}`);
      return;
    }

    console.markup(
      `  [red]✗[/red] mobile · ${error instanceof Error ? error.name : "Error"}: ${ui.escape(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

/** Run one profile, recording its outcome in `result`. */
async function runProfile(result: ProfileResult, index: number, totalProfiles: number): Promise<ProfileResult> {
  const profile = result.profile;

  ui.profileHeader(profile, index, totalProfiles, SEARCHES_PER_PROFILE);
  console.setTitle(`edge-ts · ${index}/${totalProfiles} · ${profile} sedang mencari`);

  const startedAt = performance.now();
  let driver: WebDriver | undefined;

  try {
    driver = await new ui.Activity("[dim]membuka Edge…[/dim]").run(() => createDriver(profile));
    currentDriver = driver;

    if (isInterrupted()) {
      throw new InterruptedError();
    }

    await runSearchesForProfile(driver, profile, SEARCHES_PER_PROFILE, result);
  } catch (error) {
    if (error instanceof InterruptedError) {
      result.error = INTERRUPTED;
      throw error;
    }

    // Reported once, in the profile footer.
    result.error = error instanceof Error ? `${error.name}: ${error.message}`.trim() : String(error);
  } finally {
    result.duration = (performance.now() - startedAt) / 1000;

    if (driver) {
      try {
        await driver.quit();
      } catch {
        // Never let a cleanup failure hide the real error.
      }
    }

    currentDriver = undefined;
    ui.profileFooter(result);
  }

  return result;
}

// ============================================================
// ENTRY POINT
// ============================================================

/**
 * Open each profile copy in a plain Edge window; no task runs.
 *
 * For redeeming points by hand: the windows are normal Edge windows on the
 * same signed-in copies the web run uses, without WebDriver.
 */
async function runPreview(targets: string[]): Promise<number> {
  const profiles: string[] = [];

  for (const target of targets.length ? targets : PROFILES) {
    const profile = resolveProfile(target);

    if (profile) {
      profiles.push(profile);
    } else {
      console.markup(
        `  [yellow]![/yellow] ${ui.escape(target)} bukan profile di PROFILES dan tidak cocok dengan email mana pun · dilewati`,
      );
    }
  }

  if (!profiles.length) {
    console.markup("  [red]✗[/red] tidak ada profile untuk dibuka");
    return 1;
  }

  ui.section("preview · tanpa tugas");

  for (const [offset, profile] of profiles.entries()) {
    const email = profileAccount(profile);
    openWindow(profile, REDEEM_URL).unref();
    console.markup(
      `  [green]✓[/green] ${String(offset + 1).padStart(2)}. [bold white]${ui.escape(profile)}[/bold white]  [dim]${email ? ui.escape(email) : "-"}[/dim]`,
    );
    // Let Edge register each window before the next profile starts.
    await sleep(1500);
  }

  console.print();
  console.markup(
    "  [dim]Jendela Edge biasa (bukan otomasi): tukar poin di halaman Redeem, lalu tutup jendelanya.[/dim]",
  );
  console.markup("  [dim]Jangan jalankan `just web run` sebelum jendela-jendela ini ditutup.[/dim]");
  console.print();
  return 0;
}

async function main(): Promise<number> {
  installInterruptHandler();

  const args = parseArguments();

  ui.banner();

  if (args.preview !== undefined) {
    return runPreview(args.preview);
  }

  if (args.visible) {
    setWindowMode("maximized");
  }

  const schedule = await resolveSchedule(args);

  validateSchedule(schedule);

  return runScheduled(schedule);
}

main()
  .then((failedProfiles) => {
    console.setTitle("edge-ts · selesai");
    process.exitCode = failedProfiles;
  })
  .catch(async (error: unknown) => {
    if (error instanceof InterruptedError) {
      await currentDriver?.quit().catch(() => undefined);

      console.print();
      console.markup("[yellow]‼[/yellow] Script dihentikan.");
      process.exitCode = 130;
      return;
    }

    console.print();

    if (error instanceof Error && error.name === "Error") {
      // Configuration and schedule errors: one clear line.
      console.markup(`[red]✗[/red] ${ui.escape(error.message)}`);
      console.print();
    } else {
      console.markup(
        `[red]✗[/red] Fatal error [dim]· ${error instanceof Error ? error.name : typeof error}[/dim]`,
      );
      console.markup(`[dim]  ${ui.escape(error instanceof Error ? error.message : String(error))}[/dim]`);
    }

    process.exitCode = 1;
  });
