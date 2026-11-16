/**
 * Terminal layout for the search session (port of edge-py utils/ui.py).
 *
 * Every line the session prints goes through here so the look stays
 * consistent:
 *
 *     ── sesi ───────────────────────────────
 *
 *     ┌ Profile 1                         1/24
 *     │ ▶ sedang mencari · target 5
 *     │
 *     │   ✓  1/5   how to create email reminders
 *     │   ✗  2/5   how to analyze ... · TimeoutError
 *     │
 *     └ ■ selesai   4/5 pencarian   1 gagal   1m42s
 *         ✗ 2/5  how to analyze ... · TimeoutError
 */
import pc from "picocolors";

import { console, escapeMarkup as escape, renderMarkup, stripAnsi } from "./console";

import type { RewardResult } from "../rewards";
import type { ProfileResult } from "../search/engine";

export { escape };

export const AUTHOR = "kodefess/yuxxeun";
export const REPO_URL = "https://github.com/kodefess/edge-ts";

/** Width of rules and profile headers. Kept modest so the layout looks the same on wide terminals. */
const LAYOUT_WIDTH = 64;

const GUTTER = "[dim]│[/dim]";

function terminalWidth(): number {
  return process.stdout.columns || 100;
}

function width(): number {
  return Math.max(30, Math.min(terminalWidth(), LAYOUT_WIDTH));
}

/** Cuts a rendered (ANSI) line to `max` visible characters, ending with "…". */
function truncateAnsi(text: string, max: number): string {
  if (stripAnsi(text).length <= max) {
    return text;
  }

  let visible = 0;
  let output = "";

  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      output += text.slice(i, end + 1);
      i = end;
      continue;
    }

    if (visible >= max - 1) {
      break;
    }

    output += text[i];
    visible++;
  }

  return `${output}…\x1b[0m`;
}

/** console.print(markup, no_wrap=True, overflow="ellipsis") */
function printLine(markup: string): void {
  activityPause(() => console.print(truncateAnsi(renderMarkup(markup), terminalWidth() - 1)));
}

/** Format seconds as '1h02m', '8m03s' or '12s'. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  if (hours) return `${hours}h${pad(minutes)}m`;
  if (minutes) return `${minutes}m${pad(secs)}s`;
  return `${secs}s`;
}

/** Shorten long Selenium messages to a single readable line. */
export function firstLine(text: string | undefined, limit = 70): string {
  const trimmed = (text ?? "").trim();
  let line = trimmed ? (trimmed.split(/\r?\n/)[0] ?? "") : "";

  if (line.length > limit) {
    line = `${line.slice(0, limit - 1)}…`;
  }

  return line;
}

// ============================================================
// BANNER
// ============================================================

const LETTERS: Record<string, string[]> = {
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  "-": ["      ", "      ", "█████╗", "╚════╝", "      ", "      "],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
};

/** Print the big EDGE-TS logo with author and repository. */
export function banner(word = "EDGE-TS"): void {
  const rows = Array.from({ length: 6 }, (_, row) =>
    [...word].map((char) => LETTERS[char]?.[row] ?? "").join(""),
  );

  console.print();

  if (terminalWidth() >= (rows[0]?.length ?? 0) + 2) {
    for (const row of rows) {
      // Solid blocks bright, box-drawing "shadow" darker.
      const line = [...row].map((char) => (char === "█" ? pc.bold(pc.cyan(char)) : pc.cyan(pc.dim(char)))).join("");
      console.print(`  ${line}`);
    }
  } else {
    console.markup(`  [bold cyan]${word}[/bold cyan]`);
  }

  console.print();
  console.markup(
    `  [dim]by[/dim] [bold white]${AUTHOR}[/bold white]   [dim]·[/dim]   [dim underline]${REPO_URL}[/dim underline]`,
  );
  console.markup("  [dim]Automated Browser · Selenium / Edge[/dim]");
  console.print();
}

// ============================================================
// SECTIONS
// ============================================================

/** ── title ───────────────────── */
export function section(title: string): void {
  const label = `── ${title} `;
  const fill = "─".repeat(Math.max(4, width() - label.length));

  console.print();
  console.markup(`[dim]${label}${fill}[/dim]`);
  console.print();
}

/**   label     value */
export function field(label: string, value: string): void {
  console.markup(`  [dim]${label.padEnd(10)}[/dim] ${value}`);
}

