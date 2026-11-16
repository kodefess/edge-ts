/**
 * Ctrl+C handling, the Node counterpart of Python's KeyboardInterrupt.
 *
 * The first Ctrl+C sets a flag; the session checks it between steps
 * (throwIfInterrupted) and unwinds so the recap is still printed. Pending
 * sleeps end early. A second Ctrl+C exits immediately.
 */
import { console } from "./console";

export const INTERRUPTED = "Interrupted (Ctrl+C)";

export class InterruptedError extends Error {
  override name = "KeyboardInterrupt";

  constructor() {
    super(INTERRUPTED);
  }
}

let interrupted = false;
const wakers = new Set<() => void>();

export function isInterrupted(): boolean {
  return interrupted;
}

export function throwIfInterrupted(): void {
  if (interrupted) {
    throw new InterruptedError();
  }
}

/** Lets sleep() end early on Ctrl+C. Returns an unregister function. */
export function onInterrupt(wake: () => void): () => void {
  wakers.add(wake);
  return () => wakers.delete(wake);
}

export function installInterruptHandler(): void {
  process.on("SIGINT", () => {
    if (interrupted) {
      console.print();
      console.markup("[yellow]‼[/yellow] Script dihentikan.");
      process.exit(130);
    }

    interrupted = true;

    for (const wake of [...wakers]) {
      wake();
    }
  });
}
