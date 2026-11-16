import pc from "picocolors";

const RULE_WIDTH = 56;

// ── rich-style markup ────────────────────────────────────────────────────────
//
// Lets ported code keep edge-py's strings as-is: "[dim]x[/dim]",
// "[bold white]x[/bold white]", "[red]✗[/red]". A closing tag ("[/x]" or "[/]")
// ends the most recent open style. "\[" is a literal bracket.

type Style = (text: string) => string;

const STYLES: Record<string, Style> = {
  bold: pc.bold,
  dim: pc.dim,
  italic: pc.italic,
  underline: pc.underline,
  red: pc.red,
  green: pc.green,
  yellow: pc.yellow,
  blue: pc.blue,
  magenta: pc.magenta,
  cyan: pc.cyan,
  white: pc.white,
  grey: pc.gray,
  gray: pc.gray,
};

const TAG = /\\\[|\[(\/?)([a-z ]*)\]/g;

/** Converts rich-style markup to ANSI colours (or plain text when colours are off). */
export function renderMarkup(text: string): string {
  const stack: Style[][] = [];
  let output = "";
  let last = 0;

  const styled = (chunk: string) =>
    stack.flat().reduceRight((value, style) => style(value), chunk);

  for (const match of text.matchAll(TAG)) {
    const [whole, closing, name = ""] = match;
    const index = match.index ?? 0;

    if (whole === "\\[") {
      output += styled(text.slice(last, index)) ;
      output += styled("[");
      last = index + whole.length;
      continue;
    }

    const words = name.trim().split(/\s+/).filter(Boolean);
    const known = words.every((word) => word in STYLES);

    // Not a style tag (e.g. "[1/3]"): leave it as literal text.
    if (!closing && (!words.length || !known)) {
      continue;
    }

    output += styled(text.slice(last, index));
    last = index + whole.length;

    if (closing) {
      stack.pop();
    } else {
      stack.push(words.map((word) => STYLES[word] as Style));
    }
  }

  return output + styled(text.slice(last));
}

/** Escapes text (keywords, errors, page text) so "[" is never read as markup. */
export function escapeMarkup(text: string): string {
  return text.replace(/\[/g, "\\[");
}

/** Visible length of a markup string (tags and escapes removed). */
export function markupLength(text: string): number {
  return stripAnsi(renderMarkup(text)).length;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export const console = {
  print(message = "") {
    process.stdout.write(`${message}\n`);
  },

  /** Prints rich-style markup, e.g. console.markup("[dim]waiting…[/dim]"). */
  markup(message = "") {
    process.stdout.write(`${renderMarkup(message)}\n`);
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
