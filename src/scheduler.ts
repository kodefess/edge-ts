/**
 * Execution-time scheduler for the automation session.
 *
 * Supported modes:
 *   - once  - run at a specific date and time
 *   - daily - run every day at a specific time
 *
 * Re-checks the wall clock while waiting, so it keeps working across system
 * clock changes and machine sleep/resume cycles.
 */
import readline from "node:readline/promises";

import {
  SCHEDULE_AT,
  SCHEDULE_DAILY_TIME,
  SCHEDULE_MODE,
} from "./config/settings";
import { console, renderMarkup } from "./utils/console";
import { sleep } from "./utils/delay";

export interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
}

/** Resolved execution schedule. */
export class Schedule {
  constructor(
    readonly mode: "once" | "daily",
    /** Only used when mode == "once". */
    readonly runAt?: Date,
    /** Only used when mode == "daily". */
    readonly dailyTime?: TimeOfDay,
  ) {}

  static now(): Schedule {
    return new Schedule("once", new Date());
  }

  /** Return the next datetime this schedule should fire. */
  nextRun(reference?: Date): Date {
    if (this.mode === "once") {
      if (!this.runAt) throw new Error("Schedule is missing runAt");
      return this.runAt;
    }

    if (!this.dailyTime) throw new Error("Schedule is missing dailyTime");

    return nextDailyRun(this.dailyTime, reference);
  }
}

// ============================================================
// PARSING
// ============================================================

const pad = (value: number) => String(value).padStart(2, "0");

function normalize(value: string): string {
  return String(value).trim().split(/\s+/).join(" ");
}

function validTime(hour: number, minute: number, second: number): boolean {
  return (
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

/** Parse a time such as 00:01, 13:00, 13:00:30 or 13.00. */
export function parseTimeOfDay(value: string): TimeOfDay {
  const text = normalize(value);
  const match =
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text) ??
    /^(\d{1,2})\.(\d{2})()$/.exec(text);

  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = match[3] ? Number(match[3]) : 0;

    if (validTime(hour, minute, second)) {
      return { hour, minute, second };
    }
  }

  throw new Error(`Invalid time '${value}'. Use HH:MM, for example 00:01.`);
}

function makeDate(
  year: number,
  month: number,
  day: number,
  time: TimeOfDay,
): Date | undefined {
  const date = new Date(
    year,
    month - 1,
    day,
    time.hour,
    time.minute,
    time.second,
    0,
  );

  // Reject overflow such as 2026-02-31.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return undefined;
  }

  return date;
}

/**
 * Parse a date and time, or a time-only value.
 *
 * Accepts YYYY-MM-DD HH:MM[:SS], DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD,
 * "DD MM YYYY" and ISO "YYYY-MM-DDTHH:MM". A time-only value is resolved to
 * the next occurrence: today if the time has not passed yet, otherwise
 * tomorrow.
 */
export function parseDatetime(value: string, reference = new Date()): Date {
  const text = normalize(value);

  if (!text) {
    throw new Error(
      "Empty date/time. Use YYYY-MM-DD HH:MM, for example 2026-11-12 13:00.",
    );
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)$/.exec(
    text,
  );
  const yearFirst =
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2}) (\d{1,2}:\d{2}(?::\d{2})?)$/.exec(text);
  const dayFirst =
    /^(\d{1,2})[/ -](\d{1,2})[/ -](\d{4}) (\d{1,2}:\d{2}(?::\d{2})?)$/.exec(
      text,
    );

  const parts = iso ?? yearFirst;

  try {
    if (parts) {
      const date = makeDate(
        Number(parts[1]),
        Number(parts[2]),
        Number(parts[3]),
        parseTimeOfDay(parts[4] ?? ""),
      );
      if (date) return date;
    } else if (dayFirst) {
      const date = makeDate(
        Number(dayFirst[3]),
        Number(dayFirst[2]),
        Number(dayFirst[1]),
        parseTimeOfDay(dayFirst[4] ?? ""),
      );
      if (date) return date;
    }
  } catch {
    // Fall through to the error below.
  }

  if (!parts && !dayFirst) {
    // Allow a bare time, e.g. "13:00".
    let time: TimeOfDay;

    try {
      time = parseTimeOfDay(text);
    } catch {
      throw new Error(
        `Invalid date/time '${value}'. Use YYYY-MM-DD HH:MM, for example 2026-11-12 13:00.`,
      );
    }

    const candidate = new Date(reference);
    candidate.setHours(time.hour, time.minute, time.second, 0);

    if (candidate <= reference) {
      candidate.setDate(candidate.getDate() + 1);
    }

    return candidate;
  }

  throw new Error(
    `Invalid date/time '${value}'. Use YYYY-MM-DD HH:MM, for example 2026-11-12 13:00.`,
  );
}

/** Return the next occurrence of a daily time. */
export function nextDailyRun(
  dailyTime: TimeOfDay,
  reference = new Date(),
): Date {
  const candidate = new Date(reference);
  candidate.setHours(dailyTime.hour, dailyTime.minute, dailyTime.second, 0);

  if (candidate <= reference) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return candidate;
}

// ============================================================
// FORMATTING
// ============================================================

