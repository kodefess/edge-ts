/**
 * Bing Rewards automation.
 *
 * The rewards helper runs in a second browser tab while the normal search
 * session keeps running in the first one, so both tasks make progress in the
 * same profile without opening Edge twice (which would lock the profile).
 *
 * Construct the runner with the async factory, which reads the current
 * window handle as the search tab (Python did this in `__init__`):
 *
 *   const runner = await RewardsRunner.create(driver, result, onStatus);
 *
 * `new RewardsRunner(driver, result, searchHandle, onStatus)` also works
 * when the search handle is already known.
 */

export { RewardsRunner, RewardResult } from "./runner";
