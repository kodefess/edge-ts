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
