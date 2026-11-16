/**
 * Low-level page helpers for the Bing Rewards dashboard.
 *
 * Microsoft changes the rewards markup regularly, so every lookup here has a
 * CSS fallback and a text fallback. Nothing in this module throws when a
 * selector stops matching: the caller gets an empty result and moves on.
 *
 * The current rewards UI is a React app. The stable anchors we rely on are:
 *
 * - `#dailyset` – the daily-set section; its cards are plain links.
 * - Category cards – `<button>` elements that contain a `role=progressbar`
 *   with `aria-valuenow` / `aria-valuemax` and text such as
 *   `Visual Search Activity: 0/1 1`. Clicking one opens a `role=dialog`
 *   flyout with the real action (for example `Search now`).
 * - The `Keep earning` section on `/earn` – plain task links whose text
 *   ends with `Completed` or a progress counter.
 */

import { By, error, type WebDriver, type WebElement } from "selenium-webdriver";

import { sleep } from "../utils/delay";

// ============================================================
// TYPES
// ============================================================

export interface CardProgress {
  done: number;
  total: number;
}

/** One entry returned by SCAN_JS. */
export interface Card {
  index: number;
  group: string;
  kind: string;
  label: string;
  title: string;
  href: string;
  progress: CardProgress | null;
  points: number | null;
  completed: boolean;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  mode?: string;
  href?: string;
  text?: string;
}

export interface DialogInfo {
  open: boolean;
  text: string;
  actions: { text: string; href: string }[];
}

export interface QuizResult {
  option?: boolean;
  next?: boolean;
}

export interface AccountInfo {
  name: string;
  email: string;
}

export interface PerkItem {
  text: string;
  href: string;
  tag: string;
  claimed: boolean;
}

export interface PerksInfo {
  found: boolean;
  total: number;
  items: PerkItem[];
}

/** Python's `except WebDriverException`: only Selenium errors are swallowed. */
function isWebDriverError(e: unknown): boolean {
  return e instanceof error.WebDriverError;
}

