/**
 * Read what the page can see about the current "device".
 *
 * The probe does not guess from the user-agent alone. It checks the signals a
 * mobile detector actually uses: UA, User-Agent Client Hints, touch points,
 * viewport width, pixel ratio, pointer type and `navigator.webdriver`.
 *
 * A verdict of `isMobile` means every required signal agrees. Anything else is
 * reported per check, so a failure can be fixed instead of guessed.
 */
import type { WebDriver } from "selenium-webdriver";

export const MAX_MOBILE_WIDTH = 480;

const DESKTOP_PLATFORMS = new Set(["Win32", "Win64", "MacIntel"]);

const PROBE_JS = String.raw`
return (() => {
    const uaData = navigator.userAgentData;
    const media = (query) => {
        try {
            return window.matchMedia(query).matches;
        } catch (error) {
            return false;
        }
    };
    return {
        userAgent: navigator.userAgent || "",
        uaDataMobile: uaData && typeof uaData.mobile === "boolean"
            ? uaData.mobile
            : null,
        brands: uaData && uaData.brands
            ? uaData.brands.map((item) => item.brand + " " + item.version)
            : [],
        platform: navigator.platform || "",
        maxTouchPoints: navigator.maxTouchPoints || 0,
        touchEvents: "ontouchstart" in window,
        innerWidth: window.innerWidth || 0,
        innerHeight: window.innerHeight || 0,
        outerWidth: window.outerWidth || 0,
        outerHeight: window.outerHeight || 0,
        devicePixelRatio: window.devicePixelRatio || 1,
        screenWidth: screen.width || 0,
        screenHeight: screen.height || 0,
        pointerCoarse: media("(pointer: coarse)"),
        anyPointerCoarse: media("(any-pointer: coarse)"),
        hoverNone: media("(hover: none)"),
        viewportMeta: !!document.querySelector('meta[name="viewport"]'),
        language: navigator.language || "",
        webdriver: navigator.webdriver === true,
    };
})();
`;

/** One signal that was compared against what a phone should report. */
export interface Check {
  key: string;
  label: string;
  passed: boolean;
  required: boolean;
  detail: string;
}

export type Evidence = Record<string, unknown>;

/** Evidence and verdict of one probe run on one tab. */
export class ProbeResult {
  url = "";
  evidence: Evidence = {};
  checks: Check[] = [];
  error = "";

  get isMobile(): boolean {
    const required = this.checks.filter((check) => check.required);
    return required.length > 0 && required.every((check) => check.passed);
  }

  get requiredTotal(): number {
    return this.checks.filter((check) => check.required).length;
  }

  get requiredPassed(): number {
    return this.checks.filter((check) => check.required && check.passed).length;
  }

  get failed(): Check[] {
    return this.checks.filter((check) => check.required && !check.passed);
  }

  get score(): number {
    return this.requiredTotal ? Math.round((100 * this.requiredPassed) / this.requiredTotal) : 0;
  }

  get dimensions(): string {
    const width = Number(this.evidence["innerWidth"] ?? 0);
    const height = Number(this.evidence["innerHeight"] ?? 0);
    const ratio = Number(this.evidence["devicePixelRatio"] ?? 1) || 1;
    return `${width}×${height} @${ratio}x`;
  }

  /** One-line verdict for the terminal. */
  summary(): string {
    if (this.error) {
      return `probe gagal · ${this.error}`;
    }

    const head = this.isMobile ? "mobile ✓" : "bukan mobile ✗";
    const parts = [`${this.requiredPassed}/${this.requiredTotal} cek`, this.dimensions];

    const touch = Number(this.evidence["maxTouchPoints"] ?? 0);
    if (touch) {
      parts.push(`touch ${touch}`);
    }

    const hints = this.evidence["uaDataMobile"];
    if (hints === true) {
      parts.push("UA data ✓");
    } else if (hints === false) {
      parts.push("UA data ✗");
    }

    return `${head} · ${parts.join(" · ")}`;
  }

