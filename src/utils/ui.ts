import pc from "picocolors";
import { console } from "./console";

/**
 * Layout for one profile block:
 *
 *   ┌ Profile 1                                   1/3
 *   │ ▶ sedang mencari · target 30
 *   │
 *   │   ✓   1/30   keyword
 *   │   ✗   2/30   keyword
 *   │              ↳ reason
 *   │
 *   └ ■ selesai   30/30 ok   0 gagal   2m31s
 */

const BLOCK_WIDTH = 60;
const bar = pc.dim("│");

export function profileHeader(name: string, position: string, target: number) {
  const gap = Math.max(2, BLOCK_WIDTH - name.length - position.length - 2);

  console.print();
  console.print(`${pc.dim("┌")} ${pc.bold(name)}${" ".repeat(gap)}${pc.dim(position)}`);
  console.print(`${bar} ${pc.cyan("▶ sedang mencari")} ${pc.dim(`· target ${target}`)}`);
  console.print(bar);
}

function counter(current: number, total: number): string {
  const width = String(total).length;
  return `${String(current).padStart(width)}/${total}`;
}

export function taskSuccess(current: number, total: number, keyword: string) {
  console.print(`${bar}   ${pc.green("✓")}   ${pc.dim(counter(current, total))}   ${keyword}`);
}

export function taskFailure(
  current: number,
  total: number,
  keyword: string,
  reason: string,
) {
  const indent = " ".repeat(counter(current, total).length + 7);

  console.print(`${bar}   ${pc.red("✗")}   ${pc.dim(counter(current, total))}   ${pc.red(keyword)}`);
  console.print(`${bar}   ${indent}${pc.dim(`↳ ${reason}`)}`);
}

export type ProfileStatus = "ok" | "partial" | "error";

export function profileFooter(
  status: ProfileStatus,
  stats: { completed: number; target: number; failed: number; duration: string },
  error?: string,
) {
  const label =
    status === "ok"
      ? pc.green("■ selesai")
      : status === "partial"
        ? pc.yellow("■ tidak sempurna")
        : pc.red("■ error");

  const failed = `${stats.failed} gagal`;

  console.print(bar);
  console.print(
    `${pc.dim("└")} ${label}   ${stats.completed}/${stats.target} ok   ${stats.failed > 0 ? pc.red(failed) : pc.dim(failed)}   ${pc.dim(stats.duration)}`,
  );

  if (error) {
    console.print(`    ${pc.dim(`↳ ${error}`)}`);
  }
}

export function pauseLine(seconds: number) {
  console.print();
  console.dim(`  ⋯ jeda ${seconds}s sebelum profile berikutnya`);
}

// ── session header ──────────────────────────────────────────────────────────

const REPO_URL = "https://github.com/kodefess/edge-ts";

// "ANSI Shadow" letters, 6 rows each; composed per row so columns stay aligned.
const GLYPHS: Record<string, string[]> = {
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  D: ["██████╗ ", "██╔══██╗", "██║  ██║", "██║  ██║", "██████╔╝", "╚═════╝ "],
  G: [" ██████╗ ", "██╔════╝ ", "██║  ███╗", "██║   ██║", "╚██████╔╝", " ╚═════╝ "],
  "-": ["      ", "      ", "█████╗", "╚════╝", "      ", "      "],
  T: ["████████╗", "╚══██╔══╝", "   ██║   ", "   ██║   ", "   ██║   ", "   ╚═╝   "],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
};

export function banner() {
  const text = "EDGE-TS";

  console.print();

  for (let row = 0; row < 6; row++) {
    const line = [...text].map((char) => GLYPHS[char]?.[row] ?? "").join("");
    console.print(`  ${pc.cyan(line)}`);
  }

  console.print();
  console.print(`  ${pc.dim("by")} ${pc.bold("kodefess/yuxxeun")}   ${pc.dim("·")}   ${pc.underline(pc.dim(REPO_URL))}`);
  console.print(`  ${pc.dim("Automated Browser · Selenium / Edge")}`);
}

/** Lays names out in aligned columns that fit the terminal width. */
export function profileGrid(names: string[]) {
  const indent = "    ";
  const termWidth = process.stdout.columns ?? 100;
  const cellWidth = Math.max(...names.map((name) => name.length)) + 4;
  const columns = Math.max(1, Math.min(6, Math.floor((termWidth - indent.length) / cellWidth)));

  for (let i = 0; i < names.length; i += columns) {
    const row = names
      .slice(i, i + columns)
      .map((name) => `${pc.dim("·")} ${name.padEnd(cellWidth - 2)}`)
      .join("")
      .trimEnd();

    console.print(`${indent}${row}`);
  }
}

export function sessionInfo(profiles: string[], target: number) {
  const label = (text: string) => pc.dim(text.padEnd(10));

  console.print();
  console.rule("sesi");
  console.print();
  console.print(`  ${label("profiles")} ${pc.bold(String(profiles.length))}`);
  profileGrid(profiles);
  console.print();
  console.print(`  ${label("target")} ${pc.bold(String(target))} ${pc.dim("tugas/profile")}  ${pc.dim(`(${profiles.length * target} total)`)}`);
}