/** Python's `type(e).__name__`. */
function errorName(e: unknown): string {
  if (e instanceof Error) return e.name || e.constructor.name;
  return typeof e;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================
// JAVASCRIPT
// ============================================================

export const SCAN_JS = String.raw`
const found = (() => {
    const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

    const visible = (el) => {
        if (!el) return false;
        try {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return (
                rect.width > 2 &&
                rect.height > 2 &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0'
            );
        } catch (e) {
            return false;
        }
    };

    const progressOf = (el) => {
        const bar = el.querySelector('[role="progressbar"]');
        if (!bar) return null;

        const done = parseInt(bar.getAttribute('aria-valuenow') || '', 10);
        const total = parseInt(bar.getAttribute('aria-valuemax') || '', 10);

        if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) {
            return null;
        }

        return { done: done, total: total };
    };

    const textProgress = (text) => {
        let last = null;
        const pattern = /(\d+)\s*\/\s*(\d+)/g;
        let match;

        while ((match = pattern.exec(text))) {
            const done = parseInt(match[1], 10);
            const total = parseInt(match[2], 10);

            if (total > 0 && done <= total) {
                last = { done: done, total: total };
            }
        }

        return last;
    };

    // Reward cards show their point value in a small text-metadata
    // chip, for example "10" or "+10".
    const pointOf = (el) => {
        for (const node of el.querySelectorAll('p, span')) {
            const cls = String(node.className || '');

            if (!cls.includes('text-metadata')) continue;

            const text = norm(node.innerText || node.textContent);
            const match = text.match(/^\+?(\d{1,5})$/);

            if (match) return parseInt(match[1], 10);
        }

        return null;
    };

    const isDone = (el, text, progress) => {
        if (/\b(completed|selesai|sudah selesai|done|tercentang)\b/i.test(text)) {
            return true;
        }

        if (progress && progress.total > 0) {
            return progress.done >= progress.total;
        }

        for (const attr of [
            'aria-checked',
            'aria-selected',
            'data-completed',
            'data-done',
            'data-state',
        ]) {
            const value = (el.getAttribute(attr) || '').toLowerCase();

            if (['true', 'checked', 'completed', 'done', 'selesai'].includes(value)) {
                return true;
            }
        }

        for (const node of el.querySelectorAll(
            '[aria-label], [class], [data-testid], [data-state]'
        )) {
            const label = (node.getAttribute('aria-label') || '').toLowerCase();

            if (/\b(completed|selesai|done|checked)\b/.test(label)) return true;

            const state = (node.getAttribute('data-state') || '').toLowerCase();

            if (['checked', 'completed', 'done'].includes(state)) return true;

            const testid = (node.getAttribute('data-testid') || '').toLowerCase();

            if (/\b(completed|checked|success)\b/.test(testid)) return true;

            const cls = String(node.className || '').toLowerCase();

            if (/\b(completed|checked|checkmark|success)\b/.test(cls)) return true;
        }

        return false;
    };

    const usableHref = (href) => {
        const value = (href || '').trim();
        if (!value) return false;

        const lower = value.toLowerCase();

        return !lower.startsWith('javascript:') && value !== '#';
    };

    const taskHref = (href) => {
        try {
            const url = new URL(href, location.href);
            const host = url.hostname.toLowerCase();

            if (!host.endsWith('bing.com')) return false;
            if (host.endsWith('rewards.bing.com')) return false;

            return true;
        } catch (e) {
            return false;
        }
    };

    const entries = [];
    const seen = new Set();

    const add = (group, el, kind, label) => {
        if (!el || seen.has(el) || !visible(el)) return;

        // Skip a nested link/button when its clickable ancestor was
        // already added, so one card is not counted twice.
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
            if (seen.has(parent)) return;
        }

        const text = norm(el.innerText || el.textContent);
        if (!text || text.length < 3) return;

        const progress = progressOf(el) || textProgress(text);

        let href = '';
        try {
            href = el.href || '';
        } catch (e) {
            href = '';
        }

        if (!href && kind === 'link') {
            const link = el.querySelector('a[href]');
            if (link) {
                try {
                    href = link.href || '';
                } catch (e) {
                    href = '';
                }
            }
        }

        seen.add(el);
        entries.push({
            el: el,
            group: group,
            kind: kind,
            label: norm(label || ''),
            text: text,
            href: href,
            progress: progress,
            points: pointOf(el),
            completed: isDone(el, text, progress),
        });
    };

    // --- Dashboard: daily-set cards ------------------------
    // The section id is not always present in newer builds, so also
    // find it by its heading or aria-label.
    const dailyRoots = new Set();
    const dailyById = document.querySelector('#dailyset');

    if (dailyById) dailyRoots.add(dailyById);

    for (const heading of document.querySelectorAll(
        'h1, h2, h3, h4, [role="heading"]'
    )) {
        const text = norm(heading.innerText || heading.textContent);

        if (!/^(daily set|set harian)\b/i.test(text)) continue;

        // Prefer the closest ancestor that holds the whole card row
        // (at least two clickable cards), not just a single card.
        let root = null;
        let candidate = heading.parentElement;

        for (let depth = 0; candidate && depth < 5; depth += 1) {
            const count = candidate.querySelectorAll(
                'a[href], button, [role="button"]'
            ).length;

            if (count >= 2) {
                root = candidate;
                break;
            }

            if (!root && count) root = candidate;

            candidate = candidate.parentElement;
        }

        if (root) dailyRoots.add(root);
    }

    for (const el of document.querySelectorAll(
        '[aria-label*="daily set" i], [aria-label*="set harian" i]'
    )) {
        dailyRoots.add(el);
    }

    for (const root of dailyRoots) {
        for (const el of root.querySelectorAll(
            'a[href], button, [role="button"]'
        )) {
            const href = el.getAttribute('href') || '';

            if (el.tagName === 'A' && !usableHref(href)) continue;

            const text = norm(el.innerText || el.textContent);

            if (!text || text.length < 3) continue;

            add('daily', el, el.tagName === 'A' ? 'link' : 'button');
        }
    }

    const inDaily = (el) => {
        for (const root of dailyRoots) {
            if (root === el || root.contains(el)) return true;
        }

        return false;
    };

    // --- Dashboard: category cards -------------------------
    // They look like "Bing Search: 1/1 4" and open a
    // role="dialog" flyout with the real action.
    for (const button of document.querySelectorAll('button')) {
        if (inDaily(button)) continue;

        const bar = button.querySelector('[role="progressbar"]');
        if (!bar) continue;

        const text = norm(button.innerText || button.textContent);
        if (!/:\s*\d+\s*\/\s*\d+/.test(text)) continue;

        let label = norm(bar.getAttribute('aria-label') || '');
        if (!label) label = text.split(':')[0].trim();

        add('category', button, 'button', label);
    }

    // --- /earn: Keep earning -------------------------------
    const keep = [...document.querySelectorAll('h1, h2, h3, h4')].find(
        (node) => /^keep earning\b/i.test(
            norm(node.innerText || node.textContent)
        )
    );

    if (keep) {
        let root = keep.closest('section') || keep.parentElement;
        let best = root;

        for (let depth = 0; root && depth < 5; depth += 1) {
            const count = root.querySelectorAll(
                'a[href], button, [role="button"]'
            ).length;

            if (count) best = root;
            if (count >= 2) break;

            root = root.parentElement;
        }

        if (best) {
            for (const el of best.querySelectorAll(
                'a[href], button, [role="button"]'
            )) {
                const href = el.getAttribute('href') || '';

                if (
                    el.tagName === 'A' &&
                    (!usableHref(href) || !taskHref(href))
                ) {
                    continue;
                }

                const text = norm(el.innerText || el.textContent);
                if (text.length < 3) continue;
                if (
                    /^(see more|view all|show more|learn more|how it works|redeem|tukar|terms|help)$/i.test(
                        text
                    )
                ) {
                    continue;
                }

                add('earn', el, el.tagName === 'A' ? 'link' : 'button');
            }
        }
    }

    // --- Optional "more activities" section ----------------
    const more = document.querySelector('#more-activities');

    if (more) {
        for (const link of more.querySelectorAll('a[href]')) {
            const href = link.getAttribute('href') || '';
            if (!usableHref(href) || !taskHref(href)) continue;
            add('more', link, 'link');
        }
    }

    entries.sort((a, b) => {
        const ra = a.el.getBoundingClientRect();
        const rb = b.el.getBoundingClientRect();
        return (ra.top - rb.top) || (ra.left - rb.left);
    });

    window.__edgepyCards = [];

    const result = [];

    entries.forEach((entry, index) => {
        result.push({
            index: index,
            group: entry.group,
            kind: entry.kind,
            label: entry.label,
            title: entry.text.slice(0, 200),
            href: entry.href,
            progress: entry.progress,
            points: entry.points,
            completed: entry.completed,
        });

        window.__edgepyCards.push(entry.el);
    });

    return result;
})();

return found;
`;

export const CLICK_JS = String.raw`
const cards = window.__edgepyCards || [];
const card = cards[arguments[0]];

if (!card) {
    return { ok: false, reason: 'card-not-found' };
}

const newTab = arguments[1] !== false;

const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const ACTION = /^(search now|search|start|start now|complete|complete task|earn|earn points|join|join now|play|play now|answer|take quiz|take the quiz|cari sekarang|cari|mulai|mulai sekarang|selesaikan|kerjakan|kerjakan sekarang)$/i;

const isButton =
    card.tagName === 'BUTTON' ||
    (card.getAttribute && card.getAttribute('role') === 'button');

if (isButton) {
    try {
        card.scrollIntoView({ block: 'center' });
        card.click();
        return { ok: true, mode: 'button' };
    } catch (e) {
        return { ok: false, reason: String(e) };
    }
}

let target = null;

if (card.tagName === 'A' && card.href) target = card;

if (!target && card.querySelector) {
    for (const node of card.querySelectorAll(
        'button, a, [role="button"], input[type="button"], ' +
        'input[type="submit"]'
    )) {
        const text = norm(
            node.innerText || node.value || node.textContent
        );

        if (ACTION.test(text)) {
            target = node;
            break;
        }
    }
}

if (!target && card.querySelector) {
    target = card.querySelector('a[href]');
}

if (!target) target = card;

let href = '';

try {
    href = target.href ? target.href : '';
} catch (e) {
    href = '';
}

const unusable =
    !href ||
    href.toLowerCase().startsWith('javascript:') ||
    href.endsWith('#');

if (newTab && !unusable) {
    try {
        const opened = window.open(href, '_blank');
        if (opened) {
            return { ok: true, mode: 'window-open', href: href };
        }
    } catch (e) {
        // Fall through to a normal click.
    }
}

try {
    target.click();
    return { ok: true, mode: 'click', href: href };
} catch (e) {
    return { ok: false, reason: String(e) };
}
`;

export const DEEP_QUERY_JS = String.raw`
const deepAll = (selector, root) => {
    const out = [];
    const seen = new Set();

    const walk = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);

        // A custom element passed as the root has its content inside
        // its own shadow root, so walk that first.
        if (node.shadowRoot) walk(node.shadowRoot);

        if (node.querySelectorAll) {
            for (const el of node.querySelectorAll(selector)) out.push(el);
            for (const el of node.querySelectorAll('*')) {
                if (el.shadowRoot) walk(el.shadowRoot);
            }
        }
    };

    walk(root || document);
    return out;
};
`;

export const CLAIM_JS = DEEP_QUERY_JS + String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
        );
    } catch (e) {
        return false;
    }
};