/** Profiles laid out in columns:  · Profile 1   · Profile 2 ... */
export function profileGrid(profiles: string[]): void {
  if (profiles.length === 0) {
    return;
  }

  const cell = Math.max(...profiles.map((profile) => profile.length)) + 4;
  const columns = Math.max(1, Math.min(6, Math.floor((terminalWidth() - 4) / cell)));

  for (let start = 0; start < profiles.length; start += columns) {
    let line = "    ";

    for (const name of profiles.slice(start, start + columns)) {
      line += `[dim]·[/dim] ${escape(name)}${" ".repeat(cell - 2 - name.length)}`;
    }

    printLine(line.trimEnd());
  }
}

// ============================================================
// PROFILE BLOCK
// ============================================================

/**
 * ┌ Profile 1  (email)                1/24
 * │ ▶ sedang mencari · target 5
 * │
 */
export function profileHeader(name: string, index: number, total: number, target: number, email = ""): void {
  const position = `${index}/${total}`;
  let label = escape(name);

  if (email) {
    label += ` [dim](${escape(email)})[/dim]`;
  }

  const visible = name + (email ? ` (${email})` : "");
  const gap = " ".repeat(Math.max(2, width() - 2 - visible.length - position.length));

  console.print();
  printLine(`[dim]┌[/dim] [bold white]${label}[/bold white]${gap}[dim]${position}[/dim]`);
  console.markup(`${GUTTER} [cyan]▶ sedang mencari[/cyan] [dim]· target ${target}[/dim]`);
  console.markup(GUTTER);
}

function counter(number: number, total: number): string {
  return `${String(number).padStart(String(total).length)}/${total}`;
}

export function searchOk(number: number, total: number, keyword: string): void {
  printLine(`${GUTTER}   [green]✓[/green]  [dim]${counter(number, total)}[/dim]   ${escape(keyword)}`);
}

export function searchFailed(number: number, total: number, keyword: string, errorName: string): void {
  printLine(
    `${GUTTER}   [red]✗[/red]  [dim]${counter(number, total)}[/dim]   ` +
      `[red]${escape(keyword)}[/red] [dim]· ${escape(errorName)}[/dim]`,
  );
}

/** │   ! message */
export function profileNote(message: string, icon = "!", color = "yellow"): void {
  activityPause(() => console.markup(`${GUTTER}   [${color}]${icon}[/${color}]  ${message}`));
}

/** │   ★  reward · message */
export function rewardNote(message: string): void {
  activityPause(() => {
    console.markup(`${GUTTER}   [magenta]★[/magenta]  [dim]reward ·[/dim] ${escape(message)}`);
  });
}

/** Detailed per-profile rewards breakdown. */
function rewardFooter(reward: RewardResult | undefined, indent = "    "): void {
  if (!reward || !reward.enabled) {
    return;
  }

  const account = reward.accountEmail.trim() || reward.accountName.trim();

  if (account) {
    console.markup(`${indent}[dim]akun[/dim]  ${escape(account)}`);
  }

  if (reward.signedOut) {
    console.markup(`${indent}[yellow]![/yellow] [dim]belum login rewards[/dim]`);
    return;
  }

  // points
  const ps = reward.pointsStart;
  const pe = reward.pointsEnd;
  const earned = reward.pointsEarned;

  if (ps !== undefined || pe !== undefined || earned) {
    const pts: string[] = [];
    if (ps !== undefined) pts.push(`awal ${ps}`);
    if (pe !== undefined) pts.push(`akhir ${pe}`);
    if (earned) pts.push(`[green]+${earned}[/green]`);
    console.markup(`${indent}[dim]poin[/dim]  ${pts.join("  ·  ")}`);
  }

  // daily set
  if (reward.dailyTotal || reward.dailyDone) {
    let line = `${reward.dailyDone}/${reward.dailyTotal} selesai`;
    if (reward.dailyPoints) line += `  [green]+${reward.dailyPoints} poin[/green]`;
    console.markup(`${indent}[dim]daily set[/dim]  ${line}`);
  }

  // ready to claim
  if (reward.claims || reward.claimPoints || reward.readyToClaimStart) {
    let line = reward.claims ? `${reward.claims} klaim` : "[red]gagal[/red]";
    if (reward.claimPoints) line += `  [green]+${reward.claimPoints} poin[/green]`;
    if (reward.claimLeft) line += `  [yellow]${reward.claimLeft} poin belum terklaim[/yellow]`;
    console.markup(`${indent}[dim]ready claim[/dim]  ${line}`);
  } else if (reward.claimChecked) {
    console.markup(`${indent}[dim]ready claim[/dim]  [dim]tidak ada poin untuk diklaim[/dim]`);
  }

  // photo
  if (reward.photoFound || reward.photoCompleted || reward.photoAttempts) {
    const status = reward.photoCompleted ? "[green]✓ selesai[/green]" : "[yellow]belum[/yellow]";
    const extra: string[] = [];
    if (reward.photoAttempts) extra.push(`${reward.photoAttempts} percobaan`);
    if (reward.photoPoints) extra.push(`[green]+${reward.photoPoints} poin[/green]`);
    const line = status + (extra.length ? `  [dim](${extra.join(" · ")})[/dim]` : "");
    console.markup(`${indent}[dim]foto search[/dim]  ${line}`);
  }

  // perks
  if (reward.perksFound) {
    console.markup(`${indent}[dim]your perks[/dim]  ${reward.perksDone}/${reward.perksTotal}`);
  }

  // keep earning
  if (reward.earnTotal || reward.earnDone) {
    let line = `${reward.earnDone}/${reward.earnTotal} selesai`;
    if (reward.earnPoints) line += `  [green]+${reward.earnPoints} poin[/green]`;
    console.markup(`${indent}[dim]keep earning[/dim]  ${line}`);
  }

  if (reward.error) {
    console.markup(`${indent}[red]✗ reward error[/red] [dim]${escape(firstLine(reward.error))}[/dim]`);
  }
}

