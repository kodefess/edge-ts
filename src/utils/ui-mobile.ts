/**
 * Terminal layout for the phone (Bing app) run: account blocks and the recap.
 *
 *     ┌ Handoko Gudang (ptv.gudang2@gmail.com)        2/29
 *     │ ▶ membaca berita · 10 artikel · read to earn 0/30 · daily 0/120
 *     │
 *     │   ✓  1/10  What is left to fight for in F1 2026?  · 18s
 *     │
 *     └ ■ selesai   10/10 baca   daily 0/120 → 30/120   +30   5m12s
 */
import type { AccountRun, AccountSession } from "../mobile/app-accounts";
import type { AppArticle } from "../mobile/app-news";
import type { RewardsResult } from "../mobile/app-rewards";
import { console } from "./console";
import { GUTTER, counter, escape, field, firstLine, formatDuration, printTable, section, width } from "./ui";

const DASH = "[dim]–[/dim]";

/** "3/3" in green when complete, yellow when not, dash when empty. */
function ratio(done: number, total: number): string {
  if (!total && !done) return DASH;
  const color = total && done >= total ? "green" : "yellow";
  return `[${color}]${done}/${total}[/${color}]`;
}

const MOBILE_OUTCOMES: Record<string, [string, string]> = {
  ok: ["green", "selesai"],
  full: ["green", "selesai"],
  partial: ["yellow", "sebagian"],
  error: ["red", "error"],
  interrupted: ["yellow", "dihentikan"],
};

const MOBILE_STATUS: Record<string, string> = {
  ok: "[green]✓ selesai[/green]",
  full: "[cyan]● penuh[/cyan]",
  partial: "[yellow]! sebagian[/yellow]",
  error: "[red]✗ error[/red]",
  interrupted: "[yellow]‼ berhenti[/yellow]",
  pending: "[dim]○ belum[/dim]",
};

/** `── ulang · 2 akun ──` (second chance after the last account). */
export function mobileRetry(roundNo: number, failed: number): void {
  section(roundNo > 1 ? `ulang ${roundNo}` : "ulang");
  console.markup(`  [yellow]↻[/yellow] [dim]${failed} akun gagal/sebagian dijalankan lagi · aplikasi Bing dibuka ulang[/dim]`);
}

/** `┌ name (email)                     i/N` */
export function mobileAccountHeader(name: string, email: string, index: number, total: number, retry = false): void {
  const position = `${retry ? "↻ " : ""}${index}/${total}`;
  const shown = name || email;
  let label = escape(shown);
  let visible = shown;

  if (name && email && name.trim().toLowerCase() !== email.trim().toLowerCase()) {
    label += ` [dim](${escape(email)})[/dim]`;
    visible += ` (${email})`;
  }

  const gap = " ".repeat(Math.max(2, width() - 2 - visible.length - position.length));

  console.print();
  console.markup(`[dim]┌[/dim] [bold white]${label}[/bold white]${gap}[dim]${position}[/dim]`);
}

/**
 * `│ ▶ membaca berita · 10 artikel · read to earn 0/30 · daily 0/120`
 *
 * Later rounds (Read to earn not at 30/30 yet) say so:
 * `│ ▶ putaran 2 · 3 artikel lagi · read to earn 21/30`
 */
export function mobileAccountReady(
  target: number,
  stats: Record<string, string> | undefined,
  rewards?: RewardsResult,
  roundNo = 1,
  read: [number | undefined, number | undefined] = [undefined, undefined],
): void {
  let [earned, cap] = read;

  if (earned === undefined && rewards) {
    earned = rewards.readEarned;
    cap = rewards.readCap;
  }

  let extra = cap ? ` · read to earn ${earned}/${cap}` : "";

  if (roundNo > 1) {
    console.markup(GUTTER);
    console.markup(`${GUTTER} [cyan]▶ putaran ${roundNo}[/cyan] [dim]· ${target} artikel lagi${extra}[/dim]`);
    console.markup(GUTTER);
    return;
  }

  const daily = stats?.["daily"];

  if (daily) {
    extra += ` · daily ${escape(daily)}`;
  }

  console.markup(GUTTER);
  console.markup(`${GUTTER} [cyan]▶ membaca berita[/cyan] [dim]· ${target} artikel${extra}[/dim]`);
  console.markup(GUTTER);
}