const disabled = (el) =>
    el.disabled || el.getAttribute('aria-disabled') === 'true';

const textOf = (el) => norm(el.innerText || el.value || el.textContent || '');

const hintOf = (el) =>
    norm([
        el.getAttribute('aria-label') || '',
        el.getAttribute('data-testid') || '',
        String(el.className || ''),
        textOf(el),
    ].join(' ')).replace(/[\s>›»→]+$/g, '');

// The membership/level card sits right next to the claim box. It has
// its own "Learn more" style button and must never be clicked.
const MEMBERSHIP = /(your membership|membership|level\s*[0-9]|gold|silver|bronze|tier|benefit|learn more|upgrade|join now|status)/i;

const READY = /ready\s*to\s*claim|siap\s*klaim|siap\s*diklaim/i;

const countIn = (text) => {
    const after = (text || '').match(
        /(?:ready\s*to\s*claim|siap\s*klaim|siap\s*diklaim)\s*[:·]?\s*(\d[\d.,]*)/i
    );

    if (after) {
        return parseInt(after[1].replace(/[^\d]/g, ''), 10);
    }

    const before = (text || '').match(
        /(\d[\d.,]*)\s*(?:points?\s*)?(?:ready\s*to\s*claim|siap\s*klaim|siap\s*diklaim)/i
    );

    if (before) {
        return parseInt(before[1].replace(/[^\d]/g, ''), 10);
    }

    return null;
};

// The element is handed back to Python, which clicks it natively.
// A native click is a trusted event; React claim handlers can ignore
// a synthetic el.click().
const pick = (el, label) => ({ element: el, label: label || 'claim' });

const pointer = (el) => {
    try {
        return window.getComputedStyle(el).cursor === 'pointer';
    } catch (e) {
        return false;
    }
};

// The "Ready to claim" card is often a plain <div> with a React onClick
// (no role, no tag hint); a pointer cursor or tabindex gives it away.
const clickable = (el) =>
    !!el &&
    !!el.getAttribute &&
    (el.tagName === 'BUTTON' ||
        el.tagName === 'A' ||
        el.tagName === 'MEE-BUTTON' ||
        el.getAttribute('role') === 'button' ||
        el.getAttribute('role') === 'link' ||
        el.hasAttribute('tabindex') ||
        typeof el.onclick === 'function' ||
        pointer(el) ||
        /claim|klaim/i.test(String(el.className || '')));

// Own text of an element: "Claim" in <span>Claim<svg/></span>.
const ownText = (el) =>
    norm(
        Array.from(el.childNodes || [])
            .filter((n) => n.nodeType === 3)
            .map((n) => n.textContent)
            .join(' ')
    );

// 1) Find the smallest element that holds "Ready to claim N".
//    Only that box (and what is inside it) may be clicked.
const boxes = [];

for (const el of deepAll('*')) {
    if (!visible(el)) continue;

    const text = norm(
        (el.getAttribute('aria-label') || '') + ' ' + textOf(el)
    );

    if (!text || text.length > 220) continue;
    if (!READY.test(text)) continue;
    if (MEMBERSHIP.test(text)) continue;

    const count = countIn(text);

    if (count === null || count <= 0) continue;

    boxes.push({ el: el, count: count, size: text.length });
}

boxes.sort((a, b) => a.size - b.size);

for (const box of boxes) {
    // When the box lives inside a web component, search its shadow
    // root so the real button is reachable.
    let root = box.el;
    let host = null;
    const nodeRoot = box.el.getRootNode ? box.el.getRootNode() : null;

    if (nodeRoot && nodeRoot.host) {
        root = nodeRoot;
        host = nodeRoot.host;
    }

    const controls = [];

    if (host && clickable(host)) controls.push(host);
    if (clickable(root)) controls.push(root);

    for (const el of deepAll(
        'button, a, [role="button"], mee-button, ' +
        'input[type="button"], input[type="submit"], [class*="claim"]',
        root
    )) {
        if (el === root) continue;
        controls.push(el);
    }

    const usable = controls.filter((el) => {
        if (!visible(el) || disabled(el)) return false;

        const hint = hintOf(el);

        if (MEMBERSHIP.test(hint)) return false;
        if (el !== root && READY.test(textOf(el))) return false;

        return true;
    });

    // 2) A real claim control inside the box (never the box itself).
    for (const el of usable) {
        if (el === root || el === host) continue;
        if (!/claim|klaim/i.test(hintOf(el))) continue;

        return pick(el, textOf(el) || el.getAttribute('aria-label'));
    }

    // 3) The "Claim >" label inside the card, whatever its tag. A native
    //    click on it bubbles up to the card's own handler.
    for (const el of deepAll('*', root)) {
        if (el === root || !visible(el)) continue;
        if (!/^(claim|klaim)\b/i.test(ownText(el) || textOf(el))) continue;
        if (textOf(el).length > 20) continue;

        return pick(el, textOf(el) || 'Claim');
    }

    // 4) An icon-only claim button inside the box.
    for (const el of usable) {
        if (el === root || el === host) continue;
        if (textOf(el)) continue;

        return pick(el, 'claim');
    }

    // 5) The box itself is the clickable card.
    const target = host || root;

    if (clickable(target)) return pick(target, 'claim');

    // 6) The clickable card is an ancestor of the smallest box.
    let node = (host || box.el).parentElement;

    for (let depth = 0; depth < 5 && node; depth += 1) {
        if (node === document.body) break;

        const text = textOf(node);

        if (text.length > 220 || MEMBERSHIP.test(text)) break;
        if (clickable(node) && visible(node)) return pick(node, 'claim');

        node = node.parentElement;
    }
}