/** Format a number of seconds as a short human-readable duration ("1d 2h 3m 4s"). */
export function formatDuration(seconds: number): string {
  let total = Math.max(0, Math.round(seconds));

  const days = Math.floor(total / 86400);
  total %= 86400;
  const hours = Math.floor(total / 3600);
  total %= 3600;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;

  const parts: string[] = [];

  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

export function formatDatetime(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** Return a human-readable description of a schedule. */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.mode === "daily" && schedule.dailyTime) {
    return `every day at ${pad(schedule.dailyTime.hour)}:${pad(schedule.dailyTime.minute)}`;
  }

  return formatDatetime(schedule.runAt ?? new Date());
}

// ============================================================
// WAITING
// ============================================================

/**
 * Wait until target is reached.
 *
 * The wall clock is re-checked every pollInterval seconds. This makes the
 * wait robust against clock adjustments, and the heartbeat keeps the user
 * informed during long waits.
 */
export async function waitUntil(
  target: Date,
  pollInterval = 30,
  heartbeat = 60,
): Promise<void> {
  let firstReport = true;
  let lastReport = 0;

  for (;;) {
    const remaining = (target.getTime() - Date.now()) / 1000;

    if (remaining <= 0) {
      return;
    }

    const nowMonotonic = performance.now() / 1000;

    if (firstReport || nowMonotonic - lastReport >= heartbeat) {
      console.markup(
        `[dim]waiting[/dim]  ${formatDuration(remaining)} [dim]· target ${formatDatetime(target)}[/dim]`,
      );

      firstReport = false;
      lastReport = nowMonotonic;
    }

    await sleep(Math.min(remaining, pollInterval) * 1000);
  }
}

// ============================================================
// INTERACTIVE PROMPT
// ============================================================

async function ask(
  rl: readline.Interface,
  label: string,
  fallback: string,
  choices?: string[],
): Promise<string> {
  for (;;) {
    const hint = [
      choices ? `[${choices.join("/")}]` : "",
      fallback ? `(${fallback})` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const answer =
      (
        await rl.question(`${renderMarkup(label)}${hint ? ` ${hint}` : ""}: `)
      ).trim() || fallback;

    if (!choices || choices.includes(answer)) {
      return answer;
    }

    console.markup("[red]Please select one of the available options[/red]");
  }
}

/** Ask the user which schedule to use. */
export async function promptSchedule(): Promise<Schedule> {
  console.print();
  console.markup(
    "[bold white]Schedule[/bold white] [dim]· when should the session run?[/dim]",
  );
  console.print();
  console.markup("  [cyan]1[/cyan]  Once at a specific date and time");
  console.markup("  [cyan]2[/cyan]  Every day at a specific time");
  console.markup("  [cyan]3[/cyan]  Run now");
  console.print();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const choice = await ask(rl, "[dim]choose[/dim]", "3", ["1", "2", "3"]);

    if (choice === "3") {
      return Schedule.now();
    }

    if (choice === "1") {
      for (;;) {
        const raw = await ask(
          rl,
          "[dim]date & time[/dim] [dim](YYYY-MM-DD HH:MM)[/dim]",
          "",
        );

        if (!raw.trim()) {
          console.markup("[yellow]![/yellow] Please enter a date and time.");
          continue;
        }

        let runAt: Date;

        try {
          runAt = parseDatetime(raw);
        } catch (error) {
          console.markup(`[red]✗[/red] ${(error as Error).message}`);
          continue;
        }

        if (runAt <= new Date()) {
          console.markup("[red]✗[/red] That time is in the past.");
          continue;
        }

        return new Schedule("once", runAt);
      }
    }

    for (;;) {
      const raw = await ask(
        rl,
        "[dim]daily time[/dim] [dim](HH:MM)[/dim]",
        "00:01",
      );

      try {
        return new Schedule("daily", undefined, parseTimeOfDay(raw));
      } catch (error) {
        console.markup(`[red]✗[/red] ${(error as Error).message}`);
      }
    }
  } finally {
    rl.close();
  }
}

// ============================================================
// ENVIRONMENT FALLBACK
// ============================================================

/**
 * Read an optional schedule from environment variables.
 *
 *   SCHEDULE_MODE=once   + SCHEDULE_AT=2026-11-12 13:00
 *   SCHEDULE_MODE=daily  + SCHEDULE_DAILY_TIME=00:01
 *   SCHEDULE_MODE=now
 */
export function scheduleFromEnv(): Schedule | undefined {
  const mode = SCHEDULE_MODE ?? "";
  const at = SCHEDULE_AT ?? "";
  const daily = SCHEDULE_DAILY_TIME ?? "";

  if (!mode && !at && !daily) {
    return undefined;
  }

  if (mode && !["now", "once", "daily"].includes(mode)) {
    throw new Error("SCHEDULE_MODE must be one of: now, once, daily.");
  }

  if (mode === "now") {
    return Schedule.now();
  }

  if (mode === "once") {
    if (!at)
      throw new Error("SCHEDULE_AT is required when SCHEDULE_MODE=once.");
    return new Schedule("once", parseDatetime(at));
  }

  if (mode === "daily") {
    if (!daily)
      throw new Error(
        "SCHEDULE_DAILY_TIME is required when SCHEDULE_MODE=daily.",
      );
    return new Schedule("daily", undefined, parseTimeOfDay(daily));
  }

  // No explicit mode: infer it from the values that were provided.
  if (at && daily) {
    throw new Error("Set only one of SCHEDULE_AT and SCHEDULE_DAILY_TIME.");
  }

  if (daily) {
    return new Schedule("daily", undefined, parseTimeOfDay(daily));
  }

  return new Schedule("once", parseDatetime(at));
}