const CHECKIN: Record<string, [string, string]> = {
  checked_in: ["[green]✓[/green]", "berhasil"],
  already: ["[green]✓[/green]", "sudah hari ini"],
  failed: ["[red]✗[/red]", "gagal"],
  missing: ["[yellow]![/yellow]", "tidak ditemukan"],
};

/**
 * `│ ✓ check in        sudah hari ini · 15h 44m`
 * `│ ✓ more activities 10/15 → 15/15 · 1 dibuka`
 */
export function mobileRewards(rewards: RewardsResult | undefined): void {
  if (!rewards) return;

  console.markup(GUTTER);

  const checkin = CHECKIN[rewards.checkin];

  if (checkin) {
    const [icon, text] = checkin;
    const note = rewards.checkinNote ? ` [dim]· ${escape(rewards.checkinNote)}[/dim]` : "";
    console.markup(`${GUTTER} ${icon} [white]check in[/white]         ${text}${note}`);
  }

  const before = rewards.activitiesBefore;
  const after = rewards.activitiesAfter;

  if (before || after || rewards.activitiesOpened.length || rewards.activitiesLeft.length) {
    let progress = escape(after || before || "");

    if (before && after && before !== after) {
      progress = `${escape(before)} → [bold]${escape(after)}[/bold]`;
    }

    const notes: string[] = [];

    if (rewards.activitiesOpened.length) notes.push(`${rewards.activitiesOpened.length} dibuka`);
    if (rewards.activitiesLeft.length) notes.push(`[red]${rewards.activitiesLeft.length} belum[/red]`);
    if (!notes.length && rewards.activitiesDone) notes.push("sudah semua");

    const icon = rewards.activitiesDone && !rewards.activitiesLeft.length ? "[green]✓[/green]" : "[yellow]![/yellow]";
    const extra = notes.length ? ` [dim]· ${notes.join(" · ")}[/dim]` : "";
    console.markup(`${GUTTER} ${icon} [white]more activities[/white]  ${progress}${extra}`);
  }

  if (rewards.error) {
    console.markup(`${GUTTER} [red]✗[/red] [dim]rewards · ${escape(firstLine(rewards.error, 60))}[/dim]`);
  }
}

function checkinCell(rewards: RewardsResult | undefined): string {
  if (!rewards || rewards.checkin === "off") return DASH;

  return (
    {
      checked_in: "[green]✓[/green]",
      already: "[green]✓[/green]",
      failed: "[red]✗[/red]",
      missing: "[yellow]?[/yellow]",
    }[rewards.checkin] ?? DASH
  );
}

/** Read to earn points ("30/30") when known, else articles read. */
function readCell(run: AccountRun): string {
  if (run.readOff) return DASH;

  if (run.readEnd !== undefined && run.readCap) {
    return ratio(run.readEnd, run.readCap);
  }

  return ratio(run.read, run.target);
}

function activitiesCell(rewards: RewardsResult | undefined): string {
  if (!rewards) return DASH;

  const text = rewards.activitiesAfter || rewards.activitiesBefore;

  if (!text) return rewards.error ? "[red]✗[/red]" : DASH;

  const [done = 0, total = 0] = text.split("/").map((x) => Number.parseInt(x, 10));
  const color = total && done >= total ? "green" : "yellow";
  return `[${color}]${escape(text)}[/${color}]`;
}

export function mobileNote(message: string, icon = "·", color = "dim"): void {
  console.markup(`${GUTTER}   [${color}]${icon}[/${color}] [dim]${escape(message)}[/dim]`);
}

