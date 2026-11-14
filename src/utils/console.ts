import pc from "picocolors";

const RULE_WIDTH = 56;

export const console = {
  print(message = "") {
    process.stdout.write(`${message}\n`);
  },

  title(message: string) {
    process.stdout.write(`\n${pc.bold(pc.white(message))}\n\n`);
  },

  dim(message: string) {
    process.stdout.write(`${pc.dim(message)}\n`);
  },

  success(message: string) {
    process.stdout.write(`${pc.green(message)}\n`);
  },

  error(message: string) {
    process.stdout.write(`${pc.red(message)}\n`);
  },

  warning(message: string) {
    process.stdout.write(`${pc.yellow(message)}\n`);
  },

  rule(label = "") {
    const text = label ? `── ${label} ` : "";
    const fill = "─".repeat(Math.max(0, RULE_WIDTH - text.length));
    process.stdout.write(`${pc.dim(text + fill)}\n`);
  },

  /** Sets the terminal window/tab title (ignored by terminals that don't support it). */
  setTitle(title: string) {
    if (process.stdout.isTTY) {
      process.stdout.write(`\x1b]0;${title}\x07`);
    }
  },
};

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");

  if (hours > 0) {
    return `${hours}h${pad(minutes)}m${pad(seconds)}s`;
  }

  return minutes > 0 ? `${minutes}m${pad(seconds)}s` : `${seconds}s`;
}

export function formatError(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  // Selenium messages can be multi-line with stack info; keep the first line.
  return message.split("\n")[0]?.trim() ?? message;
}
