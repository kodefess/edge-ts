/**
 * Apply a mobile device profile through the Chrome DevTools Protocol.
 *
 * A user-agent string alone is not enough: Chromium derives the
 * `Sec-CH-UA-Mobile` client hint and `navigator.userAgentData` from the
 * metadata sent to `Network.setUserAgentOverride`, not from the UA text.
 * Without that metadata an Android UA on a desktop build looks like a bot.
 *
 * The overrides are scoped to one tab. Every new tab has to be emulated again
 * before it is navigated, which is what `openMobileTab` is for.
 */
import type { WebDriver } from "selenium-webdriver";

import type { Device } from "./devices";

export class MobileEmulationError extends Error {
  override name = "MobileEmulationError";
}

/** Chromium drivers (Edge, Chrome) expose the DevTools Protocol like this. */
interface CdpDriver {
  sendDevToolsCommand(command: string, params?: object): Promise<unknown>;
}

export function cdp(driver: WebDriver, command: string, params: object = {}): Promise<unknown> {
  return (driver as unknown as CdpDriver).sendDevToolsCommand(command, params);
}

/** The CDP commands that turn a desktop tab into a phone tab. */
export class MobileEmulation {
  constructor(readonly device: Device) {}

  /** Emulate `this.device` on the current tab. Safe to call more than once on the same tab. */
  async apply(driver: WebDriver): Promise<this> {
    const device = this.device;

    const commands: Array<[string, object]> = [
      [
        "Network.setUserAgentOverride",
        {
          userAgent: device.userAgent,
          acceptLanguage: device.acceptLanguage,
          platform: device.platformLegacy,
          userAgentMetadata: {
            brands: device.brands,
            fullVersionList: device.fullVersionList,
            fullVersion: device.fullVersion,
            platform: device.platform,
            platformVersion: device.platformVersion,
            architecture: device.architecture,
            model: device.model,
            mobile: true,
            bitness: "",
            wow64: false,
          },
        },
      ],
      [
        "Emulation.setDeviceMetricsOverride",
        {
          width: device.viewportWidth,
          height: device.viewportHeight,
          deviceScaleFactor: device.pixelRatio,
          mobile: true,
          screenWidth: device.viewportWidth,
          screenHeight: device.viewportHeight,
          screenOrientation: { type: "portraitPrimary", angle: 0 },
          positionX: 0,
          positionY: 0,
        },
      ],
      ["Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: device.touchPoints }],
    ];

    for (const [name, params] of commands) {
      try {
        await cdp(driver, name, params);
      } catch (error) {
        throw new MobileEmulationError(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await this.installDocumentScript(driver);

    return this;
  }

  /**
   * Keep window geometry and `navigator.webdriver` phone-like.
   *
   * CDP metrics change the viewport but not `window.outerWidth`, so a detector
   * comparing outer and inner size would still see the real window. Pinning
   * both for every new document of this tab also makes the `webdriver` patch
   * survive navigation.
   */
  private async installDocumentScript(driver: WebDriver): Promise<void> {
    const device = this.device;

    const source =
      "(function () {\n" +
      "  const define = (target, name, value) => {\n" +
      "    try {\n" +
      "      Object.defineProperty(target, name, {\n" +
      "        configurable: true,\n" +
      "        get: () => value,\n" +
      "      });\n" +
      "    } catch (error) {}\n" +
      "  };\n" +
      `  define(window, 'outerWidth', ${device.viewportWidth});\n` +
      `  define(window, 'outerHeight', ${device.viewportHeight});\n` +
      "  define(navigator, 'webdriver', undefined);\n" +
      "})();\n";

    try {
      await cdp(driver, "Page.enable", {});
      await cdp(driver, "Page.addScriptToEvaluateOnNewDocument", { source });
    } catch {
      // Geometry and the webdriver flag are then less consistent, but the
      // probe reports what actually happened.
    }
  }

  /** Remove the overrides from the current tab, ignoring errors. */
  async clear(driver: WebDriver): Promise<this> {
    const commands: Array<[string, object]> = [
      ["Network.setUserAgentOverride", { userAgent: "" }],
      ["Emulation.clearDeviceMetricsOverride", {}],
      ["Emulation.setTouchEmulationEnabled", { enabled: false }],
    ];

    for (const [name, params] of commands) {
      try {
        await cdp(driver, name, params);
      } catch {
        // Ignore.
      }
    }

    return this;
  }
}
