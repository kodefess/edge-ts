/**
 * Status of every account, read from the Bing app on the phone.
 *
 * Usage:
 *   just recap
 *   just recap --accounts a@gmail.com,b@gmail.com
 *   just recap --json
 *
 * Read-only: switches accounts and opens the Rewards page, taps no task. The
 * phone holds the accounts of both PCs, so this is the combined view: check
 * in, the web tasks (Search 1 time, Daily set), Read to earn, More
 * activities, daily points (cap 120) and total, per account.
 */
import { parseArgs } from "node:util";

import {
  MOBILE_ADB_WIFI_AUTO,
  MOBILE_APP_ACCOUNTS,
  MOBILE_APPIUM_APP_PACKAGE,
  MOBILE_APPIUM_AUTOSTART,
  MOBILE_APPIUM_SERVER,
  MOBILE_APPIUM_UDID,
} from "../config/settings";
import { ensureConnected, isWireless } from "../mobile/adb-wifi";
import { dailyPoints } from "../mobile/app-accounts";
import { type AccountStatus, recapAccounts } from "../mobile/app-recap";
import { parseProgress } from "../mobile/app-rewards";
import { AppiumUnavailable, createAppDriver } from "../mobile/appium";
import { AppiumServer } from "../mobile/appium-server";
import { console } from "../utils/console";
import { InterruptedError, installInterruptHandler } from "../utils/interrupt";
import * as ui from "../utils/ui";

const DASH = "[dim]–[/dim]";
const escape = ui.escape;

function flag(value: boolean | null | undefined): string {
  if (value === true) return "[green]✓[/green]";
  if (value === false) return "[red]✗[/red]";
  return "[dim]?[/dim]";
}

function ratio(text: string): string {
  if (text === "✓") return "[green]✓[/green]";

  const [done, total] = parseProgress(text || "");

  if (done === undefined) return DASH;

  const color = done >= (total ?? 0) ? "green" : "yellow";
  return `[${color}]${escape(text)}[/${color}]`;
}

function dailyCell(text: string): string {
  const [earned, cap] = dailyPoints({ daily: text });

  if (earned === undefined) return DASH;

  const color = earned >= (cap ?? 0) ? "green" : "yellow";
  return `[${color}]${escape(text)}[/${color}]`;
}

function points(value: number | undefined): string {
  return value === undefined ? DASH : value.toLocaleString("en-US").replace(/,/g, ".");
}

function liveLine(index: number, total: number, status: AccountStatus): void {
  const width = String(total).length;
  const position = `${String(index).padStart(width)}/${total}`;

  if (status.error) {
    console.markup(
      `  [red]✗[/red] [dim]${position}[/dim]  ${escape(status.email)}  [dim]· ${escape(ui.firstLine(status.error, 50))}[/dim]`,
    );
    return;
  }

  const mark = status.complete ? "[green]✓[/green]" : "[yellow]![/yellow]";
  const todo = status.missing.join(", ");

  console.markup(
    `  ${mark} [dim]${position}[/dim]  ${escape(status.email)}  [dim]· daily ${escape(status.daily || "?")}${todo ? ` · kurang: ${escape(todo)}` : ""}[/dim]`,
  );
}

function printResults(results: AccountStatus[]): void {
  const rows = results.map((r, offset) =>
    r.error
      ? [String(offset + 1), escape(r.email), "[red]✗[/red]", DASH, DASH, DASH, DASH, DASH, DASH]
      : [
          String(offset + 1),
          escape(r.email),
          flag(r.checkin),
          flag(r.search),
          flag(r.dailySet),
          ratio(r.read),
          ratio(r.activities),
          dailyCell(r.daily),
          points(r.total),
        ],
  );

  ui.printTable(
    [
      { header: "#", align: "right", style: "dim" },
      { header: "Akun", align: "left", style: "bold white" },
      { header: "CI", align: "right" },
      { header: "Srch", align: "right" },
      { header: "DSet", align: "right" },
      { header: "Read", align: "right" },
      { header: "Aktv", align: "right" },
      { header: "Daily", align: "right" },
      { header: "Total", align: "right", style: "cyan" },
    ],
    rows,
    "  ",
    ["", "total", "", "", "", "", "", "", points(results.reduce((sum, r) => sum + (r.total ?? 0), 0))],
  );
}

