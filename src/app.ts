import { randomDelay, sleep } from "./utils/delay.js";

import { console } from "./utils/console.js";

import { closeRunningEdge } from "./utils/process.js";

import { createDriver } from "./driver/edge.js";

import { runBrowserTasks } from "./search/engine.js";

import { PROFILES, SEARCHES_PER_PROFILE } from "./config/settings.js";

async function main(): Promise<void> {
  const totalProfiles = PROFILES.length;

  let totalTasks = 0;

  console.print();

  console.print("Automated Browser · Selenium / Edge");

  console.print();

  console.dim(`profiles  ${totalProfiles}`);

  console.dim(`target    ${SEARCHES_PER_PROFILE} tasks/profile`);

  console.print();

  await closeRunningEdge();

  for (let index = 0; index < totalProfiles; index++) {
    const profile = PROFILES[index];

    if (!profile) {
      continue;
    }

    console.dim(`profile ${index + 1}/${totalProfiles}`);

    let driver: Awaited<ReturnType<typeof createDriver>> | undefined;

    try {
      driver = await createDriver(profile);

      const completed = await runBrowserTasks(driver, SEARCHES_PER_PROFILE);

      totalTasks += completed;
    } catch (error) {
      console.print();

      console.error(`✗ Error · ${profile}`);

      console.dim(
        `  ${
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error)
        }`,
      );
    } finally {
      if (driver) {
        await driver.quit();
      }
    }

    if (index < totalProfiles - 1) {
      await sleep(randomDelay(10, 20) * 1000);
    }
  }

  console.print();

  console.print("Session Summary");

  console.dim(`  profiles processed  ${totalProfiles}`);

  console.dim(`  tasks completed     ${totalTasks}`);

  console.dim(
    `  average / profile   ${(totalTasks / totalProfiles).toFixed(1)}`,
  );

  console.print();

  console.success("✓ Session completed successfully.");
}

main().catch((error: unknown) => {
  console.print();

  console.error(
    `✗ Fatal error · ${
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }`,
  );

  process.exitCode = 1;
});
