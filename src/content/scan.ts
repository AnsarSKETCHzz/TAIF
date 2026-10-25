import { detect } from "../shared/detectors";
import type {
  ChoiceControl,
  ChoicePair,
  ElementEvidence,
  FormEvidence,
  PageEvidence,
  ScarcityClaim,
  StoredClaim,
  StoredTimer,
  SubscriptionTerm,
  TimerObservation
} from "../shared/types";
import { contrastOf, effectiveBackground, luminance } from "../shared/dom";

export { contrastRatio, effectiveBackground } from "../shared/dom";

/**
 * Collects evidence from the page for the eleven scenario detectors. Read-only: it never clicks,
 * focuses, submits or changes the page.
 */

const INTERACTIVE = "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab]";

function isVisible(element: Element): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" &&
    Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
}

function describe(element: Element): string {
  const html = element as HTMLElement;
  const label = html.getAttribute("aria-label") ?? html.innerText?.trim().replace(/\s+/g, " ").slice(0, 30) ?? "";
  return `${element.tagName.toLowerCase()}${label ? ` "${label}"` : ""}`;
}

/** Text the element shows itself, not text of its descendants, so containers aren't double-counted. */
function ownText(element: Element): string {
  return Array.from(element.childNodes)
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "")
    .join(" ").replace(/\s+/g, " ").trim();
}

function accessibleName(element: Element): string {
  const html = element as HTMLElement;
  const input = element as HTMLInputElement;
  return (html.getAttribute("aria-label") ?? "") ||
    (html.getAttribute("aria-labelledby") ? "labelled" : "") ||
    ("labels" in input && input.labels?.length ? "label" : "") ||
    html.innerText?.trim() || html.getAttribute("title") || html.getAttribute("placeholder") ||
    (element.querySelector("img[alt]:not([alt=''])") ? "img" : "") ||
    (element.querySelector("svg title") ? "svg" : "") ||
    (input.type === "submit" || input.type === "button" ? input.value : "") || "";
}

function collectElements(): ElementEvidence[] {
  const candidates = Array.from(document.querySelectorAll("p,span,a,button,label,li,h1,h2,h3,h4,h5,h6,td,th,small,strong,em,div,input,select,textarea,[role=button]"))
    .filter((element) => {
      const tag = element.tagName.toLowerCase();
      return (["input", "select", "textarea"].includes(tag) || ownText(element).length >= 3) && isVisible(element);
    })
    .slice(0, 300);
  return candidates.map((element) => {
    const html = element as HTMLElement;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10) || 400;
    const measured = contrastOf(element);
    const interactive = element.matches(INTERACTIVE) || Boolean(element.closest("a[href],button,label"));
    return {
      description: describe(element),
      text: ownText(element).slice(0, 120) || (html as HTMLInputElement).value?.slice?.(0, 40) || "",
      tag,
      foreground: measured.fg,
      background: measured.bg,
      contrast: measured.contrast,
      backgroundImage: measured.image,
      large: size >= 24 || (size >= 18.66 && weight >= 700),
      interactive,
      width: rect.width,
      height: rect.height,
      opacity: Number(style.opacity),
      fontSize: size,
      required: "required" in html ? (html as HTMLInputElement).required : undefined,
      hasLabel: interactive ? Boolean(accessibleName(element)) : undefined,
      disabled: "disabled" in html ? Boolean((html as HTMLInputElement).disabled) : false
    };
  });
}

function timerSeconds(text: string): number | undefined {
  const match = text.match(/(?:^|\D)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:\D|$)/);
  if (!match) return undefined;
  return match[3] ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) :
    Number(match[1]) * 60 + Number(match[2]);
}

