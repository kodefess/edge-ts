/**
 * Sign a profile in to Microsoft Rewards inside the Selenium copy.
 *
 * Usage:
 *   just web login                 profiles and their accounts
 *   just web login "Profile 5"     open it to sign in
 *
 * Why this exists: the session copies each Edge profile into the Selenium
 * folder once (driver/profile.ts) and reuses that copy afterwards. When the
 * rewards.bing.com sign-in in the copy expires, signing in again in the
 * normal Edge window does not help, because the copy is never refreshed. The
 * web run then reports "belum login rewards".
 *
 * This opens the *copy* in a plain Edge window (not WebDriver) at
 * rewards.bing.com. Sign in there yourself, then close the window; the
 * session is stored in the copy and the next `just web run` uses it.
 */
import fs from "node:fs";
import path from "node:path";

import { PROFILES, SELENIUM_USER_DATA_DIR } from "../config/settings";
import { edgePath, openWindow, profileAccount, resolveProfile } from "../driver/manual";
import { console } from "../utils/console";
import * as ui from "../utils/ui";

function listProfiles(): number {
  ui.section("profiles");

  for (const profile of PROFILES) {
    const email = profileAccount(profile);
    const copied = fs.existsSync(path.join(SELENIUM_USER_DATA_DIR, profile));
    const note = copied ? "" : "  [dim]· belum disalin[/dim]";

    console.markup(
      `  [bold white]${ui.escape(profile).padEnd(12)}[/bold white] ${email ? ui.escape(email) : "[dim]-[/dim]"}${note}`,
    );
  }

  console.print();
  console.markup(
    '  [dim]Login ulang satu profile:[/dim] just web login "Profile 5"\n' +
      "  [dim]atau pakai email:[/dim]        just web login nunung.ptv@gmail.com",
  );
  console.print();
  return 0;
}

async function openProfile(target: string): Promise<number> {
  const profile = resolveProfile(target);

  if (!profile) {
    console.markup(
      `  [red]✗[/red] ${ui.escape(target)} bukan profile di PROFILES dan tidak cocok dengan email mana pun`,
    );
    return 1;
  }

  if (!edgePath()) {
    console.markup("  [red]✗[/red] msedge.exe tidak ditemukan");
    return 1;
  }

  ui.section(`login · ${profile}`);
  const email = profileAccount(profile);
  if (email) {
    ui.field("akun", ui.escape(email));
  }
  console.print();
  console.print(
    "  1. Di jendela Edge yang terbuka, login ke Microsoft Rewards\n" +
      "     (klik Sign in / pilih akun, isi password jika diminta).\n" +
      "  2. Pastikan dashboard Rewards dengan poin tampil.\n" +
      "  3. Tutup jendela Edge itu. Sesi tersimpan untuk `just web run`.\n",
  );
  console.markup(
    "  [dim]Jangan jalankan `just web run` selama jendela ini terbuka " +
      "(profile yang sama tidak bisa dipakai dua kali).[/dim]",
  );
  console.print();

  const child = openWindow(profile);

  console.markup("  [dim]menunggu jendela Edge ditutup…[/dim]");

  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    process.once("SIGINT", () => resolve());
  });

  console.markup("  [green]✓[/green] selesai · jalankan `just web run` lagi untuk profile ini");
  console.print();
  return 0;
}

const target = process.argv.slice(2).join(" ").trim();

(target ? openProfile(target) : Promise.resolve(listProfiles()))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.markup(`[red]✗[/red] ${ui.escape(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
