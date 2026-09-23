import pc from "picocolors";

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
};
