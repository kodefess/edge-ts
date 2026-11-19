/**
 * Run the desktop app's quest for each saved account.
 *
 * Per account: swap its session in, start the app with a debug port, attach
 * Selenium, do the quest, detach, close the app and save the session back (the
 * app refreshed its cookies while it ran).
 */
import { DESKTOP_WINDOW_MODE } from "../config/settings";
import { InterruptedError } from "../utils/interrupt";
import * as app from "./app";
import * as devtools from "./devtools";
import * as profiles from "./profiles";
import { Connection, QuestResult, findQuest, readActivities, runQuest } from "./quest";
import { Offscreen } from "./window";

type Log = ((message: string) => void) | undefined;

export class DesktopRun {
  quest: QuestResult | undefined;
  error = "";
  duration = 0;

  constructor(readonly name: string) {}

  get outcome(): "ok" | "partial" | "error" {
    if (this.error) return "error";
    if (!this.quest) return "error";
    if (this.quest.error) return "partial";
    return "ok";
  }
}

/** Close the stuck app and attach to a freshly started one. */
async function restart(conn: Connection): Promise<void> {
  await devtools.detach(conn.driver);
  await app.stop();
  const port = await devtools.startWithDebugging();
  conn.driver = await devtools.attach(port);
}

export async function runAccount(name: string, log?: Log, dryRun = false): Promise<DesktopRun> {
  const run = new DesktopRun(name);
  const started = Date.now();
  let conn: Connection | undefined;

  try {
    await profiles.use(name);

    const port = await devtools.startWithDebugging();
    conn = await Connection.create(await devtools.attach(port), restart);
    const driver = conn.driver;

    if (dryRun) {
      const quest = await findQuest(driver);
      run.quest = new QuestResult();

      if (quest) {
        run.quest.title = (quest.text || "").slice(0, 60);
        await driver.get(quest.href);
        const data = await readActivities(driver);
        run.quest.statusBefore = run.quest.statusAfter = data.status || "";
        const open = data.items.filter((i) => i.open).map((i) => i.title);
        run.quest.note = open.length ? `terbuka: ${open.join(", ")}` : "tidak ada aktivitas terbuka hari ini";
      } else {
        run.quest.note = "quest desktop tidak ada di Earn";
      }
    } else {
      run.quest = await runQuest(conn, log);
    }
  } catch (error) {
    if (error instanceof InterruptedError) {
      throw error;
    }

    // The next account still runs.
    const text = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
    run.error = text.split(/\r?\n/)[0]!.slice(0, 200);
  } finally {
    if (conn?.driver) {
      await devtools.detach(conn.driver);
    }

    await app.stop();

    // Keep the cookies the app refreshed during the run.
    try {
      if (profiles.active() === name) {
        await profiles.save(name);
      }
    } catch (error) {
      run.error = run.error || `simpan sesi: ${error instanceof Error ? error.message : String(error)}`;
    }

    run.duration = (Date.now() - started) / 1000;
  }

  return run;
}

export interface RunAccountsOptions {
  log?: Log;
  onStart?: (name: string, index: number, total: number) => void;
  onDone?: (run: DesktopRun) => void;
  dryRun?: boolean;
  /** undefined = DESKTOP_WINDOW_MODE. */
  offscreen?: boolean;
}

export async function runAccounts(names: string[], options: RunAccountsOptions = {}): Promise<DesktopRun[]> {
  await devtools.clearLeftover();
  const runs: DesktopRun[] = [];

  const offscreen = options.offscreen ?? DESKTOP_WINDOW_MODE === "offscreen";

  // One keeper for the whole run: it also catches the windows of every restart
  // and of the app opened for the next account.
  const keeper = new Offscreen(offscreen).start();

  try {
    for (const [offset, name] of names.entries()) {
      options.onStart?.(name, offset + 1, names.length);
      const run = await runAccount(name, options.log, options.dryRun ?? false);
      runs.push(run);
      options.onDone?.(run);
    }
  } finally {
    keeper.stop();
  }

  return runs;
}