return null;
`;

export const CONFIRM_CLAIM_JS = DEEP_QUERY_JS + String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
        );
    } catch (e) {
        return false;
    }
};

const textOf = (el) => norm(el.innerText || el.value || el.textContent || '');

const own = (el) =>
    norm(
        el.innerText ||
        el.value ||
        el.getAttribute('aria-label') ||
        ''
    ).replace(/[\s>›»→]+$/g, '');

const patterns = /^(claim|claim all|claim now|claim points?|claim rewards?|claim prize|confirm|confirm claim|yes|ok|klaim|klaim semua|klaim sekarang|klaim poin|klaim hadiah|konfirmasi|ya|oke)$/i;

const MEMBERSHIP = /(your membership|membership|level\s*[0-9]|gold|silver|bronze|tier|benefit|learn more|upgrade|join now)/i;

const READY = /ready\s*to\s*claim|siap\s*klaim|siap\s*diklaim/i;

const inClaimBox = (el) => {
    let node = el;

    for (let depth = 0; depth < 3 && node; depth += 1) {
        if (node === document.body || node === document.documentElement) {
            break;
        }

        const text = textOf(node);

        if (text && text.length < 220 && READY.test(text)) return true;

        node = node.parentElement;
    }

    return false;
};

// Python clicks the returned element natively (trusted event).
// The panel's own "Claim points" button wins over generic labels.
const PRIMARY = /^(claim points?|claim all|claim now|claim rewards?|klaim poin|klaim semua|klaim sekarang)$/i;

const pick = (el, label) => ({ element: el, label: label });

const disabled = (el) =>
    el.disabled ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.hasAttribute('data-disabled');

const HEADING = /^H[1-6]$/;

const looksLikeControl = (el) => {
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return true;
    if (el.getAttribute('role') === 'button' || el.hasAttribute('tabindex')) return true;
    if (typeof el.onclick === 'function') return true;
    try {
        if (window.getComputedStyle(el).cursor === 'pointer') return true;
    } catch (e) {}
    // Fluent/Tailwind controls: "bg-bgCtrlBrandRest", "min-h-sizeCtrl...".
    return /Ctrl|btn|button/i.test(String(el.className || ''));
};

// The "Claim points" control in the side panel is a styled <div> with a
// <span> inside (no <button>, no role), so find it by its exact text.
// The panel title says "Claim points" too; headings are skipped.
const byText = () => {
    const found = [];

    for (const el of deepAll('*')) {
        if (HEADING.test(el.tagName) || el.getAttribute('role') === 'heading') continue;
        if (!PRIMARY.test(textOf(el))) continue;
        if (!visible(el) || inClaimBox(el)) continue;

        // Climb to the outermost element that still holds only this
        // label: the <div> control around the <span>.
        let node = el;
        while (
            node.parentElement &&
            !HEADING.test(node.parentElement.tagName) &&
            textOf(node.parentElement) === textOf(el)
        ) {
            node = node.parentElement;
        }

        if (disabled(node) || found.includes(node)) continue;
        found.push(node);
    }

    const control = found.find(looksLikeControl) || found[0];
    return control ? pick(control, textOf(control)) : null;
};

const best = (list) => {
    const ok = list.filter((el) => {
        if (!visible(el) || disabled(el)) return false;
        const label = own(el);
        return patterns.test(label) && !MEMBERSHIP.test(label) && !inClaimBox(el);
    });
    const primary = ok.find((el) => PRIMARY.test(own(el)));
    const el = primary || ok[0];
    return el ? pick(el, own(el)) : null;
};

const BUTTONS =
    'button, a, [role="button"], input[type="button"], ' +
    'input[type="submit"], mee-button';

// The popup may be a role=dialog, a plain modal div, or a web
// component with its own shadow root.
const dialogs = deepAll(
    '[role="dialog"], [aria-modal="true"], dialog, mee-dialog, ' +
    '[class*="dialog"], [class*="modal"], [class*="popup"], ' +
    '[class*="flyout"], [class*="overlay"]'
).filter((el) => visible(el) && textOf(el));

// 0) The panel's "Claim points" control, whatever its tag.
const direct = byText();
if (direct) return direct;

// 1) Confirm inside the top-most popup.
for (const scope of dialogs.slice().reverse()) {
    const found = best(deepAll(BUTTONS, scope));
    if (found) return found;
}

// 2) Popup without a dialog role: a visible Claim/Confirm button that
//    is not the "Ready to claim" box itself.
return best(deepAll(BUTTONS));
`;

export const CLAIMABLE_JS = DEEP_QUERY_JS + String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const textOf = (el) => norm(el.innerText || el.textContent || '');

const MEMBERSHIP = /(your membership|membership|level\s*[0-9]|gold|silver|bronze|tier|benefit|learn more|upgrade|join now|status)/i;

const patterns = [
    /(?:ready\s*to\s*claim|siap\s*klaim|siap\s*diklaim)\s*[:·]?\s*(\d[\d.,]*)/i,
    /(\d[\d.,]*)\s*(?:points?\s*)?(?:ready\s*to\s*claim|siap\s*klaim|siap\s*diklaim)/i,
];

let best = null;

for (const el of deepAll(
    'button, a, [role="button"], [aria-label], p, span, div, section, article'
)) {
    const text = norm(
        (el.getAttribute('aria-label') || '') + ' ' + textOf(el)
    );

    if (!text || text.length > 160) continue;
    if (MEMBERSHIP.test(text)) continue;

    for (const pattern of patterns) {
        const match = text.match(pattern);

        if (!match) continue;

        const value = parseInt(match[1].replace(/[^\d]/g, ''), 10);

        if (!Number.isFinite(value)) continue;

        // Prefer the smallest box: "Ready to claim 3" beats a whole
        // section that happens to contain the same words.
        if (best === null || text.length < best.size) {
            best = { value: value, size: text.length };
        }
    }
}

