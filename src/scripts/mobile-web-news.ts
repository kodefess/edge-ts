/**
 * Read a few MSN articles in a mobile-emulated Edge profile.
 *
 * Usage:
 *   just mobile web-news "Profile 1"
 *   just mobile web-news "Profile 1" --count 2 --visible
 *   just mobile web-news "Profile 1" --json
 *
 * It opens the public MSN feed and reads a few news cards the way a phone
 * user would: click a card, stay for a short dwell, go back to the feed,
 * scroll, and pick the next unused card. Ad boxes are skipped. Screenshots are
 * written to the temp folder.
 *
 * This command does not touch Bing Rewards and never kills a running Edge.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  MOBILE_DEVICE,
  MOBILE_NEWS_DWELL_MAX,
  MOBILE_NEWS_DWELL_MIN,
  MOBILE_NEWS_FEED_URL,
  MOBILE_NEWS_MAX,
  MOBILE_NEWS_SCROLL,
  MOBILE_PROBE_STRICT,
  PROFILES,
} from "../config/settings";
import { type MobileDriver, createMobileDriver } from "../mobile/browser";
import { DEFAULT_DEVICE, type Device, getDevice } from "../mobile/devices";
import { type NewsArticle, debugPage, dumpPage, readFeed } from "../mobile/news";
import { probe } from "../mobile/probe";
import { console } from "../utils/console";
import { escape } from "../utils/ui";

function int(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function printArticles(results: NewsArticle[]): void {
  console.markup("[dim]  #  judul  dwell  scroll  lebar  artikel[/dim]");

  for (const [offset, article] of results.entries()) {
    const status = article.ok ? "[green]✓[/green]" : "[red]✗[/red]";
    const hasArticle = article.hasArticle ? "[green]ya[/green]" : "[yellow]?[/yellow]";
    const width = article.layoutWidth;
    const widthLabel = !width ? "[dim]-[/dim]" : width <= 480 ? `[green]${width}[/green]` : `[yellow]${width}[/yellow]`;

    console.markup(
      `${String(offset + 1).padStart(3)}  ${escape(article.label)}  ${article.dwell.toFixed(1)}s  ${article.scrolls}  ${widthLabel}  ${hasArticle}  ${status}`,
    );
  }
}

/** Explain why the feed gave no readable card. */
async function reportEmpty(driver: MobileDriver, device: Device): Promise<void> {
  const info = await debugPage(driver);
  const stem = `edgets-news-empty-${device.key}`;
  let screenshot: string = path.join(os.tmpdir(), `${stem}.png`);
  const htmlPath = await dumpPage(driver, path.join(os.tmpdir(), `${stem}.html`));

  try {
    fs.writeFileSync(screenshot, await driver.takeScreenshot(), "base64");
  } catch {
    screenshot = "";
  }

  const rows: Array<[string, string]> = [
    ["url", info.url || "-"],
    ["judul", info.title || "-"],
    ["readyState", info.readyState || "-"],
    ["anchor", String(info.anchors)],
    ["anchor msn", String(info.msnAnchors)],
    ["shadow host", String(info.shadowHosts)],
    ["elemen", String(info.elements)],
    ["iframe", String(info.iframes)],
    ["teks", info.text || "-"],
  ];

  console.markup("[dim]diagnostik  nilai[/dim]");

  for (const [label, value] of rows) {
    console.markup(`${label.padEnd(12)}  ${escape(value)}`);
  }

  for (const href of (info.sample ?? []).slice(0, 8)) {
    console.markup(`[dim]· ${escape(String(href).slice(0, 110))}[/dim]`);
  }

  if (info.error) console.markup(`[red]✗[/red] ${escape(info.error)}`);
  if (screenshot) console.markup(`[dim]screenshot · ${screenshot}[/dim]`);
  if (htmlPath) console.markup(`[dim]html · ${htmlPath}[/dim]`);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      device: { type: "string" },
      url: { type: "string", default: MOBILE_NEWS_FEED_URL },
      count: { type: "string" },
      scrolls: { type: "string" },
      "dwell-min": { type: "string" },
      "dwell-max": { type: "string" },
      visible: { type: "boolean", default: false },
      strict: { type: "boolean" },
      "no-strict": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });

  let profile = values.profile ?? positionals[0];

  if (!profile) {
    if (PROFILES.length === 1) {
      profile = PROFILES[0];
    } else {
      console.markup("[red]✗[/red] Pilih profile dengan --profile.");
      console.markup(`[dim]PROFILES · ${PROFILES.join(", ")}[/dim]`);
      return 2;
    }
  }

  const count = int(values.count, MOBILE_NEWS_MAX);
  const scrolls = int(values.scrolls, MOBILE_NEWS_SCROLL);
  const dwellMin = int(values["dwell-min"], MOBILE_NEWS_DWELL_MIN);
  const dwellMax = int(values["dwell-max"], MOBILE_NEWS_DWELL_MAX);

  if (dwellMin < 1 || dwellMax < dwellMin) {
    console.markup("[red]✗[/red] dwell tidak valid · minimal 1 dan min <= max.");
    return 2;
  }

  if (count < 1 || scrolls < 1) {
    console.markup("[red]✗[/red] --count minimal 1, --scrolls minimal 1.");
    return 2;
  }

  let device: Device;

  try {
    device = getDevice(values.device || MOBILE_DEVICE || DEFAULT_DEVICE);
  } catch (error) {
    console.markup(`[red]✗[/red] ${escape(error instanceof Error ? error.message : String(error))}`);
    return 2;
  }

  const strict = values["no-strict"] ? false : (values.strict ?? MOBILE_PROBE_STRICT);
  const windowMode = values.visible ? "maximized" : "offscreen";

  console.print();
  console.markup(
    `[bold]mobile news[/bold]  [dim]· ${escape(profile!)} · ${device.name} · ${windowMode} · ${count} artikel · tahan ${dwellMin}–${dwellMax}s · scroll ${scrolls}[/dim]`,
  );
  console.markup(`[dim]feed · ${escape(values.url!)}[/dim]`);
  console.print();

  let driver: MobileDriver | undefined;

  try {
    driver = await createMobileDriver(profile!, device, undefined, windowMode);

    const check = await probe(driver, strict);

    console.markup(`[dim]probe · ${escape(check.summary())}[/dim]`);

    if (strict && !check.isMobile) {
      console.print();
      console.markup("[red]✗[/red] probe tidak lolos · baca artikel dibatalkan.");
      return 1;
    }

    console.markup("[dim]membuka feed dan membaca kartu berita…[/dim]");
    console.print();

    const results = await readFeed(driver, values.url!, {
      count,
      dwellMin,
      dwellMax,
      scrolls,
      screenshotDir: os.tmpdir(),
      onStatus: (markup) => console.markup(markup),
    });

    if (!results.length) {
      console.print();
      await reportEmpty(driver, device);
      console.print();
      console.markup("[red]✗[/red] tidak ada kartu berita yang bisa dibaca · lihat diagnostik di atas.");
      return 1;
    }

    printArticles(results);

    for (const article of results) {
      if (article.error) {
        console.markup(`[red]✗[/red] ${escape(article.label)} [dim]· ${escape(article.error)}[/dim]`);
      }

      if (article.screenshot) {
        console.markup(`[dim]screenshot · ${article.screenshot}[/dim]`);
      }
    }

    const wide = results.filter((article) => article.layoutWidth > 480);

    if (wide.length) {
      console.markup(`[yellow]![/yellow] ${wide.length} halaman tetap lebar (layout desktop dari penerbit, bukan emulasi).`);
    }

    if (values.json) {
      console.print(JSON.stringify(results.map((article) => article.asDict()), null, 2));
    }

    const ok = results.every((article) => article.ok);

    console.print();

    if (ok) {
      console.markup(`[green]✓[/green] ${results.length} artikel dibaca`);
    } else {
      console.markup("[red]✗[/red] sebagian artikel gagal · lihat tabel di atas");
    }

    return ok ? 0 : 1;
  } catch (error) {
    const message = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
    console.print();
    console.markup(`[red]✗[/red] ${escape(message)}`);

    if (message.toLowerCase().includes("user data directory is already in use")) {
      console.markup("[dim]Tutup Edge yang sedang memakai profile ini, lalu jalankan lagi.[/dim]");
    }

    return 1;
  } finally {
    await driver?.quit().catch(() => undefined);
  }
}

main().then((code) => {
  process.exitCode = code;
});