/** Footer label and colour per outcome. */
const OUTCOMES: Record<ProfileResult["outcome"], [string, string]> = {
  ok: ["green", "selesai"],
  // Target reached, but some attempts failed along the way.
  partial: ["yellow", "selesai"],
  stopped: ["yellow", "berhenti"],
  error: ["red", "error"],
  interrupted: ["yellow", "dihentikan"],
};

/**
 * │
 * └ ■ selesai   5/5 pencarian   0 gagal   1m42s
 *     (reward breakdown)
 */
export function profileFooter(result: ProfileResult): void {
  const [color, label] = OUTCOMES[result.outcome];
  const failed = result.failedSearches ? `[red]${result.failedSearches} gagal[/red]` : "[dim]0 gagal[/dim]";

  console.markup(GUTTER);
  console.markup(
    `[dim]└[/dim] [${color}]■ ${label}[/${color}]   ` +
      `[bold white]${result.searches}/${result.target} pencarian[/bold white]   ` +
      `${failed}   [dim]${formatDuration(result.duration)}[/dim]`,
  );

  rewardFooter(result.reward);
  printProblems(result, "    ");
  console.print();
}

/** List failed searches and the profile error, if any. */
function printProblems(result: ProfileResult, indent: string, limit?: number): void {
  const failures = result.failures;
  const shown = limit === undefined ? failures : failures.slice(0, limit);

  for (const failure of shown) {
    printLine(
      `${indent}[red]✗[/red] [dim]${counter(failure.attempt, result.target)}[/dim]  ` +
        `${escape(failure.keyword)} [dim]· ${escape(failure.error)}[/dim]`,
    );
  }

  const hidden = failures.length - shown.length;

  if (hidden > 0) {
    console.markup(`${indent}[dim]… dan ${hidden} tugas gagal lainnya[/dim]`);
  }

  if (result.error) {
    printLine(`${indent}[red]✗[/red] [dim]${escape(firstLine(result.error))}[/dim]`);
  }
}

export function pause(seconds: number): void {
  console.markup(`  [dim]… jeda ${seconds.toFixed(0)}s sebelum profile berikutnya[/dim]`);
}

// ============================================================
// ACTIVITY (live spinner line)
// ============================================================

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

let activeActivity: Activity | undefined;

/** Clears the live line while `print` runs, then redraws it (so permanent lines never mix with it). */
function activityPause(print: () => void): void {
  activeActivity?.clear();
  print();
  activeActivity?.render();
}

/**
 * Animated line under the profile block showing what is happening.
 *
 *   │   ⠋ mengetik how to write ... · 2/5
 *
 * Only shown on an interactive terminal; it disappears when stopped, so log
 * files contain just the permanent lines.
 */
export class Activity {
  private text = "";
  private frame = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly enabled = Boolean(process.stdout.isTTY);

  constructor(markup = "") {
    // Set the text before the first frame, so it never shows a spinner with no label.
    this.update(markup);
  }

  update(markup: string): void {
    this.text = renderMarkup(markup);

    if (this.timer) {
      this.render();
    }
  }