return best ? best.value : null;
`;

export const DISMISS_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();

const labels = new Set([
    'no thanks',
    'not now',
    'maybe later',
    'tidak, terima kasih',
    'tidak terima kasih',
    'nanti saja',
    'lain kali',
    'got it',
    'mengerti',
    'tutup',
    'dismiss',
]);

const scope = document.querySelector(
    '[role="dialog"], [class*="dialog"], [class*="modal"], [class*="popup"]'
);

if (!scope) return 0;

let clicked = 0;

for (const el of scope.querySelectorAll(
    'button, a, [role="button"]'
)) {
    const text = norm(el.innerText || el.textContent);

    if (!labels.has(text)) continue;

    try {
        el.click();
        clicked += 1;
    } catch (e) {
        // Ignore.
    }

    if (clicked >= 2) break;
}

return clicked;
`;

export const DIALOG_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    } catch (e) {
        return false;
    }
};

const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
    (el) => visible(el) && norm(el.innerText || el.textContent)
);

const dialog = dialogs[dialogs.length - 1];

if (!dialog) return { open: false, text: '', actions: [] };

const actions = [];

for (const el of dialog.querySelectorAll(
    'a[href], button, [role="button"]'
)) {
    if (!visible(el)) continue;

    const label = norm(
        el.innerText || el.value || el.textContent
    ).replace(/[\s>›»→]+$/g, '');

    if (!label || label.length > 60) continue;

    if (/^(close|dismiss|tutup|how it works|learn more)$/i.test(label)) {
        continue;
    }

    let href = '';
    try {
        href = el.href || '';
    } catch (e) {
        href = '';
    }

    actions.push({ text: label, href: href });
}

return {
    open: true,
    text: norm(dialog.innerText || dialog.textContent).slice(0, 600),
    actions: actions,
};
`;

export const DIALOG_ACTION_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    } catch (e) {
        return false;
    }
};

const ACTION = /^(search now|search|start|start now|complete|complete task|play|play now|answer|take quiz|take the quiz|join|join now|earn|earn points|cari sekarang|cari|mulai|mulai sekarang|selesaikan|kerjakan|kerjakan sekarang)$/i;

const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
    (el) => visible(el) && norm(el.innerText || el.textContent)
);

const dialog = dialogs[dialogs.length - 1];

if (!dialog) return { ok: false, reason: 'no-dialog' };

for (const el of dialog.querySelectorAll(
    'a[href], button, [role="button"]'
)) {
    if (!visible(el)) continue;

    const label = norm(
        el.innerText || el.value || el.textContent
    ).replace(/[\s>›»→]+$/g, '');

    if (!ACTION.test(label)) continue;

    let href = '';
    try {
        href = el.href || '';
    } catch (e) {
        href = '';
    }

    const unusable =
        !href ||
        href.toLowerCase().startsWith('javascript:') ||
        href.endsWith('#');

    if (!unusable) {
        try {
            const opened = window.open(href, '_blank');
            if (opened) {
                return {
                    ok: true,
                    mode: 'window-open',
                    text: label,
                    href: href,
                };
            }
        } catch (e) {
            // Fall through to a normal click.
        }
    }

    try {
        el.click();
        return { ok: true, mode: 'click', text: label, href: href };
    } catch (e) {
        return { ok: false, reason: String(e) };
    }
}

return { ok: false, reason: 'no-action' };
`;

export const CLOSE_DIALOG_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    } catch (e) {
        return false;
    }
};

const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(
    (el) => visible(el) && norm(el.innerText || el.textContent)
);

const dialog = dialogs[dialogs.length - 1];

if (!dialog) return false;

const candidates = dialog.querySelectorAll(
    '[slot="close"], [aria-label="Close"], [aria-label="Tutup"], ' +
    'button, a, [role="button"]'
);

for (const el of candidates) {
    if (!visible(el)) continue;

    const label = norm(
        el.getAttribute('aria-label') ||
        el.innerText ||
        el.textContent
    );

    if (/^(close|dismiss|tutup)$/i.test(label)) {
        try {
            el.click();
            return true;
        } catch (e) {
            // Try the next candidate.
        }
    }
}

try {
    document.dispatchEvent(
        new KeyboardEvent('keydown', {
            key: 'Escape',
            keyCode: 27,
            bubbles: true,
        })
    );
} catch (e) {
    // Ignore.
}

return false;
`;

export const QUIZ_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    } catch (e) {
        return false;
    }
};

const optionSelectors = [
    '[role="radio"]',
    'input[type="radio"]',
    '[class*="answer"]',
    '[class*="option"]',
    'label',
];

let option = null;

for (const selector of optionSelectors) {
    for (const el of document.querySelectorAll(selector)) {
        if (!visible(el)) continue;
        if (el.checked) continue;
        option = el;
        break;
    }
    if (option) break;
}

let optionClicked = false;

if (option) {
    try {
        option.click();
        optionClicked = true;
    } catch (e) {
        optionClicked = false;
    }
}

const nextPattern = /^(next|berikutnya|lanjut|continue|submit|kirim|selesai|finish|done)$/i;

let nextClicked = false;

for (const el of document.querySelectorAll(
    'button, a, [role="button"], input[type="submit"]'
)) {
    if (!visible(el)) continue;

    const text = norm(el.innerText || el.value || el.textContent);

    if (!nextPattern.test(text)) continue;

    try {
        el.click();
        nextClicked = true;
        break;
    } catch (e) {
        // Ignore.
    }
}

return { option: optionClicked, next: nextClicked };
`;

export const UPLOAD_CONTROLS_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const pattern = /(upload|unggah|camera|kamera|visual search|search with an image|search using an image|cari dengan gambar|telusuri dengan gambar)/i;

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return (
            rect.width > 2 &&
            rect.height > 2 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
        );
    } catch (e) {
        return false;
    }
};

const candidates = document.querySelectorAll(
    '#sb_sbi, #sb_brtext, #sb_fileinput, ' +
    'button, a, label, [role="button"], input[type="button"], ' +
    '[aria-label], [title]'
);

let clicked = 0;