/** `│   ✓  1/10  title  · 18s` */
export function mobileArticle(number: number, total: number, article: AppArticle): void {
  const label = counter(number, total);
  const title = escape(firstLine(article.label, 46));

  if (!article.ok) {
    // Failed cards carry no number: the next card takes the slot.
    const blank = " ".repeat(label.length);
    console.markup(
      `${GUTTER}   [yellow]↷[/yellow] [dim]${blank}[/dim]  [dim]${title}  · ${escape(firstLine(article.error, 30))}[/dim]`,
    );
    return;
  }

  const dwell = article.dwell ? `  [dim]· ${Math.round(article.dwell)}s[/dim]` : "";

  console.markup(`${GUTTER}   [green]✓[/green] [dim]${label}[/dim]  ${title}${dwell}`);
}

/** `└ ■ selesai   10/10 baca   daily 0/120 → 30/120   +30   5m12s` */
export function mobileAccountFooter(run: AccountRun): void {
  const [outcomeColor, outcomeLabel] = MOBILE_OUTCOMES[run.outcome] as [string, string];

  const parts = [`[${outcomeColor}]■ ${outcomeLabel}[/${outcomeColor}]`];

  if (run.readCap && run.readEnd !== undefined && !run.readOff) {
    const start = run.readStart !== undefined ? run.readStart : run.readEnd;
    const color = run.readEnd >= run.readCap ? "green" : "yellow";
    const progress =
      start !== run.readEnd
        ? `${start} → [${color}]${run.readEnd}/${run.readCap}[/${color}]`
        : `[${color}]${run.readEnd}/${run.readCap}[/${color}]`;
    parts.push(`read ${progress}`);
  }

  if (run.target) {
    parts.push(`${run.read} artikel`);
  } else if (run.readOff) {
    parts.push("[dim]tanpa baca berita[/dim]");
  } else if (run.skipped) {
    parts.push(`[dim]baca dilewati · ${escape(run.skipped)}[/dim]`);
  }

  const before = run.before["daily"];
  const after = run.after["daily"];

  if (before && after) {
    parts.push(`daily ${escape(before)} → [bold]${escape(after)}[/bold]`);
  } else if (before) {
    parts.push(`daily ${escape(before)}`);
  }

  const earned = run.pointsEarned;

  if (earned) {
    parts.push(`[green]+${earned}[/green]`);
  }

  if (run.tabsClosed) {
    parts.push(`[dim]${run.tabsClosed} tab ditutup[/dim]`);
  }

  parts.push(`[dim]${formatDuration(run.duration)}[/dim]`);

  console.markup(GUTTER);
  console.markup("[dim]└[/dim] " + parts.join("   "));

  if (run.problem && (run.outcome === "error" || run.outcome === "partial")) {
    console.markup(`    [red]✗[/red] [dim]${escape(firstLine(run.problem, 70))}[/dim]`);
  }
}

/** One row per account, plus a row for each account not reached. */
function printMobileTable(runs: AccountRun[], pending: Array<[string, string]>): void {
  const earnedTotal = runs.reduce((sum, run) => sum + (run.pointsEarned ?? 0), 0);
  const readTotal = runs.reduce((sum, run) => sum + run.read, 0);

  const rows: string[][] = [];
  let number = 0;

  for (const run of runs) {
    number += 1;
    const daily = escape(run.after["daily"] || run.before["daily"] || "") || DASH;
    const earned = run.pointsEarned;

    rows.push([
      String(number),
      escape(run.email),
      MOBILE_STATUS[run.outcome] as string,
      checkinCell(run.rewards),
      activitiesCell(run.rewards),
      readCell(run),
      daily,
      earned ? `[green]+${earned}[/green]` : "[dim]0[/dim]",
      formatDuration(run.duration),
    ]);
  }

  for (const [, email] of pending) {
    number += 1;
    rows.push([String(number), escape(email), MOBILE_STATUS["pending"] as string, DASH, DASH, DASH, DASH, DASH, DASH]);
  }

  printTable(
    [
      { header: "#", align: "right", style: "dim" },
      { header: "Akun", align: "left", style: "bold white" },
      { header: "Status", align: "left" },
      // CI = daily check-in, Aktv = More activities counter.
      { header: "CI", align: "right" },
      { header: "Aktv", align: "right" },
      // Baca = Read to earn points (x/30), or articles when unknown.
      { header: "Baca", align: "right" },
      { header: "Daily", align: "right" },
      { header: "Poin", align: "right" },
      { header: "Waktu", align: "right", style: "dim" },
    ],
    rows,
    "  ",
    ["", "total", "", "", "", `${readTotal} art`, "", `[green]+${earnedTotal}[/green]`, ""],
  );
}