  start(markup?: string): this {
    if (markup !== undefined) {
      this.update(markup);
    }

    if (this.enabled && !this.timer) {
      activeActivity?.stop();
      activeActivity = this;
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER.length;
        this.render();
      }, 80);
      this.timer.unref();
      this.render();
    }

    return this;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.clear();
    }

    if (activeActivity === this) {
      activeActivity = undefined;
    }
  }

  /** Runs `task` with the spinner shown, like Python's `with ui.Activity(...)`. */
  async run<T>(task: () => Promise<T>): Promise<T> {
    this.start();

    try {
      return await task();
    } finally {
      this.stop();
    }
  }

  render(): void {
    if (!this.timer) return;

    // Keep the activity on one line: long keywords are cut with "…" instead
    // of wrapping, which would leave stray lines behind.
    const label = truncateAnsi(this.text, Math.max(10, terminalWidth() - 4 - 2 - 1));
    process.stdout.write(`\r${renderMarkup(GUTTER)}   ${pc.cyan(SPINNER[this.frame] ?? "")} ${label}\x1b[K`);
  }

  clear(): void {
    if (this.timer) {
      process.stdout.write("\r\x1b[K");
    }
  }
}

/** Prints a permanent line without breaking the live activity line. */
export function printAbove(print: () => void): void {
  activityPause(print);
}

// ============================================================
// SESSION RECAP
// ============================================================

const TABLE_STATUS: Record<ProfileResult["outcome"], string> = {
  ok: "[green]✓ selesai[/green]",
  partial: "[yellow]! ada gagal[/yellow]",
  stopped: "[yellow]! berhenti[/yellow]",
  error: "[red]✗ error[/red]",
  interrupted: "[yellow]‼ dihentikan[/yellow]",
};

type Column = { header: string; align: "left" | "right"; style?: string };

/** Minimal port of rich's Table(box=SIMPLE_HEAD, show_edge=False). */
function printTable(columns: Column[], rows: string[][], indent = "  "): void {
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...rows.map((row) => stripAnsi(renderMarkup(row[index] ?? "")).length)),
  );

  const cell = (text: string, index: number) => {
    const column = columns[index] as Column;
    const rendered = renderMarkup(column.style ? `[${column.style}]${text}[/${column.style}]` : text);
    const padding = " ".repeat(Math.max(0, (widths[index] ?? 0) - stripAnsi(rendered).length));

    return column.align === "right" ? padding + rendered : rendered + padding;
  };

  const header = columns
    .map((column, index) => {
      const padded = column.align === "right" ? column.header.padStart(widths[index] ?? 0) : column.header.padEnd(widths[index] ?? 0);
      return pc.dim(padded);
    })
    .join("  ");

  console.print(`${indent}${header}`);
  console.print(`${indent}${pc.dim(widths.map((w) => "─".repeat(w)).join("──"))}`);

  for (const row of rows) {
    console.print(`${indent}${row.map(cell).join("  ")}`);
  }
}

