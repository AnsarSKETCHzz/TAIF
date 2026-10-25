/**
 * "Block Ads & Clean Page" helper, injected only when the user presses the button. The actual
 * hiding is done by stylesheets the service worker injects (Chrome matches them natively, including
 * ads added later). This script only counts matches, fades visible ads out before the stylesheet
 * hides them, handles ad iframes and ad overlays, verifies the result, and restores on request.
 */

declare global {
  interface Window { __TAIF_COSMETIC__?: CosmeticApi }
}

export interface CosmeticResult {
  enabled: boolean;
  matched: number;
  hidden: number;
  collapsed: number;
  overlays: number;
  adFrames: number;
  skipped: number;
  unsupported: number;
  restored?: number;
}

interface CosmeticApi {
  scan(): Promise<CosmeticResult>;
  hide(animate: boolean): Promise<CosmeticResult>;
  suppressOverlays(): Promise<CosmeticResult>;
  verify(): CosmeticResult;
  restore(): Promise<CosmeticResult>;
}

const ATTR = "data-taif-ad";
const KEEP = "data-taif-keep";
const STYLE_ID = "taif-ad-style";
const SENSITIVE = /log ?in|sign ?in|password|payment|card number|checkout|cookie|consent|privacy|gdpr|captcha|verify you are human|age verification/i;

let enabled = false;
let groups: string[] = [];
let unsupportedGroups = 0;
const matched = new Set<Element>();
const frames = new Set<Element>();
const collapsed = new Set<Element>();
const overlays = new Set<Element>();
const kept = new Set<Element>();