  asDict(): Record<string, unknown> {
    return {
      url: this.url,
      is_mobile: this.isMobile,
      score: this.score,
      summary: this.summary(),
      evidence: this.evidence,
      checks: this.checks,
      error: this.error,
    };
  }
}

/**
 * Inspect the current tab and decide whether it looks like a phone.
 *
 * `strict` also requires `navigator.userAgentData.mobile` to be true. With
 * `strict=false` the client-hint check only counts when the browser exposes
 * hints at all, which keeps older engines usable.
 */
export async function probe(driver: WebDriver, strict = true): Promise<ProbeResult> {
  const result = new ProbeResult();

  try {
    result.url = (await driver.getCurrentUrl()) || "";
  } catch {
    result.url = "";
  }

  let evidence: unknown;

  try {
    evidence = (await driver.executeScript(PROBE_JS)) ?? {};
  } catch (error) {
    // The probe must never crash a run.
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return result;
  }

  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    result.error = "probe returned no evidence";
    return result;
  }

  result.evidence = evidence as Evidence;
  result.checks = buildChecks(result.evidence, strict);

  return result;
}

function buildChecks(evidence: Evidence, strict = true): Check[] {
  const userAgent = String(evidence["userAgent"] ?? "");
  const hints = evidence["uaDataMobile"] as boolean | null | undefined;
  const touchPoints = Math.trunc(Number(evidence["maxTouchPoints"] ?? 0));
  const width = Math.trunc(Number(evidence["innerWidth"] ?? 0));
  const ratio = Number(evidence["devicePixelRatio"] ?? 1) || 1;
  const platform = String(evidence["platform"] ?? "");
  const pointerCoarse = Boolean(evidence["pointerCoarse"]);
  const viewportMeta = Boolean(evidence["viewportMeta"]);
  const webdriver = Boolean(evidence["webdriver"]);
  const outerWidth = Math.trunc(Number(evidence["outerWidth"] ?? 0));

  const uaMobile = ["Mobile", "Android", "iPhone", "iPad", "iPod"].some((token) => userAgent.includes(token));
  const hintsKnown = hints !== null && hints !== undefined;

  return [
    { key: "ua", label: "UA mobile", passed: uaMobile, required: true, detail: userAgent.slice(0, 80) },
    {
      key: "ua_data",
      label: "userAgentData.mobile",
      passed: hints === true,
      required: strict || hintsKnown,
      detail: !hintsKnown ? "tidak tersedia" : hints ? "true" : "false",
    },
    { key: "touch", label: "touch ≥ 1", passed: touchPoints >= 1, required: true, detail: String(touchPoints) },
    {
      key: "viewport",
      label: `viewport ≤ ${MAX_MOBILE_WIDTH}`,
      passed: width > 0 && width <= MAX_MOBILE_WIDTH,
      required: true,
      detail: String(width),
    },
    { key: "dpr", label: "DPR ≥ 2", passed: ratio >= 2, required: true, detail: String(ratio) },
    {
      key: "pointer",
      label: "(pointer: coarse)",
      passed: pointerCoarse,
      required: true,
      detail: pointerCoarse ? "true" : "false",
    },
    {
      key: "platform",
      label: "platform bukan desktop",
      passed: Boolean(platform) && !DESKTOP_PLATFORMS.has(platform),
      required: true,
      detail: platform || "-",
    },
    {
      key: "webdriver",
      label: "navigator.webdriver off",
      passed: !webdriver,
      required: true,
      detail: webdriver ? "true" : "false",
    },
    {
      key: "viewport_meta",
      label: "meta viewport",
      passed: viewportMeta,
      required: false,
      detail: viewportMeta ? "ada" : "tidak ada",
    },
    {
      key: "outer_width",
      label: "outerWidth ≤ 480",
      passed: outerWidth > 0 && outerWidth <= MAX_MOBILE_WIDTH,
      required: false,
      detail: String(outerWidth),
    },
  ];
}
