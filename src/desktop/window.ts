/**
 * Keep the desktop app's windows off the screen while a run works in it.
 *
 * The app is moved far outside every monitor, like Edge's offscreen mode, not
 * minimized: a minimized WebView2 may stop rendering, and the clicks go through
 * the page anyway. A background PowerShell moves every window the app opens
 * (also after a restart), and gives the focus back to the window the user was
 * in.
 *
 * The app does not remember an offscreen position: opened by hand later, it
 * shows up where it normally does.
 */
import { type ChildProcess, spawn } from "node:child_process";

import { DESKTOP_APP_EXE } from "../config/settings";

/** Helper windows the app keeps (16 x 16 tray/IPC windows) stay where they are. */
const MIN_SIZE = 100;

/** Moves visible, real windows of the app far outside every monitor. */
function keeperScript(exe: string, intervalMs: number): string {
  const processName = exe.replace(/\.exe$/i, "");

  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class EdgeTsWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static bool MoveAway(HashSet<uint> pids, int minSize) {
    bool moved = false;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        if (r.Right - r.Left >= minSize && r.Bottom - r.Top >= minSize && !(r.Right <= 0 || r.Bottom <= 0)) {
          SetWindowPos(h, IntPtr.Zero, -32000, -32000, 0, 0, 0x0001 | 0x0004 | 0x0010);
          moved = true;
        }
      }
      return true;
    }, IntPtr.Zero);
    return moved;
  }
}
"@
$focus = [EdgeTsWin]::GetForegroundWindow()
$tick = 0
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'
while ($true) {
  if ($tick -le 0 -or $pids.Count -eq 0) {
    $pids.Clear()
    foreach ($p in Get-Process -Name '${processName}') { [void]$pids.Add([uint32]$p.Id) }
    $tick = 10
  }
  $tick--
  if ([EdgeTsWin]::MoveAway($pids, ${MIN_SIZE}) -and $focus -ne [IntPtr]::Zero) {
    [void][EdgeTsWin]::SetForegroundWindow($focus)
  }
  Start-Sleep -Milliseconds ${intervalMs}
}
`;
}

/** App windows are kept off the screen between `start()` and `stop()`. `enabled=false` is a no-op. */
export class Offscreen {
  private child: ChildProcess | undefined;

  constructor(
    private readonly enabled = true,
    private readonly intervalMs = 150,
  ) {}

  start(): this {
    if (!this.enabled || process.platform !== "win32") {
      return this;
    }

    const encoded = Buffer.from(keeperScript(DESKTOP_APP_EXE, this.intervalMs), "utf16le").toString("base64");

    this.child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: "ignore",
      windowsHide: true,
    });
    this.child.on("error", () => undefined);
    this.child.unref();

    return this;
  }

  stop(): void {
    if (this.child && this.child.exitCode === null) {
      try {
        this.child.kill();
      } catch {
        // Already gone.
      }
    }

    this.child = undefined;
  }
}
