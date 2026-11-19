/**
 * Microsoft Rewards desktop app: one saved sign-in per account.
 *
 * Usage:
 *   just desktop                       status + profiles
 *   just desktop save NAME             keep the signed-in account as NAME
 *   just desktop use NAME              switch the app to NAME
 *   just desktop new NAME              empty app, sign in, then `save NAME`
 *   just desktop run                   weekly quest on every saved account
 *   just desktop run --accounts a,b --dry-run
 *   just desktop backups               sessions kept in _backup
 *   just desktop restore NAME          backed-up session → profile NAME
 *   just desktop open / close          open / close the app
 *
 * Every command that touches the session closes the app first, and the
 * session in the app is saved back to its profile before another one is
 * swapped in.
 */
import fs from "node:fs";
import { parseArgs } from "node:util";

import * as app from "../desktop/app";
import * as devtools from "../desktop/devtools";
import * as profiles from "../desktop/profiles";
import { type DesktopRun, runAccounts } from "../desktop/session";
import { console } from "../utils/console";
import { InterruptedError, installInterruptHandler } from "../utils/interrupt";
import * as ui from "../utils/ui";

const escape = ui.escape;

function ok(message: string): void {
  console.markup(`  [green]✓[/green] ${message}`);
}

function note(message: string): void {
  if (message) {
    console.markup(`  [dim]· ${escape(message)}[/dim]`);
  }
}

async function showStatus(): Promise<void> {
  ui.section("microsoft rewards desktop");

  if (!app.installed()) {
    console.markup("  [red]✗[/red] app tidak terpasang (Microsoft Store: Microsoft Rewards)");
    return;
  }

  const running = await app.isRunning();
  console.markup("  app      " + (running ? "[green]● berjalan[/green]" : "[dim]○ tertutup[/dim]"));
  console.markup(`  sesi     [dim]${escape(app.webviewDir())}[/dim]`);
  console.markup(`  profil   [dim]${escape(profiles.root())}[/dim]`);

  const current = profiles.active();
  const found = profiles.listProfiles();

  ui.section("profil");

  if (!found.length) {
    console.markup("  [dim]belum ada · login di app lalu `just desktop save NAMA`[/dim]");
  }

  for (const profile of found) {
    const mark = profile.name === current ? "[green]▶[/green]" : " ";
    console.markup(
      `  ${mark} [bold]${escape(profile.name)}[/bold]  [dim]${profile.sizeMb.toFixed(0)} MB · disimpan ${escape(profile.savedAt || "?")}[/dim]`,
    );
  }

  const waiting = profiles.pending();

  if (waiting && !profiles.get(waiting)) {
    console.markup(
      `  [yellow]![/yellow] ${escape(waiting)} sedang ditambahkan · setelah login: [cyan]just desktop save ${escape(waiting)}[/cyan]`,
    );
  } else if (!current && fs.existsSync(app.webviewDir())) {
    console.markup("  [yellow]![/yellow] sesi di app belum punya nama profil");
  }

  const lost = profiles.backups().filter(([, , emails]) => emails.length && !emails.some((email) => profiles.get(email)));

  if (lost.length) {
    console.print();
    console.markup("  [yellow]![/yellow] akun di backup yang belum jadi profil:");

    for (const [name, , emails] of lost) {
      console.markup(
        `      ${escape(emails.join(", "))}  [dim]· ${escape(name)}[/dim]  → [cyan]just desktop restore ${escape(emails[0]!)}[/cyan]`,
      );
    }
  }

  if (await devtools.leftover()) {
    console.markup(
      "  [yellow]![/yellow] variabel WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS masih berisi port debug (dihapus di perintah berikutnya)",
    );
  }
}

async function runQuests(accounts: string, dryRun: boolean, visible: boolean): Promise<DesktopRun[]> {
  let names = profiles.listProfiles().map((p) => p.name);

  if (accounts) {
    const wanted = accounts
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    for (const name of wanted.filter((a) => !names.includes(a))) {
      console.markup(`  [yellow]![/yellow] profil ${escape(name)} belum disimpan · dilewati`);
    }

    names = wanted.filter((a) => names.includes(a));
  }

  if (!names.length) {
    console.markup("  [dim]tidak ada profil untuk dijalankan[/dim]");
    return [];
  }

  const runs = await runAccounts(names, {
    dryRun,
    offscreen: visible ? false : undefined,
    log: (message) => console.markup(`│   [dim]· ${escape(message)}[/dim]`),
    onStart: (name, index, total) => {
      console.print();
      console.markup(`┌ [bold]${escape(name)}[/bold]  [dim]${index}/${total}[/dim]`);
    },
    onDone: (run) => {
      const q = run.quest;
      let status = "";

      if (q) {
        status =
          q.statusBefore && q.statusAfter && q.statusBefore !== q.statusAfter
            ? `${q.statusBefore} → ${q.statusAfter}`
            : q.statusAfter || q.statusBefore;
      }

      let line: string;

      if (run.error) {
        line = `[red]✗ ${escape(run.error)}[/red]`;
      } else if (q?.error) {
        line = `[yellow]! ${escape(q.error)}[/yellow]`;
      } else if (q?.completed.length) {
        line = `[green]✓ ${escape(q.completed.join(", "))}[/green]`;
      } else {
        line = `[dim]${escape(q?.note ?? "")}[/dim]`;
      }

      console.markup(`└ ■ ${line}   [dim]${escape(status)} · ${run.duration.toFixed(0)}s[/dim]`);
    },
  });

  ui.section("rekap desktop");

  for (const run of runs) {
    const q = run.quest;
    const mark = { ok: "[green]✓[/green]", partial: "[yellow]![/yellow]", error: "[red]✗[/red]" }[run.outcome];
    const detail = run.error || (q?.error ? q.error : q?.completed.length ? q.completed.join(", ") : (q?.note ?? ""));

    console.markup(`  ${mark} ${escape(run.name).padEnd(30)} [dim]${escape(q?.statusAfter || "–").padEnd(12)}[/dim] ${escape(detail)}`);
  }

  return runs;
}

