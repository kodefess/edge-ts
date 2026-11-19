/**
 * Read to Earn in the Bing Android app through Appium (active account only).
 *
 * Usage:
 *   just mobile news
 *   just mobile news --count 3 --dwell-min 10
 *   just mobile news --dry-run
 *   just mobile news --from-xml "$env:TEMP\edgets-app.xml"
 *
 * The phone must be unlocked, show up in `adb devices`, and be signed in to
 * Bing with the Microsoft account that should get the points. Keep `just
 * mobile server` running in a second terminal.
 *
 * `--dry-run` opens the feed and lists the cards it would read without
 * tapping any. `--from-xml` needs no phone: it runs the card scanner on a
 * saved dump (`just mobile inspect` writes one) to check the selectors.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import {
  MOBILE_APP_DWELL_MAX,
  MOBILE_APP_DWELL_MIN,
  MOBILE_APP_MAX_SWIPES,
  MOBILE_APP_NEWS_MAX,
  MOBILE_APPIUM_APP_ACTIVITY,
  MOBILE_APPIUM_APP_PACKAGE,
  MOBILE_APPIUM_SERVER,
  MOBILE_APPIUM_UDID,
  MOBILE_APPIUM_WAIT,
} from "../config/settings";
import { type AppArticle, runAppNews, scanCards } from "../mobile/app-news";
import { AppiumUnavailable, parseHierarchy } from "../mobile/appium";
import { console } from "../utils/console";
import { InterruptedError, installInterruptHandler } from "../utils/interrupt";
import { escape } from "../utils/ui";

function int(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function scanFile(file: string, asJson: boolean): number {
  const nodes = parseHierarchy(fs.readFileSync(file, "utf-8"));
  const cards = scanCards(nodes, 0);

  console.markup(`[dim]${nodes.length} node · ${cards.length} kartu artikel[/dim]`);

  if (asJson) {
    console.print(JSON.stringify(cards.map((card) => card.asDict()), null, 2));
    return cards.length ? 0 : 1;
  }

  for (const [offset, card] of cards.entries()) {
    console.print(`${String(offset + 1).padStart(3)}  ${card.label.slice(0, 90)}`);
  }

  return cards.length ? 0 : 1;
}

function printArticles(articles: AppArticle[]): void {
  console.markup("[dim]  #  judul  dwell  swipe  status[/dim]");

  for (const [offset, article] of articles.entries()) {
    const dwell = article.dwell ? `${Math.round(article.dwell)}s` : "-";
    const status = article.ok ? "[green]✓[/green]" : `[red]✗[/red] ${escape(article.error)}`;
    console.markup(`${String(offset + 1).padStart(3)}  ${escape(article.label)}  ${dwell}  ${article.swipes || "-"}  ${status}`);
  }
}

async function main(): Promise<number> {
  installInterruptHandler();

  const { values } = parseArgs({
    options: {
      server: { type: "string", default: MOBILE_APPIUM_SERVER },
      udid: { type: "string", default: MOBILE_APPIUM_UDID },
      app: { type: "string", default: MOBILE_APPIUM_APP_PACKAGE },
      activity: { type: "string", default: MOBILE_APPIUM_APP_ACTIVITY },
      count: { type: "string" },
      "dwell-min": { type: "string" },
      "dwell-max": { type: "string" },
      "max-swipes": { type: "string" },
      wait: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "from-xml": { type: "string" },
      json: { type: "boolean", default: false },
    },
  });

  const count = int(values.count, MOBILE_APP_NEWS_MAX);
  const dwellMin = int(values["dwell-min"], MOBILE_APP_DWELL_MIN);
  const dwellMax = int(values["dwell-max"], MOBILE_APP_DWELL_MAX);

  if (dwellMin > dwellMax) {
    console.markup("[red]✗[/red] --dwell-min harus <= --dwell-max");
    return 2;
  }

  console.print();

  if (values["from-xml"]) {
    console.markup(`[bold]mobile app news[/bold]  [dim]· ${escape(values["from-xml"])}[/dim]`);
    console.print();
    return scanFile(values["from-xml"], values.json);
  }

  const mode = values["dry-run"] ? "dry-run" : `${count} artikel`;
  console.markup(`[bold]mobile app news[/bold]  [dim]· ${values.server} · ${values.app} · ${mode}[/dim]`);
  console.print();

  try {
    const result = await runAppNews({
      count,
      dwellMin,
      dwellMax,
      maxSwipes: int(values["max-swipes"], MOBILE_APP_MAX_SWIPES),
      server: values.server,
      udid: values.udid || null,
      package: values.app,
      activity: values.activity || null,
      wait: int(values.wait, MOBILE_APPIUM_WAIT),
      dryRun: values["dry-run"],
      log: (message) => console.markup(`[dim]${escape(message)}[/dim]`),
      onArticle: (article) => {
        const mark = article.ok ? "[green]✓[/green]" : "[red]✗[/red]";
        const extra = article.dwell ? `[dim]· ${Math.round(article.dwell)}s · ${article.swipes} swipe[/dim]` : "";
        console.markup(`${mark} ${escape(article.label)} ${extra}`);
      },
    });

    console.print();
    printArticles(result.articles);
    console.print();

    console.markup(`[bold]${result.read}[/bold]/${result.target} artikel` + (result.error ? `  [red]✗ ${escape(result.error)}[/red]` : ""));

    if (result.screenshot) console.markup(`[dim]screenshot · ${result.screenshot}[/dim]`);
    if (result.xml) console.markup(`[dim]xml · ${result.xml}[/dim]`);

    if (values.json) {
      console.print(
        JSON.stringify(
          { target: result.target, read: result.read, error: result.error, articles: result.articles.map((a) => a.asDict()) },
          null,
          2,
        ),
      );
    }

    return result.complete ? 0 : 1;
  } catch (error) {
    if (error instanceof AppiumUnavailable) {
      console.markup(`[red]✗[/red] ${escape(error.message)}`);
      return 1;
    }

    if (error instanceof InterruptedError) {
      console.markup("[yellow]![/yellow] dihentikan");
      return 130;
    }

    console.markup(
      `[red]✗[/red] ${escape(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`)}`,
    );
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