/** End-of-run recap for the phone; returns the accounts to check. */
export function mobileRecap(session: AccountSession, duration: number, interrupted = false): AccountRun[] {
  const runs = session.runs;
  const done = new Set(runs.map((run) => run.email));
  const pending = session.planned.filter(([, email]) => !done.has(email));
  const imperfect = runs.filter((run) => !run.ok);

  section("rekap mobile");

  if (runs.length || pending.length) {
    printMobileTable(runs, pending);
    console.print();
  }

  const read = runs.reduce((sum, run) => sum + run.read, 0);
  const full = runs.filter((run) => run.outcome === "full").length;

  field("artikel", `[bold white]${read}[/bold white] dibaca`);

  const goal = runs.filter((run) => run.readCap && run.readEnd !== undefined && !run.readOff);

  if (goal.length) {
    const fullRead = goal.filter((run) => (run.readEnd ?? 0) >= (run.readCap ?? 0)).length;
    field(
      "read",
      `[bold white]${fullRead}[/bold white]/${goal.length} akun read to earn penuh` +
        (fullRead < goal.length ? `   [yellow]${goal.length - fullRead} belum[/yellow]` : ""),
    );
  }

  const closed = runs.reduce((sum, run) => sum + (run.tabsClosed || 0), 0);

  if (closed) {
    field("tab", `[dim]${closed} tab ditutup[/dim]`);
  }

  field(
    "akun",
    `[bold white]${runs.length - imperfect.length}[/bold white]/${session.total} selesai` +
      (full ? `   [cyan]${full} tanpa baca (sudah penuh)[/cyan]` : "") +
      (pending.length ? `   [dim]${pending.length} belum dijalankan[/dim]` : ""),
  );
  field("reward", `[bold green]+${runs.reduce((sum, run) => sum + (run.pointsEarned ?? 0), 0)}[/bold green] poin`);
  field("durasi", formatDuration(duration));

  const retried = runs.filter((run) => run.attempt > 1);

  if (retried.length) {
    const fixed = retried.filter((run) => run.ok).length;
    field(
      "diulang",
      `${retried.length} akun   [green]${fixed} berhasil[/green]` +
        (fixed < retried.length ? `   [red]${retried.length - fixed} tetap gagal[/red]` : ""),
    );
  }

  if (session.missing.length) {
    field(
      "tidak ada",
      `[yellow]${escape(session.missing.join(", "))}[/yellow] [dim]· tidak login di aplikasi Bing[/dim]`,
    );
  }

  console.print();

  if (imperfect.length) {
    console.markup(`[yellow]![/yellow] [bold]Perlu dicek[/bold] [dim]· ${imperfect.length} akun belum tuntas[/dim]`);
    console.print();

    for (const run of imperfect) {
      const [color, label] = MOBILE_OUTCOMES[run.outcome] as [string, string];
      console.markup(
        `  [${color}]■[/${color}] [bold white]${escape(run.email)}[/bold white] [${color}]${label}[/${color}] ` +
          `[dim]· ${run.read}/${run.target} baca[/dim]`,
      );

      if (run.problem) {
        console.markup(`      [dim]${escape(firstLine(run.problem, 70))}[/dim]`);
      }
    }

    console.print();
  }

  if (interrupted) {
    console.markup("[yellow]‼[/yellow] Mobile dihentikan.");
  } else if (imperfect.length || pending.length) {
    console.markup(
      `[yellow]![/yellow] Mobile selesai · [dim]${imperfect.length + pending.length}/${session.total} akun belum tuntas[/dim]`,
    );
  } else {
    console.markup("[green]✓[/green] Mobile selesai · [dim]semua tugas akun selesai[/dim]");
  }

  console.print();

  return imperfect;
}