function collectTimers(): TimerObservation[] {
  const explicit = Array.from(document.querySelectorAll("[data-countdown],time,[role=timer],.countdown,.timer,[class*=countdown],[id*=countdown],[class*=timer]"));
  const leaves = Array.from(document.querySelectorAll("span,div,p,strong,b")).filter((element) =>
    element.childElementCount === 0 && (element.textContent ?? "").trim().length < 20 && /\d{1,2}:[0-5]\d/.test(element.textContent ?? ""));
  const seen = new Set<Element>();
  return [...explicit, ...leaves]
    .filter((element) => !seen.has(element) && seen.add(element) && isVisible(element))
    .filter((element) => !explicit.some((parent) => parent !== element && parent.contains(element)))
    .slice(0, 20)
    .flatMap((element, index) => {
      const text = (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
      const seconds = timerSeconds(text);
      if (seconds === undefined) return [];
      const block = element.closest("section,article,aside,div,p,li") ?? element.parentElement;
      // Stable across reloads: path + position + the timer's non-numeric label.
      const label = text.replace(/[\d:]/g, "").trim().slice(0, 20);
      return [{
        key: `${location.pathname}|${index}|${label}`,
        text,
        seconds,
        context: (block as HTMLElement | null)?.innerText?.replace(/\s+/g, " ").slice(0, 200)
      }];
    });
}

function collectClaims(text: string): ScarcityClaim[] {
  const pattern = /\b(?:only\s+(\d+)\s+(?:items?\s+|pieces?\s+|seats?\s+|rooms?\s+)?(?:left|remaining|in stock)|(\d+)\s+(?:items?\s+)?left in stock|few\s+left|limited\s+stock|selling\s+fast|almost\s+sold\s+out)\b/gi;
  return [...text.matchAll(pattern)].slice(0, 10).map((match) => ({
    text: match[0].slice(0, 80),
    count: match[1] ?? match[2] ? Number(match[1] ?? match[2]) : undefined
  }));
}

function collectForms(): FormEvidence[] {
  return Array.from(document.forms).slice(0, 10).map((form, index) => {
    const fields = Array.from(form.querySelectorAll("input,select,textarea")) as HTMLInputElement[];
    const kinds = new Set<string>();
    const sensitiveFields: HTMLInputElement[] = [];
    for (const field of fields) {
      const hint = `${field.type} ${field.name} ${field.id} ${field.autocomplete} ${field.placeholder}`.toLowerCase();
      const kind = field.type === "password" ? "password"
        : /cc-|card|cvv|cvc/.test(hint) ? "payment"
          : field.type === "email" || /email/.test(hint) ? "email"
            : field.type === "tel" || /phone|mobile/.test(hint) ? "phone" : "";
      if (kind) {
        kinds.add(kind);
        sensitiveFields.push(field);
      }
    }
    const validated = sensitiveFields.every((field) =>
      field.required || Boolean(field.pattern) || field.minLength > 0 || ["email", "tel"].includes(field.type));
    return {
      description: `form ${index + 1}${form.getAttribute("aria-label") ? ` "${form.getAttribute("aria-label")}"` : form.id ? ` #${form.id}` : ""}`,
      sensitive: [...kinds],
      validated,
      novalidate: form.noValidate
    };
  });
}

function darkModeSupport(): PageEvidence["darkMode"] {
  let supported = /dark/.test(getComputedStyle(document.documentElement).colorScheme ?? "") ||
    /dark/.test(document.querySelector("meta[name=color-scheme]")?.getAttribute("content") ?? "");
  for (const sheet of Array.from(document.styleSheets).slice(0, 30)) {
    if (supported) break;
    try {
      supported = Array.from(sheet.cssRules).some((rule) => rule instanceof CSSMediaRule && /prefers-color-scheme:\s*dark/.test(rule.conditionText));
    } catch {
      // Cross-origin stylesheet; its rules are not readable.
    }
  }
  const page = effectiveBackground(document.body ?? document.documentElement).color;
  return {
    supported,
    preferred: matchMedia("(prefers-color-scheme: dark)").matches,
    pageIsDark: page ? luminance(page) < 0.2 : false
  };
}

function focusOutlineRemoved(): boolean {
  for (const sheet of Array.from(document.styleSheets).slice(0, 30)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule) || !/:focus/.test(rule.selectorText)) continue;
        const style = rule.style;
        const removed = /^(none|0|0px)$/.test(style.outlineStyle || style.outline || "") || style.outlineWidth === "0px";
        const replaced = Boolean(style.boxShadow || style.borderColor || style.backgroundColor || style.textDecoration);
        if (removed && !replaced) return true;
      }
    } catch {
      // Cross-origin stylesheet.
    }
  }
  return false;
}

