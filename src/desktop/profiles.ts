/**
 * One saved WebView2 folder per account, swapped into the app.
 *
 * Layout under `DESKTOP_PROFILES_DIR`:
 *
 *     <name>/EBWebView/      the account's sign-in (cookies, storage)
 *     <name>/saved_at        when it was last saved
 *     _backup/<stamp>/       the live folder whenever a swap would lose it
 *     active                 name of the profile now in the app
 *     pending                name given to `new`, until it is saved
 *
 * Rules that keep a session from being lost:
 *
 * - the app is always closed before the folder is touched;
 * - the live folder is saved back to the active profile before another is
 *   swapped in, because the app refreshes its cookies while it runs;
 * - a live folder that belongs to no known profile is moved to `_backup`
 *   instead of being deleted; when `new NAME` started it, it is saved as
 *   `NAME` instead (`save` forgotten before the next `new`);
 * - the live folder is only saved back to the active profile when it is still
 *   the session this module put there: `live.json` keeps a fingerprint of its
 *   cookie store from the last swap or save. A different fingerprint means the
 *   app was used outside these commands (for example another account signed in
 *   by hand), so the folder goes to `_backup` instead of overwriting a profile
 *   with the wrong account.
 */
import fs from "node:fs";
import path from "node:path";

import { DESKTOP_PROFILES_DIR } from "../config/settings";
import * as app from "./app";

/** Caches WebView2 rebuilds on its own; leaving them out keeps a profile small without touching the sign-in. */
const SKIP_DIRS = new Set([
  "cache", "code cache", "gpucache", "grshadercache", "gpupersistentcache", "shadercache",
  "dawncache", "dawngraphitecache", "dawnwebgpucache", "crashpad", "component_crx_cache",
  "extensions_crx_cache",
]);

const SKIP_FILES = /^(lockfile|.*\.tmp|browsermetrics.*\.pma)$/i;

const NAME = /^[\w.@+-]{1,80}$/;

/** A swap that cannot be done safely. */
export class ProfileError extends Error {
  override name = "ProfileError";
}

export interface Profile {
  name: string;
  path: string;
  savedAt: string;
  sizeMb: number;
  webview: string;
}

// ============================================================
// Store
// ============================================================

export function root(): string {
  return DESKTOP_PROFILES_DIR;
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function checkName(raw: string): string {
  const name = (raw ?? "").trim();

  if (!NAME.test(name) || name.startsWith("_")) {
    throw new ProfileError(`nama profil tidak valid: ${JSON.stringify(name)} (huruf, angka, . @ + - _)`);
  }

  return name;
}

function sizeMb(folder: string): number {
  let total = 0;

  const walk = (current: string): void => {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {
          // Locked or gone.
        }
      }
    }
  };

  walk(folder);
  return total / (1024 * 1024);
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8").trim();
  } catch {
    return "";
  }
}

export function get(name: string): Profile | undefined {
  const folder = path.join(root(), name);

  if (!isDir(path.join(folder, "EBWebView"))) {
    return undefined;
  }

  return {
    name,
    path: folder,
    savedAt: readText(path.join(folder, "saved_at")),
    sizeMb: sizeMb(folder),
    webview: path.join(folder, "EBWebView"),
  };
}

