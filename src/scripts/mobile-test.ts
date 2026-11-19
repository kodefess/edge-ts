/**
 * Open one Edge profile as a phone and verify what the page sees.
 *
 * Usage:
 *   just mobile web-test "Profile 1"
 *   just mobile web-test "Profile 1" --device galaxy_s23 --visible
 *
 * The DevTools overrides are per tab, so the probe runs twice: on the tab the
 * driver starts with, and on a second tab opened through `openMobileTab`. Both
 * must look like a phone before the mobile pass can be trusted.
 *
 * This command never touches the desktop session and never kills a running
 * Edge. Close Edge yourself if the profile copy is locked.
 */
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import fs from "node:fs";

import { MOBILE_DEVICE, MOBILE_PROBE_STRICT, PROFILES } from "../config/settings";
import { createMobileDriver, openMobileTab } from "../mobile/browser";
import { DEFAULT_DEVICE, deviceNames, getDevice } from "../mobile/devices";
import { type ProbeResult, probe } from "../mobile/probe";
import { console } from "../utils/console";
import { escape } from "../utils/ui";

const DEFAULT_URL = "https://example.com/";

function printProbe(title: string, result: ProbeResult): void {
  console.rule(title);

  if (result.error) {
    console.markup(`[red]✗[/red] ${escape(result.error)}`);
    return;
  }

  console.markup("[dim]cek  nilai[/dim]");

  for (const check of result.checks) {
    const mark = check.passed ? "[green]✓[/green]" : check.required ? "[red]✗[/red]" : "[dim]–[/dim]";
    const label = check.required ? check.label : `${check.label} [dim](info)[/dim]`;
    console.markup(`  ${label}  ${mark}  ${escape(check.detail)}`);
  }

  const style = result.isMobile ? "green" : "red";
  console.markup(`[${style}]${escape(result.summary())}[/${style}]`);
  console.markup(`[dim]${escape(result.url)}[/dim]`);
  console.print();
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      profile: { type: "string" },
      device: { type: "string" },
      url: { type: "string", default: DEFAULT_URL },
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

  let device;

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
    `[bold]mobile probe[/bold]  [dim]· ${escape(profile!)} · ${device.name} · ${windowMode} · strict=${strict ? "ya" : "tidak"}[/dim]`,
  );
  console.markup(`[dim]UA · ${device.userAgent}[/dim]`);
  console.print();

  let driver: Awaited<ReturnType<typeof createMobileDriver>> | undefined;
  const results: Array<[string, ProbeResult]> = [];

  try {
    driver = await createMobileDriver(profile!, device, undefined, windowMode);

    await driver.get(values.url!);
    results.push(["tab 1", await probe(driver, strict)]);

    // New tabs need the CDP overrides again; this proves that helper.
    await openMobileTab(driver);
    await driver.get(values.url!);
    results.push(["tab 2", await probe(driver, strict)]);

    for (const [title, result] of results) {
      printProbe(title, result);
    }

    const screenshot = path.join(os.tmpdir(), `edgets-mobile-${device.key}.png`);

    try {
      fs.writeFileSync(screenshot, await driver.takeScreenshot(), "base64");
      console.markup(`[dim]screenshot · ${screenshot}[/dim]`);
    } catch (error) {
      console.markup(`[yellow]screenshot gagal[/yellow] [dim]· ${error instanceof Error ? error.name : "Error"}[/dim]`);
    }

    if (values.json) {
      console.print(JSON.stringify(Object.fromEntries(results.map(([title, result]) => [title, result.asDict()])), null, 2));
    }

    const ok = results.every(([, result]) => result.isMobile);

    console.print();

    if (ok) {
      console.markup("[green]✓[/green] mobile terdeteksi di semua tab");
    } else {
      console.markup("[red]✗[/red] probe belum lolos · mobile pass sebaiknya tidak dijalankan dulu");
    }

    return ok ? 0 : 1;
  } catch (error) {
    const message = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
    console.print();
    console.markup(`[red]✗[/red] ${escape(message)}`);

    const lowered = message.toLowerCase();

    if (lowered.includes("user data directory is already in use") || lowered.includes("target window already exists")) {
      console.markup("[dim]Tutup Edge yang sedang memakai profile ini, lalu jalankan lagi.[/dim]");
    } else if (lowered.includes("unknown mobile device")) {
      console.markup(`[dim]Pilihan device · ${deviceNames()}[/dim]`);
    }

    return 1;
  } finally {
    await driver?.quit().catch(() => undefined);
  }
}

main().then((code) => {
  process.exitCode = code;
});
