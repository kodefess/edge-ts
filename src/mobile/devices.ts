/**
 * Device presets used to emulate a phone in Edge.
 *
 * Only Android presets are provided on purpose. Chrome on Android exposes
 * User-Agent Client Hints, so the UA string, `navigator.userAgentData` and the
 * `Sec-CH-UA-*` request headers can all be kept consistent. iOS Safari has no
 * client hints, so forcing an iPhone UA on Edge would leave an obvious
 * mismatch between the UA and the rest of the fingerprint.
 *
 * The Chrome version in the UA is a preset on purpose: it is written before
 * the driver starts (`--user-agent`) and reused by the CDP metadata, so the
 * string and the client hints never disagree.
 */

/** Bump this in one place when the UA starts looking stale. */
export const DEFAULT_CHROME_MAJOR = "153";

export const DEFAULT_DEVICE = "pixel_7";

export class Device {
  readonly chromeMajor: string;
  readonly touchPoints: number;
  readonly acceptLanguage: string;

  constructor(
    readonly key: string,
    readonly name: string,
    readonly platformVersion: string,
    readonly model: string,
    readonly viewportWidth: number,
    readonly viewportHeight: number,
    readonly pixelRatio: number,
    options: { chromeMajor?: string; touchPoints?: number; acceptLanguage?: string } = {},
  ) {
    this.chromeMajor = options.chromeMajor ?? DEFAULT_CHROME_MAJOR;
    this.touchPoints = options.touchPoints ?? 5;
    this.acceptLanguage = options.acceptLanguage ?? "en-US,en;q=0.9";
  }

  /** Value reported by `navigator.platform` and in the hints. */
  get platform(): string {
    return "Android";
  }

  /** Legacy `navigator.platform` value for Android Chrome. */
  get platformLegacy(): string {
    return "Linux armv8l";
  }

  /** Architecture reported in the UA client hints. */
  get architecture(): string {
    return "arm";
  }

  get userAgent(): string {
    return (
      `Mozilla/5.0 (Linux; Android ${this.platformVersion}; ${this.model}) ` +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      `Chrome/${this.chromeMajor}.0.0.0 Mobile Safari/537.36`
    );
  }

  get fullVersion(): string {
    return `${this.chromeMajor}.0.0.0`;
  }

  get brands(): Array<{ brand: string; version: string }> {
    return [
      { brand: "Chromium", version: this.chromeMajor },
      { brand: "Google Chrome", version: this.chromeMajor },
      { brand: "Not?A_Brand", version: "24" },
    ];
  }

  get fullVersionList(): Array<{ brand: string; version: string }> {
    return this.brands.map((item) => ({
      brand: item.brand,
      version: item.brand !== "Not?A_Brand" ? this.fullVersion : "24.0.0.0",
    }));
  }
}

export const DEVICES: Record<string, Device> = {
  pixel_7: new Device("pixel_7", "Pixel 7", "14", "Pixel 7", 412, 915, 2.625),
  pixel_8: new Device("pixel_8", "Pixel 8", "14", "Pixel 8", 412, 915, 2.625),
  galaxy_s23: new Device("galaxy_s23", "Galaxy S23", "13", "SM-S911B", 360, 780, 3.0),
};

/** The available preset keys for error messages and help text. */
export function deviceNames(): string {
  return Object.keys(DEVICES).sort().join(", ");
}

/** Resolve a device preset by key, with a helpful error. */
export function getDevice(key?: string): Device {
  const normalized = (key || DEFAULT_DEVICE).trim().toLowerCase();
  const device = DEVICES[normalized];

  if (!device) {
    throw new Error(`Unknown mobile device: ${JSON.stringify(key)}. Available: ${deviceNames()}`);
  }

  return device;
}
