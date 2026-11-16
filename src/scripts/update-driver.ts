/**
 * Download the msedgedriver that matches the installed Microsoft Edge.
 *
 *   just update-driver                 match the installed Edge version
 *   just update-driver --latest        newest stable driver from Microsoft
 *   just update-driver --version 157.0.4341.60
 *   just update-driver --force         download even if already up to date
 *
 * Steps:
 * 1. Read the installed Edge version from the Windows registry.
 * 2. Read the version of the driver EDGE_DRIVER_PATH (.env) points to.
 * 3. If they differ, download edgedriver_<arch>.zip from Microsoft's driver
 *    server (the same files the Edge WebDriver download page links to) into
 *    driver/stable/<version>/ and extract msedgedriver.exe there.
 * 4. Point EDGE_DRIVER_PATH in .env at the new driver.
 *
 * Older driver folders are kept, so you can switch back by editing .env.
 *
 * This script deliberately does NOT import src/config/settings.ts: that module
 * throws when the driver is missing, which is exactly when this script is needed.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { parse as parseDotenv } from "dotenv";
import { console, escapeMarkup, renderMarkup } from "../utils/console";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..", "..");

// Internal overrides (for testing without touching the real .env / driver folder).
const ENV_FILE = path.resolve(PROJECT_ROOT, process.env.UPDATE_DRIVER_ENV_FILE || ".env");
const ENV_EXAMPLE_FILE = path.join(PROJECT_ROOT, ".env.example");
const DRIVER_ROOT = path.resolve(PROJECT_ROOT, process.env.UPDATE_DRIVER_ROOT || path.join("driver", "stable"));

// Host behind the download links on
// https://developer.microsoft.com/microsoft-edge/tools/webdriver/
const DOWNLOAD_HOST = "https://msedgedriver.microsoft.com";

const DRIVER_EXE = "msedgedriver.exe";
const ENV_KEY = "EDGE_DRIVER_PATH";

const VERSION_RE = /\d+\.\d+\.\d+\.\d+/;
const VERSION_FULL_RE = /^\d+\.\d+\.\d+\.\d+$/;

const USER_AGENT = "Mozilla/5.0";

// Registry locations that hold the installed Edge (stable) version.
const EDGE_REGISTRY: [hive: string, key: string, value: string][] = [
  ["HKEY_CURRENT_USER", "Software\\Microsoft\\Edge\\BLBeacon", "version"],
  [
    "HKEY_LOCAL_MACHINE",
    "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}",
    "pv",
  ],
  [
    "HKEY_LOCAL_MACHINE",
    "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}",
    "pv",
  ],
  [
    "HKEY_CURRENT_USER",
    "Software\\Microsoft\\EdgeUpdate\\Clients\\{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}",
    "pv",
  ],
];

class DriverUpdateError extends Error {}

/** Non-2xx response (Python's urllib.error.HTTPError). */
class HttpError extends Error {
  constructor(
    readonly code: number,
    readonly url: string,
  ) {
    super(`HTTP Error ${code} for ${url}`);
  }
}

/** Network failure (Python's urllib.error.URLError). */
class UrlError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;

  try {
    response = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT },
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new UrlError(cause instanceof Error ? cause.message : String(cause));
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status, url);
  }

  return response;
}

/** One-line spinner on a TTY (like rich's console.status); silent otherwise. */
function createStatus() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const tty = Boolean(process.stdout.isTTY);
  let text = "";
  let frame = 0;

  const render = () => {
    process.stdout.write(`\r${frames[frame % frames.length]} ${text}\x1b[K`);
    frame++;
  };

  const timer = tty ? setInterval(render, 80) : undefined;

  return {
    update(markup: string) {
      text = renderMarkup(markup);
    },
    stop() {
      if (timer) clearInterval(timer);
      if (tty) process.stdout.write("\r\x1b[K");
    },
  };
}

// ============================================================
// VERSIONS
// ============================================================

/** Installed Microsoft Edge version, or null if not found. */
export async function installedEdgeVersion(): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }

  for (const [hive, keyPath, valueName] of EDGE_REGISTRY) {
    let stdout: string;

    try {
      ({ stdout } = await execFileAsync("reg", ["query", `${hive}\\${keyPath}`, "/v", valueName], {
        windowsHide: true,
        timeout: 15_000,
      }));
    } catch {
      continue;
    }

    const match = VERSION_RE.exec(stdout);

    if (match) {
      return match[0];
    }
  }

  return null;
}