for (const el of candidates) {
    const label = norm(
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.innerText ||
        el.textContent
    );

    if (!label || label.length > 80) continue;
    if (!pattern.test(label)) continue;
    if (!visible(el)) continue;

    try {
        el.click();
        clicked += 1;
    } catch (e) {
        // Ignore.
    }

    if (clicked >= 2) break;
}

return clicked;
`;

export const POINTS_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const parse = (text) => {
    const match = (text || '').match(/(\d[\d.,]*)/);

    if (!match) return null;

    const digits = match[1].replace(/[^\d]/g, '');

    return digits ? parseInt(digits, 10) : null;
};

const pointsIn = (text) => {
    const match = (text || '').match(/(\d[\d.,]*)\s*(?:points?|poin)\b/i);

    return match ? parse(match[1]) : null;
};

const availableIn = (text) => {
    const match =
        (text || '').match(/available points\s*[:·]?\s*(\d[\d.,]*)/i) ||
        (text || '').match(/(\d[\d.,]*)\s*available points/i);

    return match ? parse(match[1]) : null;
};

// Task cards also contain "points"; never mistake them for the balance.
const TASK = /(search|daily|task|activity|earn|complete|quiz|poll|photo|visual|redeem|claim)/i;

// 1) Classic Bing balance element.
const selectors = [
    '#id_rc',
    '#balance',
    '[data-testid*="balance"]',
    '[class*="balance"]',
    '[id*="balance"]',
];

for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
        const text = norm(el.innerText || el.textContent);
        if (!text || text.length > 60) continue;

        const value = pointsIn(text);

        if (value !== null) return value;

        const fallback = parse(text);

        if (fallback !== null) return fallback;
    }
}

// 2) Profile button: "Abu Mujari. 6,979 points. View profile".
for (const el of document.querySelectorAll('[aria-label]')) {
    const label = norm(el.getAttribute('aria-label') || '');

    if (!/(points?|poin)/i.test(label)) continue;
    if (TASK.test(label)) continue;
    if (!/\.\s*[\d,.]+\s*(?:points?|poin)\b/i.test(label)) continue;

    const value = pointsIn(label);

    if (value !== null) return value;
}

// 3) The "Available points" summary card.
for (const el of document.querySelectorAll('a, section, article, div, p, span')) {
    const own = norm(el.innerText || el.textContent);

    if (!/available points/i.test(own)) continue;

    let node = el;

    for (let depth = 0; node && depth < 3; depth += 1) {
        if (node === document.body || node === document.documentElement) break;

        const text = norm(node.innerText || node.textContent);

        if (text && text.length <= 160) {
            const value = availableIn(text) ?? pointsIn(text);

            if (value !== null) return value;

            const fallback = parse(text);

            if (fallback !== null) return fallback;
        }

        node = node.parentElement;
    }
}

// 4) Any remaining points label that is not a task card.
for (const el of document.querySelectorAll('[aria-label]')) {
    const label = norm(el.getAttribute('aria-label') || '');

    if (!/(points?|poin)/i.test(label)) continue;
    if (TASK.test(label)) continue;

    const value = pointsIn(label);

    if (value !== null) return value;
}

return null;
`;

export const ACCOUNT_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
const lower = (t) => norm(t).toLowerCase();

let name = '';
let email = '';

const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

// Common Bing/MSA identity nodes.
const idName = norm(
    (document.querySelector('#id_n, #id_pn, [data-testid*="profile"] .name') || {}).innerText ||
    (document.querySelector('#id_n, #id_pn') || {}).textContent ||
    ''
);

if (idName && !/@/.test(idName)) name = idName;

// Profile/points aria-label often starts with the account name.
for (const el of document.querySelectorAll('[aria-label]')) {
    const label = norm(el.getAttribute('aria-label') || '');

    if (!label) continue;

    const m = label.match(/^(.*?)\.\s*[\d,.]+\s*(?:points?|poin)\b/i);
    if (!name && m && m[1] && !/@/.test(m[1])) {
        name = norm(m[1]);
    }

    if (!email) {
        const em = label.match(emailRe);
        if (em) email = em[0];
    }
}

if (!email) {
    const meta = document.querySelector(
        'meta[name="user-email"], meta[name="email"], [data-email]'
    );
    if (meta) {
        email = norm(meta.getAttribute('content') || meta.getAttribute('data-email') || '');
    }
}

if (!email) {
    // Scan a small, focused set of likely account containers first.
    const nodes = document.querySelectorAll(
        '#id_l, #id_n, [id*="account"], [class*="account"], [class*="profile"], header, nav'
    );
    for (const el of nodes) {
        const text = norm(el.innerText || el.textContent || '');
        const m = text.match(emailRe);
        if (m) { email = m[0]; break; }
    }
}

if (!email) {
    const all = (document.body && document.body.innerText) || '';
    const m = String(all).slice(0, 20000).match(emailRe);
    if (m) email = m[0];
}

if (!name && email) name = email.split('@')[0];

return { name: name, email: email };
`;

export const PERKS_JS = String.raw`
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch (e) { return false; }
};

const heading = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')].find(
    (el) => /^your perks$/i.test(norm(el.innerText || el.textContent))
);

let root = null;
if (heading) {
    root = heading.closest('section') || heading.parentElement || heading.parentElement?.parentElement;
}

if (!root) {
    root = document.querySelector('[aria-label*="perks" i], [id*="perks" i], [class*="perks" i]');
}

if (!root) return { found: false, total: 0, items: [] };

const items = [];
const seen = new Set();

for (const el of root.querySelectorAll('a[href], button, [role="button"]')) {
    if (!visible(el)) continue;
    if (heading && (el === heading || heading.contains(el))) continue;

    const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
    if (!text || text.length < 3) continue;
    if (/^your perks$/i.test(text)) continue;

    let href = '';
    try { href = el.href || ''; } catch (e) {}

    const key = (text + '|' + href).slice(0, 180).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({
        text: text.slice(0, 140),
        href: href,
        tag: (el.tagName || '').toLowerCase(),
        claimed: /\b(claimed|redeemed|used|sudah)\b/i.test(text),
    });
}

return { found: true, total: items.length, items: items.slice(0, 12) };
`;

export const CLICK_BY_TEXT_JS = String.raw`
const wanted = String(arguments[0] || '').toLowerCase();
const rootSel = arguments[1] || '';
const norm = (t) => (t || '').replace(/\s+/g, ' ').trim().toLowerCase();