async function send<T>(message: Record<string, unknown>): Promise<T | undefined> {
  try {
    return await chrome.runtime.sendMessage(message) as T;
  } catch {
    return undefined;
  }
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [${ATTR}="fade"]{transition:opacity .26s ease,transform .26s ease!important;opacity:0!important;transform:scale(.97)!important;pointer-events:none!important}
    [${ATTR}="hidden"],[${ATTR}="collapsed"]{display:none!important}
    html[data-taif-unlock],html[data-taif-unlock] body{overflow:auto!important}
    @media (prefers-reduced-motion: reduce){[${ATTR}="fade"]{transition:none!important}}`;
  (document.head ?? document.documentElement).append(style);
}

function hiddenNow(element: Element): boolean {
  return element.isConnected && getComputedStyle(element).display === "none";
}

function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && !hiddenNow(element) && getComputedStyle(element).visibility !== "hidden";
}

/** Never hide page structure, main content, or anything asking for credentials or payment. */
function safeToHide(element: Element): boolean {
  if (element === document.documentElement || element === document.body || element.matches("head,main,[role=main],article,form")) return false;
  if (element.querySelector("main,[role=main],h1,input[type=password],input[autocomplete^=cc-]")) return false;
  const rect = element.getBoundingClientRect();
  const pageArea = Math.max(1, document.documentElement.scrollWidth * document.documentElement.scrollHeight);
  return rect.width * rect.height <= pageArea * 0.6 || element.tagName === "IFRAME";
}

function result(): CosmeticResult {
  const all = [...matched, ...frames];
  return {
    enabled,
    matched: all.length,
    hidden: all.filter(hiddenNow).length,
    collapsed: [...collapsed].filter(hiddenNow).length,
    overlays: [...overlays].filter(hiddenNow).length,
    adFrames: [...frames].filter(hiddenNow).length,
    skipped: kept.size,
    unsupported: unsupportedGroups
  };
}

async function adIframes(): Promise<Element[]> {
  const list = Array.from(document.querySelectorAll("iframe[src]")).slice(0, 200);
  const hostOf = (frame: Element) => {
    try {
      return new URL((frame as HTMLIFrameElement).src, location.href).hostname;
    } catch {
      return "";
    }
  };
  const hosts = [...new Set(list.map(hostOf).filter(Boolean))];
  if (!hosts.length) return [];
  const response = await send<{ ads: string[] }>({ type: "TAIF_AD_FRAMES", hosts });
  const ads = new Set(response?.ads ?? []);
  return list.filter((frame) => ads.has(hostOf(frame)));
}

/** Step: which elements on this page match the active hiding rules or are known ad frames. */
async function scan(): Promise<CosmeticResult> {
  const response = await send<{ enabled: boolean; groups: string[] }>({ type: "TAIF_COSMETIC_SELECTORS" });
  enabled = Boolean(response?.enabled);
  groups = response?.groups ?? [];
  if (!enabled) return result();
  unsupportedGroups = 0;
  for (const group of groups) {
    try {
      document.querySelectorAll(group).forEach((element) => {
        if (!element.closest("[id^='taif-']")) matched.add(element);
      });
    } catch {
      unsupportedGroups += 1; // A group this browser can't parse at all.
    }
  }
  for (const frame of await adIframes()) frames.add(frame);
  return result();
}

/** Removes empty wrappers left around an ad, up to two levels. */
function collapseParents(element: Element) {
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 2; depth += 1, parent = parent.parentElement) {
    if (parent === document.body || parent.matches("main,[role=main],article,form,section,header,footer,nav")) return;
    const others = Array.from(parent.children).filter((child) => !hiddenNow(child) && child.getAttribute(ATTR) !== "fade" && child.tagName !== "SCRIPT" && child.tagName !== "STYLE");
    const ownText = Array.from(parent.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 2);
    if (others.length || ownText || parent.getBoundingClientRect().height > 700) return;
    parent.setAttribute(ATTR, "collapsed");
    collapsed.add(parent);
  }
}

/** Step: fade visible ads out, then let the native stylesheet hide them (it also covers later ads). */
async function hide(animate: boolean): Promise<CosmeticResult> {
  if (!enabled) return result();
  ensureStyle();
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const visible = [...matched, ...frames].filter((element) => isVisible(element));
  const fading: Element[] = [];
  for (const element of visible) {
    if (!safeToHide(element)) {
      element.setAttribute(KEEP, "");
      kept.add(element);
      continue;
    }
    if (animate && !reduced) {
      element.setAttribute(ATTR, "fade");
      fading.push(element);
    }
  }
  if (fading.length) await new Promise((resolve) => setTimeout(resolve, 280));
  await send({ type: "TAIF_COSMETIC_APPLY" });
  for (const element of fading) if (element.getAttribute(ATTR) === "fade") element.removeAttribute(ATTR);
  // Ad frames are found by domain, not by selector, so they get an attribute of their own.
  for (const frame of frames) if (!kept.has(frame)) frame.setAttribute(ATTR, "hidden");
  for (const element of visible) if (hiddenNow(element)) collapseParents(element);
  return result();
}

/** Step: fixed promotional layers that contain an identified ad. */
async function suppressOverlays(): Promise<CosmeticResult> {
  if (!enabled) return result();
  ensureStyle();
  const ads = [...matched, ...frames];
  const layers = Array.from(document.body?.querySelectorAll("div,section,aside,ins") ?? []).slice(0, 3000).filter((element) => {
    if (element.hasAttribute(ATTR) || hiddenNow(element)) return false;
    const style = getComputedStyle(element);
    if (style.position !== "fixed" && style.position !== "sticky") return false;
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height >= innerWidth * innerHeight * 0.2;
  });
  for (const layer of layers) {
    if (!ads.some((ad) => layer.contains(ad)) || SENSITIVE.test((layer as HTMLElement).innerText ?? "")) continue;
    const rect = layer.getBoundingClientRect();
    layer.setAttribute(ATTR, "hidden");
    overlays.add(layer);
    if (rect.width * rect.height >= innerWidth * innerHeight * 0.5) document.documentElement.setAttribute("data-taif-unlock", "");
  }
  return result();
}

async function restore(): Promise<CosmeticResult> {
  await send({ type: "TAIF_COSMETIC_REMOVE" });
  const count = result().hidden + result().overlays;
  document.querySelectorAll(`[${ATTR}],[${KEEP}]`).forEach((element) => {
    element.removeAttribute(ATTR);
    element.removeAttribute(KEEP);
  });
  document.documentElement.removeAttribute("data-taif-unlock");
  document.getElementById(STYLE_ID)?.remove();
  matched.clear();
  frames.clear();
  collapsed.clear();
  overlays.clear();
  kept.clear();
  return { ...result(), restored: count };
}

if (!window.__TAIF_COSMETIC__) {
  window.__TAIF_COSMETIC__ = { scan, hide, suppressOverlays, verify: result, restore };
}