/** Version reported by `msedgedriver --version`, or null. */
export async function driverVersion(file: string | null): Promise<string | null> {
  if (!file || !isFile(file)) {
    return null;
  }

  let output: string;

  try {
    ({ stdout: output } = await execFileAsync(file, ["--version"], {
      windowsHide: true,
      timeout: 15_000,
    }));
  } catch (error) {
    // Non-zero exit still has stdout (Python uses check=False).
    const stdout = (error as { stdout?: unknown }).stdout;
    output = typeof stdout === "string" ? stdout : "";
  }

  return VERSION_RE.exec(output)?.[0] ?? null;
}

/** Read a small text file from the driver server (UTF-16 or UTF-8). */
async function fetchText(url: string): Promise<string> {
  const response = await request(url, { signal: AbortSignal.timeout(15_000) });
  const data = new Uint8Array(await response.arrayBuffer());

  for (const encoding of ["utf-16le", "utf-8"]) {
    let text: string;

    try {
      text = new TextDecoder(encoding, { fatal: true }).decode(data);
    } catch {
      continue;
    }

    const match = VERSION_RE.exec(text);

    if (match) {
      return match[0];
    }
  }

  throw new DriverUpdateError(`unexpected response from ${url}`);
}

export function latestStableVersion(): Promise<string> {
  return fetchText(`${DOWNLOAD_HOST}/LATEST_STABLE`);
}

export function latestForMajor(major: string): Promise<string> {
  return fetchText(`${DOWNLOAD_HOST}/LATEST_RELEASE_${major}_WINDOWS`);
}

function majorOf(version: string | null): string | null {
  return version ? (version.split(".")[0] ?? null) : null;
}

// ============================================================
// .env
// ============================================================

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Value of `key` in .env, or null. */
export function readEnvValue(key: string): string | null {
  if (!isFile(ENV_FILE)) {
    return null;
  }

  const text = fs.readFileSync(ENV_FILE, "utf8").replace(/^\uFEFF/, "");
  const value = parseDotenv(text)[key];

  return value === undefined ? null : value.trim().replace(/^["']+|["']+$/g, "");
}

/** Expand ~ and %VAR% / $VAR, resolve against the project root; a folder means <folder>/msedgedriver.exe. */
export function resolveProjectPath(value: string | null): string | null {
  if (!value) {
    return null;
  }

  let result = value
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (match, name: string) => process.env[name] ?? match);

  result = path.resolve(PROJECT_ROOT, result);

  if (isDirectory(result)) {
    result = path.join(result, DRIVER_EXE);
  }

  return result;
}

/** Set `key=value` in .env, keeping every other line as it is. */
export function writeEnvValue(key: string, value: string): void {
  if (!isFile(ENV_FILE)) {
    if (isFile(ENV_EXAMPLE_FILE)) {
      fs.copyFileSync(ENV_EXAMPLE_FILE, ENV_FILE);
    } else {
      fs.writeFileSync(ENV_FILE, "", "utf8");
    }
  }

  const raw = fs.readFileSync(ENV_FILE);
  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const text = raw.toString("utf8").replace(/^\uFEFF/, "");

  // Like Python's str.splitlines(): no trailing empty entry.
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();

  const newLine = `${key}=${value}`;
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));

  if (index >= 0) {
    lines[index] = newLine;
  } else {
    lines.push(newLine);
  }

  fs.writeFileSync(ENV_FILE, lines.join(newline) + newline, "utf8");
}

// ============================================================
// DOWNLOAD
// ============================================================

export function zipName(): string {
  // Same source as Python's platform.machine() on Windows.
  const machine = (
    process.env.PROCESSOR_ARCHITEW6432 ||
    process.env.PROCESSOR_ARCHITECTURE ||
    os.arch()
  ).toLowerCase();

  if (["arm64", "aarch64"].includes(machine)) {
    return "edgedriver_arm64.zip";
  }

  if (["amd64", "x86_64", "x64"].includes(machine)) {
    return "edgedriver_win64.zip";
  }

  return "edgedriver_win32.zip";
}

/** Download `url` to `destination` with a progress line. */
async function download(url: string, destination: string): Promise<void> {
  // 30 s without any data aborts (like urllib's socket timeout), not 30 s total.
  const controller = new AbortController();
  let idle = setTimeout(() => controller.abort(new Error("timed out")), 30_000);
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new Error("timed out")), 30_000);
  };

  const status = createStatus();
  const fd = fs.openSync(destination, "w");

  try {
    const response = await request(url, { signal: controller.signal });
    const total = Number(response.headers.get("Content-Length") ?? 0) || 0;
    let done = 0;

    if (!response.body) {
      throw new UrlError("empty response");
    }

    const reader = response.body.getReader();

    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;

      try {
        chunk = await reader.read();
      } catch (error) {
        throw new UrlError(error instanceof Error ? error.message : String(error));
      }

      if (chunk.done) {
        break;
      }

      touch();
      fs.writeSync(fd, chunk.value);
      done += chunk.value.length;

      let size = (done / 1_048_576).toFixed(1);
      if (total) {
        size += ` / ${(total / 1_048_576).toFixed(1)}`;
      }

      status.update(`mengunduh [dim]${size} MB[/dim]`);
    }
  } finally {
    clearTimeout(idle);
    fs.closeSync(fd);
    status.stop();
  }
}