function collectAccessibility(): PageEvidence["accessibility"] {
  const controls = Array.from(document.querySelectorAll(INTERACTIVE)).filter(isVisible).slice(0, 300);
  return {
    unlabeled: controls.filter((element) => !accessibleName(element)).slice(0, 20).map(describe),
    smallTargets: controls
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        // Links inside running text are exempt from the WCAG target-size rule.
        const inline = element.tagName === "A" && getComputedStyle(element).display === "inline";
        return !inline && rect.width < 24 && rect.height < 24;
      })
      .slice(0, 20).map(describe),
    focusSuppressed: focusOutlineRemoved(),
    imageLinksWithoutAlt: controls.filter((element) =>
      element.querySelector("img") && !accessibleName(element)).length
  };
}

const POSITIVE = /^(?:accept(?: all)?(?: cookies)?|agree|i agree|allow(?: all)?|continue|subscribe(?: now)?|yes|ok(?:ay)?|got it|start(?: (?:my|your))?(?: free)? trial|buy now|sign up|join(?: now)?|confirm|upgrade(?: now)?)\b/i;
const NEGATIVE = /^(?:reject(?: all)?|decline|no,? thanks?|not now|cancel|deny|skip|maybe later|later|necessary only|only necessary|manage(?: preferences| options)?|no|close|continue without)/i;

function choiceControl(element: Element): ChoiceControl {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  let opacity = 1;
  for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
  return {
    text: ((element as HTMLElement).innerText || (element as HTMLInputElement).value || "").trim().slice(0, 40),
    area: rect.width * rect.height,
    contrast: contrastOf(element).contrast,
    opacity,
    fontSize: Number.parseFloat(style.fontSize)
  };
}

function collectChoicePairs(): ChoicePair[] {
  const controls = Array.from(document.querySelectorAll("button,a[href],[role=button],input[type=submit],input[type=button]")).filter(isVisible).slice(0, 400);
  const label = (element: Element) => ((element as HTMLElement).innerText || (element as HTMLInputElement).value || "").trim();
  const negatives = controls.filter((element) => NEGATIVE.test(label(element)));
  const pairs: ChoicePair[] = [];
  for (const negative of negatives) {
    let container = negative.parentElement;
    for (let depth = 0; container && depth < 4; depth += 1, container = container.parentElement) {
      const positive = controls.find((element) => element !== negative && container!.contains(element) && POSITIVE.test(label(element)));
      if (positive) {
        pairs.push({ container: describe(container), positive: choiceControl(positive), negative: choiceControl(negative) });
        break;
      }
    }
    if (pairs.length >= 5) break;
  }
  return pairs;
}

const ACTION = /\b(?:subscribe|start(?: (?:my|your))?(?: free)? trial|try (?:it )?free|checkout|check out|buy now|place order|sign up|join now|upgrade)\b/i;
const TERM = /\b(?:automatically renews?|auto[- ]?renew(?:al|s)?|renews? (?:automatically|monthly|annually|every)|after (?:the|your) (?:free )?trial|trial.{0,60}(?:converts?|paid|charged?|billed)|(?:charged|billed) (?:monthly|annually|every)|cancel(?:lation)? fee|minimum (?:term|commitment)|non[- ]refundable|no refunds?|recurring (?:charge|payment|billing)|until you cancel)\b/i;

