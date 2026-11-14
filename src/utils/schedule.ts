import pc from "picocolors";
import { sleep } from "./delay";
import { console, formatDuration } from "./console";

/**
 * Parses "10", "10:00", "9.30" or "21:05" into the next matching Date.
 * If that time has already passed today, it targets tomorrow.
 */
export function parseStartTime(value: string, now = new Date()): Date {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?$/.exec(value.trim());

  const hours = match ? Number(match[1]) : NaN;
  const minutes = match?.[2] ? Number(match[2]) : 0;

  if (!match || hours > 23 || minutes > 59) {
    throw new Error(
      `Invalid start time "${value}". Use HH:MM (24 hours), e.g. 10:00 or 21:30.`,
    );
  }

  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);

  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target;
}

function formatClock(date: Date, now: Date): string {
  const time = date.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return date.getDate() === now.getDate() ? `${time} hari ini` : `${time} besok`;
}

/**
 * Waits until `target`, showing a live countdown. Polls every second against
 * the wall clock, so it still fires right away if the PC wakes from sleep late.
 */
export async function waitUntil(target: Date): Promise<void> {
  const now = new Date();

  console.print();
  console.print(
    `${pc.cyan("⏰")} Dijadwalkan mulai ${pc.bold(formatClock(target, now))} ${pc.dim("(Ctrl+C untuk batal)")}`,
  );

  const isTTY = process.stdout.isTTY;
  let lastLogged = -1;

  while (Date.now() < target.getTime()) {
    const remaining = target.getTime() - Date.now();
    const label = `menunggu… ${formatDuration(remaining)} lagi`;

    console.setTitle(`edge-ts · ${label}`);

    if (isTTY) {
      process.stdout.write(`\r${pc.dim(`  ${label}`)}\x1b[K`);
    } else {
      // Non-interactive output (e.g. redirected to a log): one line per 10 minutes.
      const bucket = Math.floor(remaining / 600_000);

      if (bucket !== lastLogged) {
        lastLogged = bucket;
        console.dim(`  ${label}`);
      }
    }

    await sleep(Math.min(1_000, remaining));
  }

  if (isTTY) {
    process.stdout.write("\r\x1b[K");
  }

  console.print(`${pc.green("▶")} Waktunya mulai.`);
}
