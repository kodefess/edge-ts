/**
 * Read-only status of every Bing app account (`just recap`).
 *
 * The phone holds every account (home PC + office PC profiles), so it is the
 * one place that sees all of them. For each account this opens the profile
 * page and the Rewards page and reads, without doing any task:
 *
 * - **Total / Daily points** (profile page; daily caps at 120).
 * - **Check in**: row collapsed with "N ✓" = done; expanded with today's
 *   circle open = not yet.
 * - **Search 1 time** and **Daily set** streak rows: the web tasks (PC
 *   searches and daily set) as the Rewards page sees them. Done rows show a
 *   green ✓ next to the value; the accessibility tree has no such flag, so the
 *   screenshot is checked for green pixels at that spot.
 * - **Read to earn** (x/30) and **More activities** (x/15).
 */
import zlib from "node:zlib";

import { sleep } from "../utils/delay";
import { InterruptedError } from "../utils/interrupt";
import {
  dailyPoints,
  listAccounts,
  openProfilePage,
  parsePoints,
  readProfileStats,
  returnHome,
  selectAccounts,
  switchAccount,
} from "./app-accounts";
import type { Log } from "./app-news";
import { activitiesSection, checkinState, labelled, openRewardsPage, parseProgress, readToEarn } from "./app-rewards";
import { type AppiumDriver, type UiNode, readNodes, swipeUp } from "./appium";

export class AccountStatus {
  name = "";
  total: number | undefined;
  daily = "";
  streak = "";
  checkin: boolean | undefined;
  search: boolean | null | undefined;
  dailySet: boolean | null | undefined;
  read = "";
  activities = "";
  error = "";
  seconds = 0;
  notes: string[] = [];

  constructor(
    readonly email: string,
    name = "",
  ) {
    this.name = name;
  }

  /** Human list of what is still open for today. */
  get missing(): string[] {
    const todo: string[] = [];

    if (this.error) {
      return [`tidak terbaca: ${this.error}`];
    }

    if (this.checkin === false) todo.push("check in");
    if (this.search === false) todo.push("search (web)");
    if (this.dailySet === false) todo.push("daily set (web)");

    const [readDone, readTotal] = parseProgress(this.read);
    if (readDone !== undefined && readDone < (readTotal ?? 0)) {
      todo.push(`baca ${this.read}`);
    }

    const [actDone, actTotal] = parseProgress(this.activities);
    if (actDone !== undefined && actDone < (actTotal ?? 0)) {
      todo.push(`more activities ${this.activities}`);
    }

    const [earned, cap] = dailyPoints({ daily: this.daily });
    if (earned !== undefined && cap && earned < cap && !todo.length) {
      todo.push(`daily ${this.daily}`);
    }

    return todo;
  }

  get complete(): boolean {
    return !this.error && !this.missing.length;
  }

  asDict(): Record<string, unknown> {
    return {
      email: this.email,
      name: this.name,
      total: this.total ?? null,
      daily: this.daily,
      streak: this.streak,
      checkin: this.checkin ?? null,
      search: this.search ?? null,
      daily_set: this.dailySet ?? null,
      read: this.read,
      activities: this.activities,
      complete: this.complete,
      missing: this.missing,
      error: this.error,
    };
  }
}

// ============================================================
// Green check detection
// ============================================================

export interface Image {
  width: number;
  height: number;
  /** 4 bytes per pixel (RGBA). */
  data: Buffer;
}

/** Minimal PNG decoder (8-bit, non-interlaced, grey/RGB/RGBA): enough for phone screenshots. */
export function decodePng(png: Buffer): Image {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const parts: Buffer[] = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) {
        throw new Error("unsupported PNG (need 8-bit, non-interlaced)");
      }
      colorType = body[9]!;
    } else if (type === "IDAT") {
      parts.push(body);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;

  if (!channels) {
    throw new Error("unsupported PNG color type");
  }

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]!;
    const line = Buffer.from(raw.subarray(cursor + 1, cursor + 1 + stride));
    cursor += 1 + stride;

    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels]! : 0;
      const up = previous[i]!;
      const upLeft = i >= channels ? previous[i - channels]! : 0;
      let add = 0;

      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }

      line[i] = (line[i]! + add) & 0xff;
    }

    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;

      if (channels === 1) {
        pixels[target] = pixels[target + 1] = pixels[target + 2] = line[x]!;
      } else {
        pixels[target] = line[x * channels]!;
        pixels[target + 1] = line[x * channels + 1]!;
        pixels[target + 2] = line[x * channels + 2]!;
      }
      pixels[target + 3] = 255;
    }

    previous = line;
  }

  return { width, height, data: pixels };
}

async function screenshot(driver: AppiumDriver): Promise<Image | undefined> {
  try {
    return decodePng(await driver.screenshotPng());
  } catch {
    return undefined;
  }
}

