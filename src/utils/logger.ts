import pc from "picocolors";

export const logger = {
  title(message: string) {
    console.log();
    console.log(pc.bold(pc.white(message)));
    console.log();
  },

  info(message: string) {
    console.log(pc.dim(message));
  },

  success(message: string) {
    console.log(`  ${pc.green("✓")} ${message}`);
  },

  error(message: string) {
    console.log(`  ${pc.red("✗")} ${message}`);
  },

  warning(message: string) {
    console.log(`  ${pc.yellow("!")} ${message}`);
  },

  profile(current: number, total: number, name: string) {
    console.log(pc.dim(`profile ${current}/${total}`));

    console.log(pc.bold(name));
  },
};
