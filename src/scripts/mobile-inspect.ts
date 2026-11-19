/**
 * Inspect the Bing Android app through Appium.
 *
 * Usage:
 *   just mobile inspect
 *   just mobile inspect --udid R58M123ABC --tap "Rewards"
 *   just mobile inspect --json
 *
 * It connects to the phone, opens the Bing app, and dumps the accessibility
 * tree and a screenshot so selectors can be derived from a real screen. The
 * phone must be unlocked, have USB debugging enabled, and be signed in.
 */
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  MOBILE_APPIUM_APP_ACTIVITY,
  MOBILE_APPIUM_APP_PACKAGE,
  MOBILE_APPIUM_SERVER,
  MOBILE_APPIUM_UDID,
} from "../config/settings";
import {
  type UiNode,
  AppiumUnavailable,
  createAppDriver,
  describeSession,
  dumpHierarchy,
  dumpScreenshot,
  launchApp,
  readNodes,
  swipeUp,
  tapWords,
  visibleLabels,
} from "../mobile/appium";
import { sleep } from "../utils/delay";
import { console } from "../utils/console";
import { escape } from "../utils/ui";

function printNodes(nodes: UiNode[], limit: number): void {
  console.markup("[dim]  #  label  class  id  tap[/dim]");

  const shown = nodes.slice(0, limit);

  for (const [offset, node] of shown.entries()) {
    console.markup(
      `${String(offset + 1).padStart(3)}  ${escape(node.label || "-")}  ${escape(node.className.split(".").pop() || "-")}  ` +
        `${escape(node.resourceId || "-")}  ${node.clickable ? "[green]ya[/green]" : "[dim]-[/dim]"}`,
    );
  }

  if (nodes.length > shown.length) {
    console.markup(`[dim]… ${nodes.length - shown.length} node lain tidak ditampilkan (pakai --limit)[/dim]`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      server: { type: "string", default: MOBILE_APPIUM_SERVER },
      udid: { type: "string", default: MOBILE_APPIUM_UDID },
      app: { type: "string", default: MOBILE_APPIUM_APP_PACKAGE },
      activity: { type: "string", default: MOBILE_APPIUM_APP_ACTIVITY },
      "no-launch": { type: "boolean", default: false },
      tap: { type: "string", multiple: true, default: [] },
      scroll: { type: "string", default: "0" },
      wait: { type: "string", default: "2" },
      limit: { type: "string", default: "60" },
      json: { type: "boolean", default: false },
    },
  });

  const wait = Math.max(0, Number(values.wait) || 0);
  const limit = Math.max(1, Number.parseInt(values.limit ?? "60", 10) || 60);

  console.print();
  console.markup(`[bold]mobile app[/bold]  [dim]· ${values.server} · ${values.app}[/dim]`);
  console.print();

  let driver: Awaited<ReturnType<typeof createAppDriver>> | undefined;

  try {
    driver = await createAppDriver({
      server: values.server,
      udid: values.udid || null,
      appPackage: values.app,
      appActivity: values.activity || null,
    });

    if (!values["no-launch"] && !(await launchApp(driver, values.app))) {
      console.markup(`[yellow]![/yellow] tidak bisa membuka ${values.app} · periksa apakah aplikasi terpasang.`);
    }

    await sleep(wait * 1000);

    for (const word of values.tap ?? []) {
      const node = await tapWords(driver, [word]);

      if (node) {
        console.markup(`[dim]tap · ${escape(node.label.slice(0, 50))}[/dim]`);
      } else {
        console.markup(`[yellow]![/yellow] tidak menemukan teks ${escape(word)} yang bisa ditekan`);
      }

      await sleep(Math.max(0.5, wait) * 1000);
    }

    for (let i = 0; i < Math.max(0, Number.parseInt(values.scroll ?? "0", 10) || 0); i += 1) {
      await swipeUp(driver);
      await sleep(600);
    }

    const info = await describeSession(driver);
    // Raw screen, system dialogs included: this is the inspector.
    const nodes = await readNodes(driver, false);

    console.markup(`[dim]package[/dim]  ${escape(info.package || "-")}`);
    console.markup(`[dim]layar[/dim]    ${info.width}×${info.height}`);

    for (const [key, value] of Object.entries(info.capabilities)) {
      console.markup(`[dim]${key}[/dim]  ${escape(String(value))}`);
    }

    const labels = visibleLabels(nodes);
    console.markup(`[dim]${nodes.length} node · ${labels.length} label unik[/dim]`);
    console.print();

    printNodes(labels, limit);

    const screenshot = await dumpScreenshot(driver, path.join(os.tmpdir(), "edgets-app.png"));
    const xml = await dumpHierarchy(driver, path.join(os.tmpdir(), "edgets-app.xml"));

    if (screenshot) console.markup(`[dim]screenshot · ${screenshot}[/dim]`);
    if (xml) console.markup(`[dim]xml · ${xml}[/dim]`);

    if (values.json) {
      console.print(JSON.stringify({ session: info, nodes: nodes.map((node) => node.asDict()) }, null, 2));
    }

    return 0;
  } catch (error) {
    if (error instanceof AppiumUnavailable) {
      console.markup(`[red]✗[/red] ${escape(error.message)}`);
      return 1;
    }

    console.markup(
      `[red]✗[/red] ${escape(`${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`)}`,
    );
    return 1;
  } finally {
    await driver?.quit().catch(() => undefined);
  }
}

main().then((code) => {
  process.exitCode = code;
});