/**
 * bsdtar (ships with Windows 10+) reads zip files. Use the System32 copy
 * explicitly: Git Bash's GNU tar can shadow it on PATH and cannot read zips.
 */
function tarExecutable(): string {
  const systemTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  return isFile(systemTar) ? systemTar : "tar";
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  try {
    await execFileAsync(tarExecutable(), ["-xf", zipPath, "-C", destination], {
      windowsHide: true,
      timeout: 120_000,
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
    throw new DriverUpdateError(
      `cannot extract ${path.basename(zipPath)}${stderr ? ` (${stderr.split("\n")[0]})` : ""}`,
    );
  }
}

function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.toLowerCase() === name) {
      return path.join(entry.parentPath, entry.name);
    }
  }

  return null;
}

/**
 * Download and extract the driver for `version`.
 *
 * Returns the path of the extracted msedgedriver.exe.
 */
async function install(version: string, force = false): Promise<string> {
  const targetDir = path.join(DRIVER_ROOT, version);
  const exePath = path.join(targetDir, DRIVER_EXE);

  if (isFile(exePath) && !force) {
    console.markup(`  [dim]folder[/dim]    driver ${version} sudah ada, tidak diunduh ulang`);
    return exePath;
  }

  const name = zipName();
  const url = `${DOWNLOAD_HOST}/${version}/${name}`;

  console.markup(`  [dim]unduh[/dim]     ${url}`);

  fs.mkdirSync(DRIVER_ROOT, { recursive: true });

  // Download and extract into a temporary folder first, so a failed
  // download never leaves a half-finished driver folder behind.
  const staging = fs.mkdtempSync(path.join(DRIVER_ROOT, ".download-"));

  try {
    const zipPath = path.join(staging, name);
    await download(url, zipPath);
    await extractZip(zipPath, staging);
    fs.rmSync(zipPath);

    const extractedExe = findFile(staging, DRIVER_EXE);

    if (extractedExe === null) {
      throw new DriverUpdateError(`${DRIVER_EXE} not found in ${name}`);
    }

    // Make sure the exe sits directly in the version folder.
    const stagedExe = path.join(staging, DRIVER_EXE);

    if (path.resolve(extractedExe) !== path.resolve(stagedExe)) {
      fs.renameSync(extractedExe, stagedExe);
    }

    if (isDirectory(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }

    fs.renameSync(staging, targetDir);
  } catch (error) {
    if (error instanceof HttpError) {
      throw new DriverUpdateError(`download failed (${error.code}) for ${url}`);
    }

    if (error instanceof UrlError) {
      throw new DriverUpdateError(`cannot reach ${DOWNLOAD_HOST} (${error.reason})`);
    }

    throw error;
  } finally {
    if (isDirectory(staging)) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  return exePath;
}

export async function driverExistsOnline(version: string): Promise<boolean> {
  const url = `${DOWNLOAD_HOST}/${version}/${zipName()}`;

  try {
    await request(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    return true;
  } catch (error) {
    if (error instanceof HttpError && error.code === 404) {
      return false;
    }

    throw error;
  }
}

// ============================================================
// MAIN
// ============================================================

const PROG = "update-driver.ts";

const USAGE =
  `usage: ${PROG} [-h] [--latest | --version X.Y.Z.W] [--force]\n\n` +
  "Download the msedgedriver matching the installed Microsoft Edge and point\n" +
  "EDGE_DRIVER_PATH at it.\n\n" +
  "options:\n" +
  "  -h, --help         show this help message and exit\n" +
  "  --latest           download the newest stable driver instead of matching Edge\n" +
  "  --version X.Y.Z.W  download this exact driver version\n" +
  "  --force            download again even if already up to date";

class UsageError extends Error {}

type Options = { latest: boolean; version: string | null; force: boolean };

function parseOptions(argv: string[]): Options | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      latest: { type: "boolean", default: false },
      version: { type: "string" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    return "help";
  }

  if (positionals.length) {
    throw new UsageError(`unrecognized arguments: ${positionals.join(" ")}`);
  }

  if (values.latest && values.version !== undefined) {
    throw new UsageError("argument --version: not allowed with argument --latest");
  }

  if (values.version !== undefined && !VERSION_FULL_RE.test(values.version.trim())) {
    throw new UsageError(`invalid version: '${values.version}'`);
  }

  return {
    latest: values.latest,
    version: values.version?.trim() || null,
    force: values.force,
  };
}

async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Options;

  try {
    const parsed = parseOptions(argv);

    if (parsed === "help") {
      console.print(USAGE);
      return 0;
    }

    args = parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${USAGE.split("\n")[0]}\n${PROG}: error: ${message}\n`);
    return 2;
  }

  console.print();
  console.markup("[bold white]Update driver[/bold white] [dim]· Microsoft Edge WebDriver[/dim]");
  console.print();

  const edge = await installedEdgeVersion();
  const currentPath = resolveProjectPath(readEnvValue(ENV_KEY));
  const current = await driverVersion(currentPath);

  let latest: string | null;

  try {
    latest = await latestStableVersion();
  } catch {
    latest = null;
  }

  console.markup(
    "  [dim]edge[/dim]      " +
      (edge ? `[bold white]${edge}[/bold white]` : "[yellow]tidak ditemukan[/yellow]"),
  );
  console.markup(
    "  [dim]driver[/dim]    " +
      (current ? `[bold white]${current}[/bold white]` : "[yellow]belum ada / tidak terbaca[/yellow]"),
  );
  console.markup(
    "  [dim]stabil[/dim]    " +
      (latest ? `${latest} [dim](terbaru di web)[/dim]` : "[dim]tidak bisa dicek[/dim]"),
  );

  if (edge && latest && edge !== latest && !args.latest) {
    console.markup("  [dim]          Edge belum update ke stabil terbaru; driver ikut versi Edge.[/dim]");
  }

  console.print();

  // --------------------------------------------------------
  // Pick the version to install
  // --------------------------------------------------------

  let target: string;
  let exePath: string;

  try {
    if (args.version) {
      target = args.version;
    } else if (args.latest) {
      if (!latest) {
        throw new DriverUpdateError("cannot read the latest stable version");
      }
      target = latest;
    } else if (edge) {
      target = edge;

      if (!(await driverExistsOnline(target))) {
        // No build for this exact version: use the newest driver
        // for the same major version, which is compatible.
        const major = majorOf(edge) as string;
        target = await latestForMajor(major);
        console.markup(`  [dim]catatan[/dim]   driver ${edge} tidak ada, pakai ${target} (major ${major})`);
      }
    } else {
      throw new DriverUpdateError("Microsoft Edge not found. Use --latest or --version.");
    }

    if (current === target && !args.force) {
      console.markup(`[green]✓[/green] Driver sudah terbaru [dim]· ${target}[/dim]`);
      console.print();
      return 0;
    }

    exePath = await install(target, args.force);
  } catch (error) {
    if (error instanceof DriverUpdateError) {
      console.markup(`[red]✗[/red] ${escapeMarkup(error.message)}`);
      console.print();
      return 1;
    }

    throw error;
  }

  const installed = await driverVersion(exePath);

  if (installed !== target) {
    console.markup(
      `[red]✗[/red] ${escapeMarkup(exePath)} reports version ${installed ?? "unknown"}, expected ${target}`,
    );
    console.print();
    return 1;
  }

  // Python's os.path.relpath raises across drives; fall back to the absolute path.
  const fromRoot = path.relative(PROJECT_ROOT, exePath);
  const relative = path.isAbsolute(fromRoot) ? exePath : `./${fromRoot.split(path.sep).join("/")}`;

  writeEnvValue(ENV_KEY, relative);

  console.markup(`  [dim]folder[/dim]    ${escapeMarkup(path.relative(PROJECT_ROOT, path.dirname(exePath)))}`);
  console.markup(`  [dim].env[/dim]      ${ENV_KEY}=${escapeMarkup(relative)}`);
  console.print();
  console.markup(`[green]✓[/green] Driver diperbarui [dim]· ${current ?? "-"} → ${target}[/dim]`);

  if (edge && majorOf(edge) !== majorOf(target)) {
    console.markup(
      `[yellow]![/yellow] Edge ${edge} dan driver ${target} beda versi utama; ` +
        "Selenium bisa gagal sampai Edge di-update.",
    );
  }

  console.print();

  return 0;
}

// Run only when executed directly (not when imported, e.g. by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.markup(`[red]✗[/red] ${escapeMarkup(error instanceof Error ? error.message : String(error))}`);
      console.print();
      process.exitCode = 1;
    },
  );
}