let root = document;
if (rootSel) root = document.querySelector(rootSel) || document;

const visible = (el) => {
    try {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden';
    } catch (e) { return false; }
};

const els = root.querySelectorAll('a[href], button, [role="button"], [aria-label]');
for (const el of els) {
    if (!visible(el)) continue;
    const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
    if (!text) continue;
    if (text === wanted || text.indexOf(wanted) !== -1) {
        try {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { ok: true, text: (el.innerText || el.textContent || '').trim().slice(0, 120) };
        } catch (e) {}
    }
}
return { ok: false };
`;

// ============================================================
// HELPERS
// ============================================================

/** Wait until the document has finished loading (`timeout` in seconds). */
export async function waitReady(driver: WebDriver, timeout = 20): Promise<boolean> {
  try {
    await driver.wait(
      async () => {
        const state = await driver.executeScript("return document.readyState");
        return state === "interactive" || state === "complete";
      },
      timeout * 1000,
    );
    return true;
  } catch {
    return false;
  }
}

export async function currentUrl(driver: WebDriver): Promise<string> {
  try {
    return (await driver.getCurrentUrl()) || "";
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return "";
  }
}

/** True when the rewards page redirected to a sign-in page. */
export async function needsLogin(driver: WebDriver): Promise<boolean> {
  const url = (await currentUrl(driver)).toLowerCase();

  return (
    url.includes("login.live.com") ||
    url.includes("login.microsoftonline.com") ||
    url.includes("signin")
  );
}

/** Return the visible reward cards on the current page. */
export async function scanCards(driver: WebDriver): Promise<Card[]> {
  let cards: unknown;

  try {
    cards = await driver.executeScript(SCAN_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return [];
  }

  return Array.isArray(cards) ? (cards as Card[]) : [];
}

/** Open a scanned card by index. Returns a small result object. */
export async function clickCard(
  driver: WebDriver,
  index: number,
  newTab = true,
): Promise<ActionResult> {
  let result: unknown;

  try {
    result = await driver.executeScript(CLICK_JS, index, newTab);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return {
      ok: false,
      reason: errorName(e),
    };
  }

  return (result as ActionResult | null) || {
    ok: false,
    reason: "empty-result",
  };
}

/**
 * Click a scanned card with a real Selenium click.
 *
 * A native click is trusted by Edge, so the card's own handler can open
 * a new tab or dialog the same way a user click would. Falls back to a
 * JavaScript click when the element is covered by another node.
 */
export async function nativeClickCard(
  driver: WebDriver,
  index: number,
): Promise<ActionResult> {
  let element: WebElement | null;

  try {
    element = (await driver.executeScript(
      "return (window.__edgepyCards && " +
        "window.__edgepyCards[arguments[0]]) || null;",
      index,
    )) as WebElement | null;
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return { ok: false, reason: errorName(e) };
  }

  if (element === null || element === undefined) {
    return { ok: false, reason: "card-not-found" };
  }

  try {
    await driver.executeScript(
      "arguments[0].scrollIntoView({ block: 'center' });",
      element,
    );
    await sleep(300);
    await element.click();
    return { ok: true, mode: "native" };
  } catch (firstError) {
    try {
      await driver.executeScript("arguments[0].click();", element);
      return { ok: true, mode: "js" };
    } catch {
      return {
        ok: false,
        reason: errorName(firstError),
      };
    }
  }
}

/**
 * Click a visible Claim/Klaim button. Returns its label or ''.
 *
 * The JavaScript only locates the control; the click itself is a native
 * Selenium click so the dashboard sees a trusted user event. A JavaScript
 * click is the fallback when another node covers the button.
 */
export async function clickClaim(driver: WebDriver): Promise<string> {
  let found: unknown;

  try {
    found = await driver.executeScript(CLAIM_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return "";
  }

  if (!isPlainObject(found) || found.element === null || found.element === undefined) {
    return "";
  }

  const element = found.element as WebElement;
  const label = String(found.label || "claim").trim().slice(0, 60) || "claim";

  try {
    await driver.executeScript(
      "arguments[0].scrollIntoView({ block: 'center' });",
      element,
    );
    await sleep(300);
    await element.click();
    return label;
  } catch {
    // fall through to a JavaScript click
  }

  try {
    await driver.executeScript("arguments[0].click();", element);
    return label;
  } catch {
    return "";
  }
}


export const ERROR_PAGE_JS = String.raw`
const text = (document.body && document.body.innerText) || '';
return !!(
    document.querySelector('.sc_error, .sc_errD') ||
    /it's not you, it's us|isn't available right now|tidak tersedia saat ini/i.test(text)
);
`;

/** True when Bing served its temporary "It's not you, it's us" page. */
export async function isErrorPage(driver: WebDriver): Promise<boolean> {
  try {
    return Boolean(await driver.executeScript(ERROR_PAGE_JS));
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return false;
  }
}

/** Seconds on a monotonic clock (Python's `time.monotonic()`). */
function monotonic(): number {
  return performance.now() / 1000;
}

/**
 * Poll the in-page "Ready to claim" counter until it drops.
 *
 * Returns the new value (0 when the box disappeared), or null when the
 * counter did not move within `timeout` seconds.
 */
export async function waitClaimableDrop(
  driver: WebDriver,
  before: number | null,
  timeout = 10,
): Promise<number | null> {
  const deadline = monotonic() + timeout;

  while (monotonic() < deadline) {
    await sleep(1000);

    if (await isErrorPage(driver)) {
      return null;
    }

    const value = await readClaimable(driver);

    if (value === null) {
      // The box is gone after a claim: everything was claimed.
      if (before) {
        return 0;
      }
      continue;
    }

    if (before === null || value < before) {
      return value;
    }
  }

  return null;
}

/** Trusted Selenium click with a JavaScript click as fallback. */
async function nativeClick(driver: WebDriver, element: WebElement): Promise<boolean> {
  try {
    await driver.executeScript(
      "arguments[0].scrollIntoView({ block: 'center' });",
      element,
    );
    await sleep(300);
    await element.click();
    return true;
  } catch {
    // fall through to a JavaScript click
  }

  try {
    await driver.executeScript("arguments[0].click();", element);
    return true;
  } catch {
    return false;
  }
}

/** Click the "Claim points" button in the claim panel, if present. */
export async function confirmClaim(driver: WebDriver): Promise<string> {
  let found: unknown;

  try {
    found = await driver.executeScript(CONFIRM_CLAIM_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return "";
  }

  if (!isPlainObject(found) || found.element === null || found.element === undefined) {
    return "";
  }

  const label = String(found.label || "claim").trim().slice(0, 60) || "claim";

  return (await nativeClick(driver, found.element as WebElement)) ? label : "";
}

/**
 * Wait for the React dashboard to render the "Ready to claim" card.
 *
 * Returns its value, or null when no card shows up within `timeout` seconds.
 */
export async function waitClaimable(
  driver: WebDriver,
  timeout = 12,
): Promise<number | null> {
  const deadline = monotonic() + timeout;

  while (true) {
    const value = await readClaimable(driver);

    if (value !== null || monotonic() >= deadline) {
      return value;
    }

    await sleep(1000);
  }
}

/** Number of points shown as "Ready to claim", or null. */
export async function readClaimable(driver: WebDriver): Promise<number | null> {
  let value: unknown;

  try {
    value = await driver.executeScript(CLAIMABLE_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return null;
  }

  return Number.isInteger(value) ? (value as number) : null;
}

/** Close small dialogs such as cookie or marketing prompts. */
export async function dismissPrompts(driver: WebDriver): Promise<number> {
  try {
    const value = Math.trunc(Number((await driver.executeScript(DISMISS_JS)) || 0));
    return Number.isFinite(value) ? value : 0;
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return 0;
  }
}

/** Describe the topmost visible role="dialog" flyout. */
export async function readDialog(driver: WebDriver): Promise<DialogInfo> {
  let dialog: unknown;

  try {
    dialog = await driver.executeScript(DIALOG_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return { open: false, text: "", actions: [] };
  }

  return (dialog as DialogInfo | null) || { open: false, text: "", actions: [] };
}

/** Click the primary action inside the open flyout dialog. */
export async function clickDialogAction(driver: WebDriver): Promise<ActionResult> {
  let result: unknown;

  try {
    result = await driver.executeScript(DIALOG_ACTION_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return { ok: false, reason: errorName(e) };
  }

  return (result as ActionResult | null) || { ok: false, reason: "empty-result" };
}

/** Close the open flyout dialog, if any. */
export async function closeDialog(driver: WebDriver): Promise<boolean> {
  try {
    return Boolean(await driver.executeScript(CLOSE_DIALOG_JS));
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return false;
  }
}

/** Click one answer and the Next/Submit button, if present. */
export async function answerQuiz(driver: WebDriver): Promise<QuizResult> {
  try {
    return ((await driver.executeScript(QUIZ_JS)) as QuizResult | null) || {};
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return {};
  }
}

/**
 * Best-effort read of the points balance.
 *
 * The React dashboard renders the balance asynchronously, so poll
 * briefly instead of giving up on the first attempt.
 */
export async function readPoints(driver: WebDriver, timeout = 5): Promise<number | null> {
  const deadline = monotonic() + timeout;

  while (true) {
    let value: unknown;

    try {
      value = await driver.executeScript(POINTS_JS);
    } catch (e) {
      if (!isWebDriverError(e)) throw e;
      value = null;
    }

    if (Number.isInteger(value)) {
      return value as number;
    }

    if (monotonic() >= deadline) {
      return null;
    }

    await sleep(500);
  }
}

/** Send a photo to the first usable image file input on the page. */
export async function uploadPhoto(driver: WebDriver, path: string): Promise<boolean> {
  const deadline = monotonic() + 12;

  while (monotonic() < deadline) {
    const inputs = await driver.findElements(By.css('input[type="file"]'));

    for (const element of inputs) {
      let accept: string;

      try {
        accept = ((await element.getAttribute("accept")) || "").toLowerCase();
      } catch (e) {
        if (!isWebDriverError(e)) throw e;
        accept = "";
      }

      if (accept && !accept.includes("image")) {
        continue;
      }

      try {
        await element.sendKeys(path);
        return true;
      } catch (e) {
        if (!isWebDriverError(e)) throw e;
        continue;
      }
    }

    // The input may appear only after the camera/upload control is
    // clicked, so look for that control and try again.
    try {
      await driver.executeScript(UPLOAD_CONTROLS_JS);
    } catch (e) {
      if (!isWebDriverError(e)) throw e;
    }

    await sleep(1000);
  }

  return false;
}

/** Best-effort read of signed-in account name/email from the page. */
export async function readAccount(driver: WebDriver): Promise<AccountInfo> {
  let value: unknown;

  try {
    value = await driver.executeScript(ACCOUNT_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return { name: "", email: "" };
  }

  if (!isPlainObject(value)) {
    return { name: "", email: "" };
  }

  return {
    name: String(value.name || "").trim(),
    email: String(value.email || "").trim(),
  };
}

/** Describe the 'Your perks' section on the dashboard, if present. */
export async function readPerks(driver: WebDriver): Promise<PerksInfo> {
  let value: unknown;

  try {
    value = await driver.executeScript(PERKS_JS);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return { found: false, total: 0, items: [] };
  }

  if (!isPlainObject(value)) {
    return { found: false, total: 0, items: [] };
  }

  return value as unknown as PerksInfo;
}

/** Click the first visible element matching text within root. */
export async function clickByText(
  driver: WebDriver,
  text: string,
  rootSelector = "",
): Promise<ActionResult> {
  let result: unknown;

  try {
    result = await driver.executeScript(CLICK_BY_TEXT_JS, text, rootSelector);
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return { ok: false, reason: errorName(e) };
  }

  return (result as ActionResult | null) || { ok: false };
}

/** Close one tab without disturbing the others. */
export async function closeTab(driver: WebDriver, handle: string): Promise<void> {
  let handles: string[];

  try {
    handles = await driver.getAllWindowHandles();
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
    return;
  }

  if (!handles.includes(handle)) {
    return;
  }

  try {
    await driver.switchTo().window(handle);
    await driver.close();
  } catch (e) {
    if (!isWebDriverError(e)) throw e;
  }
}