function isGreen(r: number, g: number, b: number): boolean {
  return g > 140 && g - r > 60 && g - b > 10;
}

/** True when a green ✓ sits right after `node` (a row's value). */
export function greenCheckAfter(image: Image | undefined, node: UiNode | undefined, width = 48): boolean | null {
  if (!image || !node) {
    return null;
  }

  const [, y1, x2, y2] = node.rect;
  const left = x2 + 2;
  const right = Math.min(image.width, x2 + width);
  const top = Math.max(0, y1);
  const bottom = Math.min(image.height, y2);

  if (right <= left || bottom <= top) {
    return null;
  }

  let green = 0;

  for (let x = left; x < right; x += 2) {
    for (let y = top; y < bottom; y += 2) {
      const at = (y * image.width + x) * 4;

      if (isGreen(image.data[at]!, image.data[at + 1]!, image.data[at + 2]!)) {
        green += 1;
      }
    }
  }

  return green >= 6;
}

/** The number shown on a collapsed streak row ("100", "50"). */
function rowValue(nodes: UiNode[], headingLabel: string): UiNode | undefined {
  const heading = labelled(nodes, headingLabel).find((n) => !n.clickable);

  if (!heading) {
    return undefined;
  }

  const cy = Math.floor((heading.rect[1] + heading.rect[3]) / 2);

  return nodes.find(
    (n) =>
      n !== heading &&
      Math.abs(n.y - cy) <= 24 &&
      [...n.label].filter((ch) => ch >= "0" && ch <= "9").join("") === n.label.trim() &&
      n.label.trim() !== "",
  );
}

// ============================================================
// One account
// ============================================================

export async function readStatus(
  driver: AppiumDriver,
  status: AccountStatus,
  profileNodes: UiNode[],
  log?: Log,
): Promise<void> {
  const stats = readProfileStats(profileNodes);
  status.total = parsePoints(stats["total"]);
  status.daily = stats["daily"] ?? "";
  status.streak = stats["streak"] ?? "";

  await openRewardsPage(driver, profileNodes, 25, 3, log);

  // Let the streak circles render before judging the Check in row.
  await sleep(1500);
  let nodes = await readNodes(driver);

  const [state] = checkinState(nodes);
  const image = await screenshot(driver);

  if (state === "pending") {
    status.checkin = false;
  } else if (state === "done") {
    status.checkin = true;
  }

  status.search = greenCheckAfter(image, rowValue(nodes, "Search 1 time"));
  status.dailySet = greenCheckAfter(image, rowValue(nodes, "Daily set"));

  // Daily activities and More activities sit below the fold.
  for (let i = 0; i < 5; i += 1) {
    const [earned, cap] = readToEarn(nodes);

    if (earned !== undefined && !status.read) {
      status.read = `${earned}/${cap}`;
    }

    const [progress] = activitiesSection(nodes);

    if (progress && !status.activities) {
      status.activities = progress;
    }

    if (status.read && status.activities) break;

    await swipeUp(driver, 0.45);
    await sleep(1000);
    nodes = await readNodes(driver);
  }

  // The Read to earn card disappears once it is finished (30/30), while More
  // activities stays listed with its counter.
  if (!status.read && status.activities) {
    status.read = "✓";
  }
}

export interface RecapOptions {
  accounts?: string[];
  package?: string;
  restore?: boolean;
  log?: Log;
  onPlan?: (total: number) => void;
  onStatus?: (index: number, total: number, status: AccountStatus) => void;
}

/** Status of every account (or `accounts`), in app order. */
export async function recapAccounts(
  driver: AppiumDriver,
  options: RecapOptions = {},
): Promise<{ results: AccountStatus[]; missing: string[] }> {
  const { accounts = [], restore = true, log, onPlan, onStatus } = options;
  const pkg = options.package;

  const available = await listAccounts(driver, pkg, log);
  const original = available[0]?.[1] ?? "";
  const [targets, missing] = selectAccounts(available, accounts);

  onPlan?.(targets.length);

  const results: AccountStatus[] = [];

  try {
    for (const [offset, [name, email]] of targets.entries()) {
      const status = new AccountStatus(email, name);
      const started = Date.now();

      try {
        const profile = await switchAccount(driver, email, pkg, log);
        await readStatus(driver, status, profile, log);
      } catch (error) {
        if (error instanceof InterruptedError) {
          throw error;
        }

        // The next account still runs.
        status.error = `${error instanceof Error ? error.name : "Error"}: ${error instanceof Error ? error.message : String(error)}`;
      }

      status.seconds = (Date.now() - started) / 1000;
      results.push(status);

      onStatus?.(offset + 1, targets.length, status);
    }
  } finally {
    if (restore && original && results.length) {
      try {
        await switchAccount(driver, original, pkg, log);
        await returnHome(driver);
      } catch {
        // Ignore.
      }
    }
  }

  return { results, missing };
}