function collectSubscription(): PageEvidence["subscription"] {
  const actionElement = Array.from(document.querySelectorAll("button,a[href],[role=button],input[type=submit]"))
    .filter(isVisible)
    .find((element) => ACTION.test((element as HTMLElement).innerText || (element as HTMLInputElement).value || ""));
  if (!actionElement) return { terms: [] };
  const actionRect = actionElement.getBoundingClientRect();
  const actionStyle = getComputedStyle(actionElement);
  const terms: SubscriptionTerm[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(), seen = 0; node && seen < 5000 && terms.length < 5; node = walker.nextNode(), seen += 1) {
    const text = node.textContent ?? "";
    if (!TERM.test(text)) continue;
    const element = node.parentElement;
    if (!element || !isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    terms.push({
      text: ((element.closest("p,li,small,span,div,label") as HTMLElement | null)?.innerText ?? text).replace(/\s+/g, " ").trim().slice(0, 200),
      fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
      contrast: contrastOf(element).contrast,
      distance: Math.abs(rect.top - actionRect.top)
    });
  }
  return {
    action: {
      text: ((actionElement as HTMLElement).innerText || (actionElement as HTMLInputElement).value || "").trim().slice(0, 40),
      fontSize: Number.parseFloat(actionStyle.fontSize),
      contrast: contrastOf(actionElement).contrast
    },
    terms
  };
}

export function productInfo(): { name?: string; sku?: string } {
  for (const script of Array.from(document.querySelectorAll("script[type='application/ld+json']")).slice(0, 10)) {
    try {
      const data: unknown = JSON.parse(script.textContent ?? "");
      const items = (Array.isArray(data) ? data : [data, ...((data as { "@graph"?: unknown[] })?.["@graph"] ?? [])]) as Record<string, unknown>[];
      const product = items.find((item) => item && /Product/i.test(String(item["@type"] ?? "")));
      if (product) {
        const sku = product.sku ?? product.gtin13 ?? product.gtin ?? product.mpn;
        return { name: typeof product.name === "string" ? product.name.slice(0, 200) : undefined, sku: sku !== undefined ? String(sku).slice(0, 60) : undefined };
      }
    } catch {
      // Malformed JSON-LD is ignored.
    }
  }
  const og = document.querySelector("meta[property='og:title']")?.getAttribute("content");
  return { name: og?.slice(0, 200) };
}

function countAdminControls(): number {
  return Array.from(document.querySelectorAll("a[href],button"))
    .filter((element) => /\b(?:admin(?:istrator)?|control panel|manage users|site settings)\b/i.test((element as HTMLElement).innerText ?? "") && isVisible(element))
    .length;
}

interface ScanContext {
  previousTimers?: StoredTimer[];
  previousClaims?: StoredClaim[];
  comparisonPage?: PageEvidence["previousPage"];
}

export function scanPage(context?: ScanContext): PageEvidence {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const resources = performance.getEntriesByType("resource") as (PerformanceResourceTiming & { responseStatus?: number })[];
  const text = (document.body?.innerText ?? "").slice(0, 30000);
  // The live monitor (same isolated world) counts long tasks from page start, when it is enabled.
  const longTasks = (window as Window & { __TAIF_LONG_TASKS__?: number }).__TAIF_LONG_TASKS__;
  return {
    url: location.href,
    title: document.title,
    text,
    observedAt: new Date().toISOString(),
    elements: collectElements(),
    timers: collectTimers(),
    previousTimers: context?.previousTimers,
    claims: collectClaims(text),
    previousClaims: context?.previousClaims,
    previousPage: context?.comparisonPage,
    navigation: navigation ? {
      loadMs: Number.isFinite(navigation.loadEventEnd) && navigation.loadEventEnd > 0 ? navigation.loadEventEnd : undefined,
      domInteractiveMs: navigation.domInteractive,
      resourceCount: resources.length,
      longTasks,
      failedResources: resources.filter((entry) => (entry.responseStatus ?? 0) >= 400).length
    } : undefined,
    formCount: document.forms.length,
    formsNoValidate: Array.from(document.forms).some((form) => form.noValidate),
    forms: collectForms(),
    darkMode: darkModeSupport(),
    adminControls: countAdminControls(),
    accessibility: collectAccessibility(),
    choicePairs: collectChoicePairs(),
    subscription: collectSubscription(),
    product: productInfo()
  };
}

declare global {
  interface Window {
    __TAIF_SCAN__?: (context?: ScanContext) => unknown;
  }
}

window.__TAIF_SCAN__ = (context) => {
  const page = scanPage(context);
  return {
    url: page.url,
    title: page.title,
    scannedAt: page.observedAt,
    findings: detect(page),
    observations: { timers: page.timers, claims: page.claims ?? [] },
    detectorCount: 11,
    caveat: "A clean result means only that these checks found nothing. It is not a security certification."
  };
};