export function listProfiles(): Profile[] {
  if (!isDir(root())) {
    return [];
  }

  const found: Profile[] = [];

  for (const name of fs.readdirSync(root()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    if (name.startsWith("_")) continue;

    const profile = get(name);

    if (profile) found.push(profile);
  }

  return found;
}

export function active(): string {
  return readText(path.join(root(), "active"));
}

function setActive(name: string): void {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(path.join(root(), "active"), name || "");
}

/** Name given to `new` whose sign-in has not been saved yet. */
export function pending(): string {
  return readText(path.join(root(), "pending"));
}

function setPending(name: string): void {
  const file = path.join(root(), "pending");

  if (name) {
    fs.mkdirSync(root(), { recursive: true });
    fs.writeFileSync(file, name);
  } else if (fs.existsSync(file)) {
    fs.rmSync(file);
  }
}

// ============================================================
// Copy helpers
// ============================================================

/** Copy a WebView2 folder without caches, through a temporary folder so a failed copy never leaves a half-written `target`. */
function copyFolder(source: string, target: string): void {
  const temp = `${target}.partial`;

  fs.rmSync(temp, { recursive: true, force: true });
  fs.cpSync(source, temp, {
    recursive: true,
    filter: (item) => {
      const name = path.basename(item);

      if (item === source) return true;
      if (SKIP_FILES.test(name)) return false;

      return !(SKIP_DIRS.has(name.toLowerCase()) && isDir(item));
    },
  });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(temp, target);
}

function moveFolder(source: string, target: string): void {
  try {
    fs.renameSync(source, target);
  } catch {
    // Different drives: copy, then remove.
    fs.cpSync(source, target, { recursive: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

/** Move the live folder into `_backup` and return where it went. */
function backupLive(reason: string): string {
  const live = app.webviewDir();

  if (!isDir(live)) {
    return "";
  }

  const target = path.join(root(), "_backup", `${stamp()}-${reason}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  moveFolder(live, target);
  return target;
}

/** Size and change time of the app's cookie store, or null. */
function fingerprint(): [number, number] | null {
  try {
    const info = fs.statSync(path.join(app.webviewDir(), "Default", "Network", "Cookies"), { bigint: true });
    return [Number(info.size), Number(info.mtimeNs)];
  } catch {
    return null;
  }
}

/** Remember that the live folder is `name`'s, as it is right now. */
function mark(name: string): void {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(path.join(root(), "live.json"), JSON.stringify({ profile: name || "", fingerprint: fingerprint() }));
}

/** True when the live folder is still the one marked for `name`. */
function trusted(name: string): boolean {
  let stored: { profile?: string; fingerprint?: [number, number] | null };

  try {
    stored = JSON.parse(fs.readFileSync(path.join(root(), "live.json"), "utf-8"));
  } catch {
    return false;
  }

  const current = fingerprint();

  return (
    Boolean(name) &&
    stored.profile === name &&
    stored.fingerprint !== null &&
    stored.fingerprint !== undefined &&
    current !== null &&
    stored.fingerprint[0] === current[0] &&
    stored.fingerprint[1] === current[1]
  );
}

async function requireClosed(): Promise<void> {
  if (!(await app.stop())) {
    throw new ProfileError("app Microsoft Rewards tidak bisa ditutup");
  }
}

// ============================================================
// Operations
// ============================================================

/**
 * Copy the app's live sign-in into profile `name` and mark it active. Used
 * once per account right after signing in, and after every run so the
 * refreshed cookies are kept.
 */
export async function save(rawName: string): Promise<Profile> {
  const name = checkName(rawName);
  const live = app.webviewDir();

  if (!isDir(live)) {
    throw new ProfileError("folder sesi app belum ada (app belum pernah dibuka)");
  }

  await requireClosed();

  const folder = path.join(root(), name);
  fs.mkdirSync(folder, { recursive: true });
  copyFolder(live, path.join(folder, "EBWebView"));

  fs.writeFileSync(path.join(folder, "saved_at"), timestamp());

  setActive(name);
  mark(name);

  if (pending() === name) {
    setPending("");
  }

  return get(name) as Profile;
}

/** Keep the live session of the active profile before a swap. Returns a note for the log. */
async function saveBack(): Promise<string> {
  const current = active();
  const live = app.webviewDir();

  if (!isDir(live)) {
    return "";
  }

  if (current && get(current) && trusted(current)) {
    await save(current);
    return `sesi ${current} disimpan`;
  }

  if (current && get(current)) {
    // The app was used outside these commands since the last swap: the
    // session may be another account. Keep it, but not as `current`.
    const where = backupLive(`berubah-di-luar-${current}`);
    return `sesi di app berubah di luar script (bukan dari profil ${current}) · dipindah ke ${where}`;
  }

  const waiting = pending();

  if (!current && waiting && !get(waiting) && fingerprint() !== null) {
    // `new NAME` emptied the app, the account signed in, but `save` was not
    // run: keep it under the name it was meant to have.
    await save(waiting);
    return `sesi ${waiting} belum di-save · disimpan otomatis`;
  }

  const where = backupLive("tanpa-profil");
  return `sesi tanpa profil dipindah ke ${where}`;
}

/** Put profile `name` into the app (the app stays closed). Returns `[profile, note]`. */
export async function use(rawName: string): Promise<[Profile, string]> {
  const name = checkName(rawName);
  const target = get(name);

  if (!target) {
    throw new ProfileError(`profil ${name} belum disimpan`);
  }

  await requireClosed();

  const live = app.webviewDir();

  // Already in the app and untouched since: its live cookies are newer than
  // the saved copy.
  if (active() === name && isDir(live) && trusted(name)) {
    return [target, "sudah aktif"];
  }

  const note = await saveBack();
  fs.mkdirSync(path.dirname(live), { recursive: true });
  copyFolder(target.webview, live);
  setActive(name);
  mark(name);
  return [target, note];
}

/**
 * Empty the app's session so another account can sign in. The current session
 * is saved back first; after signing in, run `save(name)`. Returns a note for
 * the log.
 */
export async function create(rawName: string): Promise<string> {
  const name = checkName(rawName);

  if (get(name)) {
    throw new ProfileError(`profil ${name} sudah ada; pakai \`use ${name}\``);
  }

  await requireClosed();
  const note = await saveBack();

  const live = app.webviewDir();

  if (isDir(live)) {
    // saveBack copied it; the live one can go.
    fs.rmSync(live, { recursive: true, force: true });
  }

  setActive("");
  mark("");
  setPending(name);
  return note;
}

// ============================================================
// Backups
// ============================================================

const EMAIL = /[a-z0-9._%+-]{3,60}@(?:gmail|outlook|hotmail|live|yahoo)\.(?:com|co\.id|co\.uk|net)(?![a-z])/g;

/** Where WebView2 keeps the signed-in account's address. */
const EMAIL_SOURCES = ["local storage", "session storage", "indexeddb", "preferences", "web data"];

/** Account addresses stored in a WebView2 folder. */
export function emailsIn(folder: string): string[] {
  let found = new Set<string>();

  const walk = (current: string): void => {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries.filter((entry) => entry.isFile());
    const relevant =
      EMAIL_SOURCES.some((part) => current.toLowerCase().includes(part)) ||
      files.some((file) => ["preferences", "web data"].includes(file.name.toLowerCase()));

    if (relevant) {
      for (const file of files) {
        const full = path.join(current, file.name);
        let data: string;

        try {
          if (fs.statSync(full).size > 20 * 1024 * 1024) continue;
          data = fs.readFileSync(full).toString("latin1").toLowerCase();
        } catch {
          continue;
        }

        for (const match of data.matchAll(EMAIL)) {
          // LevelDB glues key names and numbers in front of the address
          // ("-27600…bsmnt005@…", "usernameentrybsmnt005@…").
          const address = match[0].replace(/^(?:-?\d+|usernameentry|entry|ntry)+/, "");

          if (address.split("@")[0]!.length >= 3) {
            found.add(address);
          }
        }
      }
    }

    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
    }
  };

  walk(folder);

  // A cut-off copy ("nt005@…") is the tail of the full address.
  const all = [...found];
  found = new Set(all.filter((address) => !all.some((other) => other !== address && other.endsWith(address))));

  return [...found].sort();
}

/** `[name, path, emails]` of `_backup`, newest first. */
export function backups(): Array<[string, string, string[]]> {
  const base = path.join(root(), "_backup");

  if (!isDir(base)) {
    return [];
  }

  const items: Array<[string, string, string[]]> = [];

  for (const name of fs.readdirSync(base).sort().reverse()) {
    const folder = path.join(base, name);

    if (isDir(folder)) {
      items.push([name, folder, emailsIn(folder)]);
    }
  }

  return items;
}

/**
 * Save a backed-up session as profile `name`. `backup` is a folder name under
 * `_backup`; without it the newest backup that holds the address `name` is
 * used. The app is not touched.
 */
export function restore(rawName: string, backup = ""): [Profile, string] {
  const name = checkName(rawName);

  if (get(name)) {
    throw new ProfileError(`profil ${name} sudah ada`);
  }

  const found = backups().filter((item) => (backup ? item[0] === backup : item[2].includes(name.toLowerCase())));

  if (!found.length) {
    throw new ProfileError(`tidak ada backup untuk ${name}` + (backup ? "" : " (cek `just desktop backups`)"));
  }

  const [source, sourcePath] = [found[0]![0], found[0]![1]];
  const folder = path.join(root(), name);
  fs.mkdirSync(folder, { recursive: true });
  copyFolder(sourcePath, path.join(folder, "EBWebView"));

  fs.writeFileSync(path.join(folder, "saved_at"), `${timestamp()} (dari ${source})`);

  if (pending() === name) {
    setPending("");
  }

  return [get(name) as Profile, source];
}
