import pc from "picocolors";
import { randomDelay, sleep } from "./utils/delay";
import { console, formatDuration, formatError } from "./utils/console";
import { closeRunningEdge } from "./utils/process";
import { createDriver } from "./driver/edge";
import { runBrowserTasks, type TaskFailure } from "./search/engine";
import { PROFILES, SEARCHES_PER_PROFILE } from "./config/settings";

interface ProfileReport {
  index: number;
  name: string;
  completed: number;
  failures: TaskFailure[];
  error?: string;
  durationMs: number;
}

function isPerfect(report: ProfileReport): boolean {
  return (
    !report.error &&
    report.failures.length === 0 &&
    report.completed >= SEARCHES_PER_PROFILE
  );
}

async function runProfile(
  index: number,
  name: string,
  total: number,
): Promise<ProfileReport> {
  const position = `${index + 1}/${total}`;
  const tag = `[${name}]`;
  const startedAt = Date.now();

  console.print();
  console.rule(`profile ${position}`);
  console.print(
    `${pc.cyan("▶")} ${pc.bold(name)} ${pc.cyan("· sedang mencari")} ${pc.dim(`(target ${SEARCHES_PER_PROFILE})`)}`,
  );
  console.setTitle(`edge-ts · ${position} · ${name} sedang mencari`);

  const report: ProfileReport = {
    index,
    name,
    completed: 0,
    failures: [],
    durationMs: 0,
  };

  let driver: Awaited<ReturnType<typeof createDriver>> | undefined;

  try {
    driver = await createDriver(name);

    const result = await runBrowserTasks(driver, SEARCHES_PER_PROFILE, tag);

    report.completed = result.completed;
    report.failures = result.failures;
    report.error = result.aborted;
  } catch (error) {
    report.error = formatError(error);
  } finally {
    if (driver) {
      try {
        await driver.quit();
      } catch {
        // Browser may already be gone.
      }
    }
  }

  report.durationMs = Date.now() - startedAt;

  const counts = `${report.completed}/${SEARCHES_PER_PROFILE} ok · ${report.failures.length} gagal · ${formatDuration(report.durationMs)}`;

  if (isPerfect(report)) {
    console.print(`${pc.green("■")} ${pc.bold(name)} ${pc.green("selesai")} ${pc.dim(`· ${counts}`)}`);
  } else if (report.error) {
    console.print(`${pc.red("■")} ${pc.bold(name)} ${pc.red("error")} ${pc.dim(`· ${counts}`)}`);
    console.dim(`  ${report.error}`);
  } else {
    console.print(`${pc.yellow("■")} ${pc.bold(name)} ${pc.yellow("tidak sempurna")} ${pc.dim(`· ${counts}`)}`);
  }

  return report;
}

function printSummary(reports: ProfileReport[], totalMs: number): void {
  const nameWidth = Math.max(7, ...reports.map((report) => report.name.length));
  const totalCompleted = reports.reduce((sum, r) => sum + r.completed, 0);
  const totalFailed = reports.reduce((sum, r) => sum + r.failures.length, 0);
  const imperfect = reports.filter((report) => !isPerfect(report));

  console.print();
  console.rule("rekap sesi");
  console.print();
  console.dim(
    `  ${"#".padStart(2)}  ${"profile".padEnd(nameWidth)}  ${"ok".padStart(5)}  ${"gagal".padStart(5)}  ${"durasi".padStart(7)}  status`,
  );

  for (const report of reports) {
    const status = isPerfect(report)
      ? pc.green("✓ sempurna")
      : report.error
        ? pc.red("✗ error")
        : pc.yellow("! tidak sempurna");

    const failed = String(report.failures.length).padStart(5);

    console.print(
      `  ${String(report.index + 1).padStart(2)}  ${report.name.padEnd(nameWidth)}  ${`${report.completed}/${SEARCHES_PER_PROFILE}`.padStart(5)}  ${report.failures.length > 0 ? pc.red(failed) : pc.dim(failed)}  ${pc.dim(formatDuration(report.durationMs).padStart(7))}  ${status}`,
    );
  }

  console.print();
  console.dim(`  total tugas berhasil  ${totalCompleted}/${reports.length * SEARCHES_PER_PROFILE}`);
  console.dim(`  total tugas gagal     ${totalFailed}`);
  console.dim(`  durasi sesi           ${formatDuration(totalMs)}`);

  console.print();

  if (imperfect.length === 0) {
    console.success(`✓ Semua ${reports.length} profile selesai sempurna.`);
    return;
  }

  console.warning(
    `! ${imperfect.length} dari ${reports.length} profile tidak sempurna:`,
  );

  for (const report of imperfect) {
    console.print();
    console.print(`  ${pc.bold(report.name)} ${pc.dim(`(${report.completed}/${SEARCHES_PER_PROFILE} ok)`)}`);

    if (report.error) {
      console.print(`    ${pc.red("error:")} ${report.error}`);
    }

    for (const failure of report.failures) {
      console.print(`    ${pc.red("✗")} ${failure.keyword} ${pc.dim(`· ${failure.reason}`)}`);
    }
  }
}

async function main(): Promise<void> {
  const totalProfiles = PROFILES.length;
  const sessionStart = Date.now();
  const reports: ProfileReport[] = [];

  console.print();
  console.print(pc.bold("Automated Browser · Selenium / Edge"));
  console.dim(`profiles  ${totalProfiles} (${PROFILES.join(", ")})`);
  console.dim(`target    ${SEARCHES_PER_PROFILE} tugas/profile`);

  await closeRunningEdge();

  for (let index = 0; index < totalProfiles; index++) {
    const profile = PROFILES[index];

    if (!profile) {
      continue;
    }

    reports.push(await runProfile(index, profile, totalProfiles));

    if (index < totalProfiles - 1) {
      const delay = randomDelay(10, 20);

      console.setTitle(`edge-ts · jeda sebelum profile ${index + 2}/${totalProfiles}`);
      console.dim(`  … jeda ${Math.round(delay)}s sebelum profile berikutnya`);

      await sleep(delay * 1000);
    }
  }

  console.setTitle("edge-ts · selesai");

  printSummary(reports, Date.now() - sessionStart);

  if (reports.some((report) => !isPerfect(report))) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.print();
  console.error(`✗ Fatal error · ${formatError(error)}`);

  process.exitCode = 1;
});