async function main(): Promise<number> {
  installInterruptHandler();

  const { values } = parseArgs({
    options: {
      accounts: { type: "string", default: MOBILE_APP_ACCOUNTS.join(",") },
      server: { type: "string", default: MOBILE_APPIUM_SERVER },
      udid: { type: "string", default: MOBILE_APPIUM_UDID },
      "no-restore": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  const wanted = (values.accounts ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  ui.banner();
  ui.section("rekap semua akun");

  let udid = values.udid ?? "";

  if (MOBILE_ADB_WIFI_AUTO) {
    const serial = await ensureConnected((message) => ui.field("adb", `[dim]${message}[/dim]`));

    if (serial) {
      ui.field("hp", `${serial}  [dim]· ${isWireless(serial) ? "wifi" : "usb"}[/dim]`);
      udid = udid || serial;
    }
  }

  const started = Date.now();
  let results: AccountStatus[] = [];
  let missing: string[] = [];

  const appium = new AppiumServer(values.server ?? MOBILE_APPIUM_SERVER, MOBILE_APPIUM_AUTOSTART, (message) =>
    ui.field("appium", `[dim]${message}[/dim]`),
  );

  try {
    await appium.start();

    const driver = await createAppDriver({ server: values.server, udid: udid || null });

    try {
      const recap = await recapAccounts(driver, {
        accounts: wanted,
        package: MOBILE_APPIUM_APP_PACKAGE,
        restore: !values["no-restore"],
        onPlan: (count) => {
          ui.field("akun", `[bold white]${count}[/bold white]  [dim]· hanya membaca, tidak mengerjakan tugas[/dim]`);
          console.print();
        },
        onStatus: (index, total, status) => {
          results.push(status);
          liveLine(index, total, status);
        },
      });

      results = recap.results;
      missing = recap.missing;
    } finally {
      await driver.quit().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof AppiumUnavailable) {
      console.markup(`[red]✗[/red] ${escape(error.message)}`);
      return 1;
    }

    if (error instanceof InterruptedError) {
      console.markup("\n[yellow]‼[/yellow] dihentikan");

      if (!results.length) {
        return 130;
      }
    } else {
      console.markup(
        `[red]✗[/red] ${escape(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`)}`,
      );
      return 1;
    }
  } finally {
    appium.stop();
  }

  ui.section("rekap");

  if (results.length) {
    printResults(results);
    console.markup(
      "  [dim]CI check in · Srch search 1x (web) · DSet daily set (web) · Read read to earn · Aktv more activities[/dim]",
    );
    console.print();
  }

  const done = results.filter((r) => r.complete);
  const todo = results.filter((r) => !r.complete);

  ui.field("lengkap", `[bold white]${done.length}[/bold white]/${results.length} akun`);
  ui.field("durasi", ui.formatDuration((Date.now() - started) / 1000));

  if (missing.length) {
    ui.field("tidak ada", `[yellow]${escape(missing.join(", "))}[/yellow]`);
  }

  console.print();

  if (todo.length) {
    console.markup(`[yellow]![/yellow] [bold]Belum selesai[/bold] [dim]· ${todo.length} akun[/dim]`);
    console.print();

    for (const r of todo) {
      console.markup(`  [yellow]■[/yellow] [bold white]${escape(r.email)}[/bold white]`);
      console.markup(`      [dim]${escape(r.missing.join(", "))}[/dim]`);
    }

    console.print();
    console.markup(
      `  [dim]Tugas HP:[/dim]  just mobile run --accounts "${todo.filter((r) => !r.error).map((r) => r.email).join(",")}"`,
    );
    console.print();
  } else if (results.length) {
    console.markup("[green]✓[/green] Semua akun lengkap hari ini.");
    console.print();
  }

  if (values.json) {
    console.print(JSON.stringify(results.map((r) => r.asDict()), null, 2));
  }

  return results.length && !todo.length ? 0 : 1;
}

main().then((code) => {
  process.exitCode = code;
});
