/**
 * Wireless adb for the mobile run (no USB cable).
 *
 * Usage:
 *   just mobile wifi              status
 *   just mobile wifi usb          cable once → Wi-Fi
 *   just mobile wifi pair         Android 11+, no cable
 *   just mobile wifi pair 192.168.1.5:37123 123456
 *   just mobile wifi connect      reconnect (saved / mDNS)
 *   just mobile wifi connect 192.168.1.5:41234
 *   just mobile wifi off          disconnect Wi-Fi adb
 */
import readline from "node:readline/promises";

import * as wifi from "../mobile/adb-wifi";
import { console } from "../utils/console";
import * as ui from "../utils/ui";

const escape = ui.escape;

function log(message: string): void {
  console.markup(`  [dim]· ${escape(message)}[/dim]`);
}

function ok(message: string): void {
  console.markup(`  [green]✓[/green] ${message}`);
}

async function showStatus(): Promise<number> {
  ui.section("adb");

  const found = await wifi.devices();

  if (!found.length) {
    console.markup("  [yellow]![/yellow] tidak ada HP terhubung");
  }

  for (const [serial, state] of found) {
    const kind = wifi.isWireless(serial) ? "wifi" : "usb";
    const color = state === "device" ? "green" : "yellow";
    console.markup(`  [${color}]●[/${color}] ${escape(serial)}  [dim]${kind} · ${escape(state)}[/dim]`);
  }

  for (const [serial, kind, address] of await wifi.mdnsEndpoints()) {
    console.markup(`  [cyan]◌[/cyan] ${escape(address)}  [dim]mDNS · ${escape(serial)} · ${kind}[/dim]`);
  }

  const saved = wifi.savedAddress();
  console.print();
  ui.field("tersimpan", saved ? escape(saved) : "[dim]-[/dim]");
  ui.field("hp", escape(wifi.savedSerial()) || "[dim]-[/dim]");
  ui.field("adb", `[dim]${escape(wifi.adbPath())}[/dim]`);
  console.print();

  if (!(await wifi.wirelessDevices()).length) {
    console.markup(
      "  [dim]Pakai kabel sekali:[/dim] just mobile wifi usb\n" +
        "  [dim]Tanpa kabel (Android 11+):[/dim] just mobile wifi pair",
    );
    console.print();
  }

  return 0;
}

async function cmdUsb(): Promise<number> {
  ui.section("wifi · lewat kabel sekali");
  const address = await wifi.setupOverUsb(log);
  ok(`terhubung lewat Wi-Fi [bold]${escape(address)}[/bold]  [dim]· disimpan di .env[/dim]`);
  console.print();
  console.print(
    "  Kabel boleh dicabut sekarang. Berlaku sampai HP restart;\n" +
      "  setelah restart colok sekali lagi dan jalankan perintah ini.",
  );
  console.print();
  return 0;
}

async function cmdPair(addressIn: string, codeIn: string): Promise<number> {
  ui.section("wifi · pairing tanpa kabel");

  let address = addressIn;
  let code = codeIn;

  if (!address || !code) {
    console.markup(
      "  Di HP: Settings → Additional settings → Developer options →\n" +
        "  [bold]Wireless debugging[/bold] (ON) → [bold]Pair device with pairing code[/bold]\n",
    );

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
      address = address || (await rl.question("  alamat IP:port di dialog pairing: ")).trim();
      code = code || (await rl.question("  kode 6 digit: ")).trim();
    } finally {
      rl.close();
    }
  }

  const result = await wifi.pair(address, code, log);
  ok(`terhubung lewat Wi-Fi [bold]${escape(result)}[/bold]  [dim]· disimpan di .env[/dim]`);
  console.print();
  console.print(
    "  Pairing cukup sekali. Selanjutnya cukup nyalakan Wireless debugging\n" +
      "  di HP; `just mobile run` akan menyambung sendiri.",
  );
  console.print();
  return 0;
}

async function cmdConnect(address: string): Promise<number> {
  ui.section("wifi · connect");

  if (address) {
    log(`adb connect ${address}`);

    if (!(await wifi.connect(address))) {
      console.markup(`  [red]✗[/red] gagal connect ke ${escape(address)}`);
      return 1;
    }

    await wifi.saveAddress(address);
    ok(`terhubung [bold]${escape(address)}[/bold]`);
    return 0;
  }

  const serial = await wifi.ensureConnected(log, true);

  if (serial && wifi.isWireless(serial)) {
    ok(`terhubung [bold]${escape(serial)}[/bold]`);
    console.print();
    return 0;
  }

  console.print(
    "  ✗ HP tidak ditemukan lewat Wi-Fi.\n" +
      "    · pastikan PC dan HP di Wi-Fi yang sama\n" +
      "    · nyalakan Wireless debugging di HP, atau\n" +
      "    · colok kabel sekali lalu: just mobile wifi usb",
  );
  console.print();
  return 1;
}

async function cmdOff(): Promise<number> {
  ui.section("wifi · off");
  const out = await wifi.disconnectAll();
  log(out || "disconnected");
  ok("adb Wi-Fi diputus");
  console.print();
  return 0;
}

async function main(): Promise<number> {
  const [command = "status", address = "", code = ""] = process.argv.slice(2);

  try {
    switch (command) {
      case "usb":
        return await cmdUsb();
      case "pair":
        return await cmdPair(address, code);
      case "connect":
        return await cmdConnect(address);
      case "off":
        return await cmdOff();
      case "status":
        return await showStatus();
      default:
        console.markup(`  [red]✗[/red] perintah tidak dikenal: ${escape(command)} (status, usb, pair, connect, off)`);
        return 2;
    }
  } catch (error) {
    console.markup(`  [red]✗[/red] ${escape(error instanceof Error ? error.message : String(error))}`);
    console.print();
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