/** Print the end-of-session recap; returns the imperfect profiles. */
export function sessionRecap(
  results: ProfileResult[],
  totalProfiles: number,
  duration: number,
  interrupted: boolean,
): ProfileResult[] {
  const totalSearches = results.reduce((sum, r) => sum + r.searches, 0);
  const totalTarget = results.reduce((sum, r) => sum + r.target, 0);
  const totalFailed = results.reduce((sum, r) => sum + r.failedSearches, 0);
  const imperfect = results.filter((r) => !r.isPerfect);
  const skipped = totalProfiles - results.length;

  section("rekap");

  if (results.length) {
    printTable(
      [
        { header: "#", align: "right", style: "dim" },
        { header: "Profile", align: "left", style: "bold white" },
        { header: "Status", align: "left" },
        { header: "Tugas", align: "right" },
        { header: "Gagal", align: "right" },
        { header: "Waktu", align: "right", style: "dim" },
      ],
      results.map((r, index) => [
        String(index + 1),
        escape(r.profile),
        TABLE_STATUS[r.outcome],
        `${r.searches}/${r.target}`,
        r.failedSearches ? `[red]${r.failedSearches}[/red]` : "[dim]0[/dim]",
        formatDuration(r.duration),
      ]),
    );
    console.print();
  }

  field(
    "tugas",
    `[bold white]${totalSearches}[/bold white]/${totalTarget} ok` +
      (totalFailed ? `   [red]${totalFailed} gagal[/red]` : "   [dim]0 gagal[/dim]"),
  );
  field("profile", `[bold white]${results.length - imperfect.length}[/bold white]/${totalProfiles} sempurna`);
  field("durasi", formatDuration(duration));

  // --------------------------------------------------------
  // Rewards totals
  // --------------------------------------------------------

  const rewards = results.map((r) => r.reward).filter((r): r is RewardResult => Boolean(r?.enabled));

  if (rewards.length) {
    const sum = (pick: (r: RewardResult) => number) => rewards.reduce((total, r) => total + pick(r), 0);

    const totalClaims = sum((r) => r.claims);
    const totalClaimPts = sum((r) => r.claimPoints);
    const totalDailyDone = sum((r) => r.dailyDone);
    const totalDailyTotal = sum((r) => r.dailyTotal);
    const totalDailyPts = sum((r) => r.dailyPoints);
    const totalPhoto = sum((r) => (r.photoCompleted ? 1 : 0));
    const totalPhotoPts = sum((r) => r.photoPoints);
    const totalEarnDone = sum((r) => r.earnDone);
    const totalEarnTotal = sum((r) => r.earnTotal);
    const totalEarnPts = sum((r) => r.earnPoints);
    const totalPoints = sum((r) => r.pointsEarned);

    const parts: string[] = [];

    if (totalDailyTotal || totalDailyDone) {
      parts.push(`daily ${totalDailyDone}/${totalDailyTotal}${totalDailyPts ? ` (+${totalDailyPts})` : ""}`);
    }
    if (totalClaims || totalClaimPts) {
      parts.push(`klaim ${totalClaims}${totalClaimPts ? ` (+${totalClaimPts})` : ""}`);
    }
    if (totalPhoto || totalPhotoPts) {
      parts.push(`foto ${totalPhoto}${totalPhotoPts ? ` (+${totalPhotoPts})` : ""}`);
    }
    if (totalEarnTotal || totalEarnDone) {
      parts.push(`earn ${totalEarnDone}/${totalEarnTotal}${totalEarnPts ? ` (+${totalEarnPts})` : ""}`);
    }
    if (totalPoints) {
      parts.push(`[green]+${totalPoints} poin total[/green]`);
    }

    if (parts.length) {
      field("reward", `[bold white]${parts.join("  ·  ")}[/bold white]`);
    }

    // per-profile reward summary (email + key stats)
    console.print();
    console.markup("  [dim]Reward per profile[/dim]");

    for (const r of results) {
      const rw = r.reward;

      if (!rw || !rw.enabled) continue;

      const account = (rw.accountEmail || rw.accountName || "-").trim();
      const ds = `${rw.dailyDone}/${rw.dailyTotal}`;
      const cl = `${rw.claims}(+${rw.claimPoints})`;
      const ph = rw.photoCompleted ? "✓" : rw.photoFound ? "✗" : "-";
      const er = `${rw.earnDone}/${rw.earnTotal}`;

      printLine(
        `    [bold]${escape(r.profile)}[/bold] [dim]·[/dim] ${escape(account)}` +
          ` [dim]│ daily[/dim] ${ds} [dim]│ klaim[/dim] ${cl} [dim]│ foto[/dim] ${ph}` +
          ` [dim]│ earn[/dim] ${er} [dim]│ +poin[/dim] [green]${rw.pointsEarned}[/green]`,
      );
    }
  }

  if (skipped) {
    field("dilewati", `${skipped} profile belum dijalankan`);
  }

  console.print();

  // --------------------------------------------------------
  // Profiles that need attention
  // --------------------------------------------------------

  if (imperfect.length) {
    console.markup(
      `[yellow]![/yellow] [bold]Perlu dicek[/bold] [dim]· ${imperfect.length} profile ada tugas gagal[/dim]`,
    );
    console.print();

    for (const r of imperfect) {
      const [color, label] = OUTCOMES[r.outcome];

      console.markup(
        `  [${color}]■[/${color}] [bold white]${escape(r.profile)}[/bold white] ` +
          `[${color}]${label}[/${color}] [dim]· ${r.searches}/${r.target} ok · ${r.failedSearches} gagal[/dim]`,
      );

      printProblems(r, "      ", 5);
    }

    console.print();
  }

  if (interrupted) {
    console.markup("[yellow]‼[/yellow] Sesi dihentikan.");
  } else if (imperfect.length) {
    console.markup(
      `[yellow]![/yellow] Sesi selesai · [dim]${imperfect.length}/${totalProfiles} profile tidak sempurna[/dim]`,
    );
  } else {
    console.markup("[green]✓[/green] Sesi selesai · [dim]semua tugas berhasil[/dim]");
  }

  console.print();

  return imperfect;
}