async function main(): Promise<number> {
  installInterruptHandler();

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "no-open": { type: "boolean", default: false },
      accounts: { type: "string", default: "" },
      "dry-run": { type: "boolean", default: false },
      visible: { type: "boolean", default: false },
      from: { type: "string", default: "" },
    },
  });

  const [command = "status", name = ""] = positionals;

  // A debug-port variable left by a crashed run never outlives the next command.
  if (positionals.length && (await devtools.clearLeftover())) {
    note("sisa variabel port debug dihapus");
  }

  const needName = ["save", "use", "new", "restore"];

  if (needName.includes(command) && !name) {
    console.markup(`  [red]✗[/red] perintah ${command} butuh NAMA profil`);
    return 2;
  }

  try {
    switch (command) {
      case "save": {
        const profile = await profiles.save(name);
        ok(`disimpan sebagai [bold]${escape(profile.name)}[/bold] · ${profile.sizeMb.toFixed(0)} MB`);
        break;
      }

      case "use": {
        const [profile, message] = await profiles.use(name);
        note(message);
        ok(`app memakai [bold]${escape(profile.name)}[/bold]`);

        if (!values["no-open"]) {
          if (await app.start()) ok("app dibuka");
          else note("app belum terbuka, buka manual");
        }
        break;
      }

      case "new": {
        note(await profiles.create(name));
        ok("sesi app dikosongkan");
        await app.start();
        console.markup(
          `  login akun di app, tutup app, lalu: [cyan]just desktop save ${escape(name)}[/cyan]\n` +
            `  [dim](lupa save? \`new\` berikutnya menyimpannya otomatis sebagai ${escape(name)})[/dim]`,
        );
        break;
      }

      case "run": {
        const runs = await runQuests(values.accounts ?? "", values["dry-run"], values.visible);

        if (runs.some((run) => run.outcome !== "ok")) {
          return 1;
        }
        break;
      }

      case "restore": {
        const [profile, source] = profiles.restore(name, values.from ?? "");
        ok(`[bold]${escape(profile.name)}[/bold] dipulihkan dari [dim]${escape(source)}[/dim] · ${profile.sizeMb.toFixed(0)} MB`);
        break;
      }

      case "backups": {
        ui.section("backup sesi");
        const items = profiles.backups();

        if (!items.length) {
          console.markup("  [dim]kosong[/dim]");
        }

        for (const [backupName, , emails] of items) {
          const saved = emails.filter((email) => profiles.get(email));
          const tag = saved.length
            ? "[dim]sudah ada profilnya[/dim]"
            : emails.length
              ? "[yellow]belum jadi profil[/yellow]"
              : "[dim]tanpa akun[/dim]";

          console.markup(`  ${escape(backupName).padEnd(52)} ${(escape(emails.join(", ")) || "-").padEnd(28)} ${tag}`);
        }
        break;
      }

      case "open":
        if (await app.start()) ok("app dibuka");
        else note("app belum terbuka");
        break;

      case "close":
        if (await app.stop()) ok("app ditutup");
        else note("app tidak bisa ditutup");
        break;

      case "status":
        await showStatus();
        break;

      default:
        console.markup(
          `  [red]✗[/red] perintah tidak dikenal: ${escape(command)} (status, save, use, new, run, restore, backups, open, close)`,
        );
        return 2;
    }
  } catch (error) {
    if (error instanceof InterruptedError) {
      console.markup("[yellow]‼[/yellow] dihentikan");
      return 130;
    }

    if (error instanceof profiles.ProfileError || error instanceof devtools.DevToolsError) {
      console.markup(`  [red]✗[/red] ${escape(error.message)}`);
      return 1;
    }

    throw error;
  }

  return 0;
}

main().then((code) => {
  process.exitCode = code;
});
