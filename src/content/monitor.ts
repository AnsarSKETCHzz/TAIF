import type { EventDraft } from "../shared/events";
import {
  analyzeTimer,
  closeState,
  overlayDraft,
  parseCountdown,
  promptDrafts,
  timerDraft,
  type CloseCandidate,
  type TimerSample
} from "../shared/live";
import type { TaifEvent } from "../shared/types";

/**
 * Live page monitor (features B, C, D and click signals for A). Registered only after the user
 * grants optional host access. It reads the DOM, never clicks, submits, or changes page actions.
 */

declare global {
  interface Window { __TAIF_MONITOR__?: boolean }
}

const TIMER_SELECTOR = "[role=timer],[data-countdown],.countdown,.timer,time";
const CLOSE_TEXT = /^(?:×|✕|✖|x|close|close ad|dismiss|skip|skip ad|no thanks|continue to site)$/i;
const CLOSE_ATTR = /close|dismiss|skip/i;
const PROMPT_HINT = /virus|infected|hacked|out of date|outdated|update|allow|download|warning|alert|threat|support/i;
const MAX_TIMERS = 10;
const MAX_OVERLAYS = 5;

interface TrackedTimer { key: string; samples: TimerSample[]; resets: number }
interface TrackedOverlay { key: string; firstSeen: number; initialState?: string; closeAfter?: number; lastSent?: string }

let counter = 0;
const keys = new WeakMap<Element, string>();
const timers = new Map<Element, TrackedTimer>();
const overlays = new Map<Element, TrackedOverlay>();
const promptCandidates = new WeakSet<Element>();
const visible = new WeakMap<Element, boolean>();
const lastDrafts = new Map<string, string>();
const pendingRoots = new Set<Element>();
let flushTimer: number | undefined;
let sampleTimer: number | undefined;
let notificationRequested = false;
let lastGesture = 0;
let hideOverlays = false;
let observeVisibility: (element: Element) => void = () => undefined;
const draftElements = new Map<string, { element: Element; draft: EventDraft }>();

function start() {
  const io = new IntersectionObserver(onIntersect, { threshold: [0, 0.5] });
  observeVisibility = (element) => io.observe(element);

  document.addEventListener("pointerdown", onGesture, { capture: true, passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") onGesture(event);
  }, { capture: true, passive: true });

  window.addEventListener("message", (event) => {
    const data = event.data as { __taif?: string; site?: string; how?: string } | null;
    // The popup guard (page context, any frame) reports each popup it blocked.
    if (data?.__taif === "popup_blocked" && typeof data.site === "string") {
      popupBlocked(data.site, String(data.how ?? "popup"));
      return;
    }
    if (event.source !== window || data?.__taif !== "notification_request") return;
    notificationRequested = true;
    analyzePrompt(document.body, true);
  });

  chrome.runtime.onMessage.addListener((message: { type?: string; event?: TaifEvent; count?: number; entry?: { id: string; host: string; source?: string } }, sender) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "TAIF_SHOW_ALERT" && message.event) showBanner(message.event);
    // Sent once per page load, only with a count Chrome reported for blocked requests.
    if (message?.type === "TAIF_NET_TOAST" && typeof message.count === "number" && message.count > 0) {
      showToast(`Protected by TAIF — ${message.count} advertising request${message.count === 1 ? "" : "s"} blocked (network filtering).`, []);
    }
    // Sent by the worker only after the browser confirmed the ad tab was closed.
    if (message?.type === "TAIF_PROTECTED" && message.entry) {
      const entry = message.entry;
      showToast(`Protected by TAIF — an unwanted popup tab (${entry.host}) was closed. You're back on ${entry.source ?? "your page"}.`, [
        { label: "Reopen", run: () => void send({ type: "TAIF_REOPEN", id: entry.id }) },
        { label: "Details", run: () => void send({ type: "TAIF_OPEN_POPUP" }) }
      ]);
    }
  });
  void chrome.storage.local.get("taif_protection").then(({ taif_protection: saved }) => {
    hideOverlays = Boolean((saved as { hideOverlays?: boolean } | undefined)?.hideOverlays);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.taif_protection) hideOverlays = Boolean((changes.taif_protection.newValue as { hideOverlays?: boolean } | undefined)?.hideOverlays);
  });

  const queue = (root: Element) => {
    pendingRoots.add(root);
    if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 400);
  };
  let addedSinceScan = 0;
  let changeTimer: number | undefined;
  new MutationObserver((records) => {
    for (const record of records) {
      record.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          queue(node as Element);
          addedSinceScan += 1;
        } else if (node.parentElement) queue(node.parentElement);
      });
    }
    // Big content changes (single-page apps, lazy-loaded sections) get the page checks re-run.
    if (addedSinceScan >= 30 && changeTimer === undefined) {
      changeTimer = window.setTimeout(() => {
        changeTimer = undefined;
        addedSinceScan = 0;
        // Re-checks on page changes are off: busy ad pages change constantly. "Check again" re-runs them.
      }, 3000);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.body) queue(document.body);

  countLongTasks();
  void send({ type: "TAIF_MONITOR_READY" }).then((response) => {
    const event = (response as { event?: TaifEvent } | undefined)?.event;
    if (event) showBanner(event);
  });

  // Automatic page checks once the page has settled, so results are ready when the popup opens.
  const ready = () => {
    const run = () => void send({ type: "TAIF_PAGE_READY" });
    const whenIdle = () => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
      else window.setTimeout(run, 2000);
    };
    // Background tabs are checked when you switch to them, not while hidden.
    if (document.visibilityState === "visible") whenIdle();
    else document.addEventListener("visibilitychange", function onVisible() {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      whenIdle();
    });
  };
  if (document.readyState === "complete") window.setTimeout(ready, 1500);
  else window.addEventListener("load", () => window.setTimeout(ready, 1500), { once: true });
}

/** Long tasks freeze the page; the scanner reads this count for the performance check. */
function countLongTasks() {
  const target = window as Window & { __TAIF_LONG_TASKS__?: number };
  target.__TAIF_LONG_TASKS__ = 0;
  try {
    new PerformanceObserver((list) => {
      target.__TAIF_LONG_TASKS__ = (target.__TAIF_LONG_TASKS__ ?? 0) + list.getEntries().length;
    }).observe({ type: "longtask", buffered: true });
  } catch {
    target.__TAIF_LONG_TASKS__ = undefined; // Not supported here.
  }
}

async function send(message: Record<string, unknown>): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return undefined; // Extension reloaded or service worker unavailable; monitoring degrades silently.
  }
}

function keyOf(element: Element): string {
  let key = keys.get(element);
  if (!key) {
    key = `${element.tagName.toLowerCase()}-${element.id || ""}-${counter += 1}`;
    keys.set(element, key);
  }
  return key;
}

function describe(element: Element): string {
  const html = element as HTMLElement;
  const role = element.getAttribute("role");
  const label = html.getAttribute("aria-label") ?? html.innerText?.trim().replace(/\s+/g, " ").slice(0, 40) ?? "";
  return `${element.tagName.toLowerCase()}${role ? ` role=${role}` : ""}${label ? ` "${label}"` : ""}`;
}

function onGesture(event: Event) {
  const now = Date.now();
  if (now - lastGesture < 150) return;
  lastGesture = now;
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
  let href: string | undefined;
  try {
    href = anchor ? new URL(anchor.href).origin : undefined;
  } catch {
    href = undefined;
  }
  void send({ type: "TAIF_GESTURE", timestamp: now, target: target ? describe(target).slice(0, 80) : "unknown", href, suspicious: anchor ? invisibleOverlayLink(anchor) : false });
}

/**
 * Ad scripts lay an invisible link over the whole page so any click "is" a link click. Such a
 * link is not counted as the user choosing that destination: no visible text or image, nearly
 * transparent, or covering a large part of the window on top of everything.
 */
function invisibleOverlayLink(anchor: HTMLAnchorElement): boolean {
  const style = getComputedStyle(anchor);
  const rect = anchor.getBoundingClientRect();
  const area = (rect.width * rect.height) / Math.max(1, innerWidth * innerHeight);
  const visibleContent = (anchor.innerText ?? "").trim().length > 0 || Boolean(anchor.querySelector("img,svg,video,picture"));
  const layered = (style.position === "fixed" || style.position === "absolute") && (Number.parseInt(style.zIndex, 10) || 0) >= 100;
  return Number(style.opacity) < 0.1 || (!visibleContent && area > 0.05) || (layered && area > 0.3);
}

let lastPopupToast = 0;
function popupBlocked(site: string, how: string) {
  const now = Date.now();
  if (now - lastPopupToast < 3000) return;
  lastPopupToast = now;
  void send({ type: "TAIF_PROTECTION_LOG", kind: "popup", site });
  showToast(`Protected by TAIF — blocked a popup${site && site !== "unknown" ? ` to ${site}` : ""} (${how}).`, [
    { label: "Allow once", run: () => window.postMessage({ __taif: "allow_popup", site }, "*") }
  ]);
}

/** Only newly added elements themselves (and a few likely overlay/timer descendants) are inspected. */
function flush() {
  flushTimer = undefined;
  if (document.hidden) {
    pendingRoots.clear();
    return;
  }
  let budget = 60;
  for (const root of [...pendingRoots].slice(0, 30)) {
    pendingRoots.delete(root);
    if (!root.isConnected || budget <= 0) continue;
    const likely = Array.from(root.querySelectorAll(`${TIMER_SELECTOR},dialog,[role=dialog],[role=alertdialog],[aria-modal=true],iframe`)).slice(0, 10);
    for (const element of [root, ...likely]) {
      inspect(element);
      budget -= 1;
    }
    if ((root.textContent?.length ?? 0) < 4000) findPromptContainers(root);
  }
  pendingRoots.clear();
  ensureSampling();
}

function inspect(element: Element) {
  if (element.closest("#taif-alert-host")) return;
  if (timers.size < MAX_TIMERS && !timers.has(element) && looksLikeTimer(element)) {
    timers.set(element, { key: keyOf(element), samples: [], resets: 0 });
    observeVisibility(element);
  }
  if (overlays.size < MAX_OVERLAYS && !overlays.has(element) && coverage(element) >= 0.4 && isOverlayStyle(element)) {
    overlays.set(element, { key: keyOf(element), firstSeen: Date.now() });
    observeVisibility(element);
    analyzePrompt(element, true);
  }
}

function looksLikeTimer(element: Element): boolean {
  if (element.matches(TIMER_SELECTOR)) return parseCountdown(element.textContent ?? "") !== undefined;
  if (element.childElementCount > 0) return false;
  const text = (element.textContent ?? "").trim();
  return text.length > 0 && text.length < 40 && parseCountdown(text) !== undefined && /\d/.test(text);
}

function isOverlayStyle(element: Element): boolean {
  if (element.matches("dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]")) return true;
  const style = getComputedStyle(element);
  return style.position === "fixed" || style.position === "sticky" ||
    (style.position === "absolute" && Number.parseInt(style.zIndex, 10) >= 100);
}

function coverage(element: Element): number {
  const rect = element.getBoundingClientRect();
  const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
  return innerWidth && innerHeight ? (width * height) / (innerWidth * innerHeight) : 0;
}

function isShown(element: Element): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.05 && rect.width > 0 && rect.height > 0;
}

/** Text-node walk limited to the inserted subtree; containers are analyzed when they become visible. */
function findPromptContainers(root: Element) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  for (let node = walker.nextNode(); node && seen < 300; node = walker.nextNode(), seen += 1) {
    if (!PROMPT_HINT.test(node.textContent ?? "")) continue;
    const container = node.parentElement?.closest("dialog,[role=dialog],[role=alertdialog],section,article,aside,div,body");
    if (container && !promptCandidates.has(container) && !container.closest("#taif-alert-host")) {
      promptCandidates.add(container);
      observeVisibility(container);
    }
  }
}

function onIntersect(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const isVisible = entry.isIntersecting && entry.intersectionRatio > 0;
    const was = visible.get(entry.target);
    visible.set(entry.target, isVisible);
    if (was === isVisible) continue;
    if (isVisible && promptCandidates.has(entry.target)) analyzePrompt(entry.target, false);
    resendVisibility(entry.target, isVisible);
  }
}

function analyzePrompt(element: Element, force: boolean) {
  if (!force && !isShown(element)) return;
  const html = element as HTMLElement;
  const links = Array.from(element.querySelectorAll("a[href]")).slice(0, 30).flatMap((anchor) => {
    try {
      const url = new URL((anchor as HTMLAnchorElement).href);
      const file = (anchor.getAttribute("download") || url.pathname.split("/").pop() || "").slice(0, 80);
      return [{ file, text: (anchor.textContent ?? "").trim().slice(0, 80) }];
    } catch {
      return [];
    }
  });
  const drafts = promptDrafts({
    key: keyOf(element),
    element: describe(element),
    text: (html.innerText ?? element.textContent ?? "").slice(0, 4000),
    downloadLinks: links,
    notificationRequested,
    isOverlay: overlays.has(element) || [...overlays.keys()].some((overlay) => overlay.contains(element)),
    inViewport: visible.get(element) ?? true
  });
  drafts.forEach((draft) => emit(draft, element));
}

function emit(draft: EventDraft, element: Element) {
  const signature = JSON.stringify([draft.title, draft.summary, draft.evidence, draft.in_viewport]);
  if (lastDrafts.get(draft.key) === signature) return;
  lastDrafts.set(draft.key, signature);
  draftElements.set(draft.key, { element, draft });
  void send({ type: "TAIF_LIVE_EVENT", draft });
}

/** Feature D: when an element leaves or enters the viewport, update its event's visibility for prioritization. */
function resendVisibility(element: Element, inViewport: boolean) {
  for (const { element: owner, draft } of draftElements.values()) {
    if (owner === element && draft.in_viewport !== inViewport) emit({ ...draft, in_viewport: inViewport }, element);
  }
}

function ensureSampling() {
  if (sampleTimer !== undefined || (!timers.size && !overlays.size)) return;
  sampleTimer = window.setInterval(sample, 1000);
}

function sample() {
  if (document.hidden) return;
  const now = Date.now();
  for (const [element, timer] of timers) {
    if (!element.isConnected) {
      timers.delete(element);
      continue;
    }
    const seconds = parseCountdown(element.textContent ?? "");
    if (seconds === undefined) continue;
    timer.samples.push({ t: now, seconds });
    if (timer.samples.length > 300) timer.samples.shift();
    const analysis = analyzeTimer(timer.samples);
    if (analysis.resets !== timer.resets) {
      timer.resets = analysis.resets;
      const draft = timerDraft(timer.key, describe(element), analysis, visible.get(element) ?? true);
      if (draft) emit(draft, element);
    }
  }
  for (const [element, overlay] of overlays) {
    if (!element.isConnected || !isShown(element)) {
      overlays.delete(element);
      continue;
    }
    const state = closeState(closeCandidates(element), hasCrossOriginFrame(element));
    overlay.initialState ??= state;
    if (state === "visible" && overlay.closeAfter === undefined) {
      overlay.closeAfter = overlay.initialState === "visible" ? 0 : now - overlay.firstSeen;
    }
    const nestedTimers = [...timers.entries()].filter(([timer]) => element.contains(timer));
    const draft = overlayDraft({
      key: overlay.key,
      element: describe(element),
      coverage: coverage(element),
      visibleMs: now - overlay.firstSeen,
      state,
      closeAvailableAfterMs: overlay.closeAfter,
      hasCountdown: nestedTimers.length > 0,
      timerResets: nestedTimers.reduce((sum, [, timer]) => sum + timer.resets, 0)
    });
    if (draft) emit(draft, element);
    if (draft?.event_type === "blocked_dismissal" && hideOverlays) suppressOverlay(element);
  }
  if (!timers.size && !overlays.size && sampleTimer !== undefined) {
    window.clearInterval(sampleTimer);
    sampleTimer = undefined;
  }
}

function closeCandidates(overlay: Element): CloseCandidate[] {
  return Array.from(overlay.querySelectorAll("button,a,[role=button],[aria-label],[title],span,div,i"))
    .filter((element) => {
      const text = (element.textContent ?? "").trim();
      const attrs = `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${element.getAttribute("class") ?? ""} ${element.id}`;
      return (element.childElementCount === 0 && CLOSE_TEXT.test(text)) || CLOSE_ATTR.test(attrs);
    })
    .slice(0, 20)
    .map((element) => {
      const html = element as HTMLButtonElement;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const hidden = style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.1 || rect.width < 6 || rect.height < 6;
      const topmost = hidden ? null : document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        hidden,
        disabled: Boolean(html.disabled) || element.getAttribute("aria-disabled") === "true" || style.pointerEvents === "none",
        obscured: !hidden && Boolean(topmost) && topmost !== element && !element.contains(topmost) && !topmost!.contains(element)
      };
    });
}

function hasCrossOriginFrame(element: Element): boolean {
  return Array.from(element.querySelectorAll("iframe")).some((frame) => {
    try {
      return new URL(frame.src, location.href).origin !== location.origin;
    } catch {
      return true;
    }
  });
}

/* ---------------- In-page contextual alert (shadow DOM, text only) ---------------- */

function showBanner(event: TaifEvent) {
  document.getElementById("taif-alert-host")?.remove();
  const host = document.createElement("div");
  host.id = "taif-alert-host";
  host.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;all:initial;position:fixed;top:12px;right:12px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .card{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;width:min(380px,calc(100vw - 24px));background:#102e3a;color:#fff;border-radius:14px;padding:16px;box-shadow:0 12px 36px rgba(0,0,0,.35)}
    .top{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#bfd1d3}
    .eyebrow{color:#f5cf87;font-weight:700;font-size:11px;letter-spacing:.06em;margin-top:10px}
    h2{font-size:17px;margin:6px 0}
    p{margin:6px 0;color:#d9e4e6}
    .box{background:#21495a;border-radius:10px;padding:10px 12px;margin:10px 0}
    .box b{display:block;font-size:12px;color:#bfd1d3;font-weight:600}
    .box span{display:block;font-size:15px;margin-bottom:6px;word-break:break-all}
    .why{background:#d3efdf;color:#163f37;border-radius:10px;padding:10px 12px;font-size:12.5px}
    .actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
    button{flex:1 1 auto;font:inherit;font-weight:650;border-radius:9px;padding:9px 10px;cursor:pointer;border:1px solid #d3efdf;background:transparent;color:#fff}
    button.primary{background:#d3efdf;color:#163f37}
    button.link{flex:0 0 auto;border:0;padding:6px 0;color:#d3efdf;text-decoration:underline;background:none}
    ul{margin:6px 0 0;padding-left:18px;font-size:12px;color:#d9e4e6}
    button:focus-visible{outline:3px solid #f5cf87;outline-offset:2px}`;
  const card = el("div", "card");
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-label", event.title);
  const top = el("div", "top", "TAIF Protection · real-time page monitoring");
  const eyebrow = el("div", "eyebrow", event.title.toUpperCase());
  const heading = el("h2", "", event.chain ? "You've been taken to another website." : event.title);
  const summary = el("p", "", event.summary);
  card.append(top, eyebrow, heading, summary);
  if (event.chain) {
    const box = el("div", "box");
    const route = [event.chain.source_host, ...event.chain.hops.map((hop) => hop.host)].filter((h, i, all) => i === 0 || all[i - 1] !== h);
    box.append(el("b", "", "Previous website"), el("span", "", event.chain.source_host));
    if (route.length > 2) box.append(el("b", "", "Passed through"), el("span", "", route.slice(1, -1).join(" → ")));
    box.append(el("b", "", "Current website"), el("span", "", route[route.length - 1]));
    card.append(box);
  }
  card.append(el("div", "why", `Why am I seeing this? ${event.classification}. Confidence ${Math.round(event.confidence * 100)}% · ${event.verification_status}. The destination has not been confirmed as malicious.`));
  const details = el("ul", "");
  details.hidden = true;
  [...event.evidence, `Limitations: ${event.limitations}`].forEach((line) => details.append(el("li", "", line)));
  const actions = el("div", "actions");
  const act = (action: string) => {
    void send({ type: "TAIF_ACTION", action, eventId: event.event_id });
    host.remove();
  };
  const stay = button(event.scenario_id === "A" ? "Stay on this site" : "OK", "", () => act("acknowledge"));
  actions.append(stay);
  if (event.chain) actions.append(button(returnLabel(event), "primary", () => act("return")));
  const evidenceToggle = button("View evidence", "link", () => {
    details.hidden = !details.hidden;
    evidenceToggle.textContent = details.hidden ? "View evidence" : "Hide evidence";
  });
  actions.append(evidenceToggle, button("Dismiss", "link", () => act("dismiss")));
  card.append(actions, details);
  shadow.append(style, card);
  document.documentElement.append(host);
  // Only move focus when this page already has it; taking focus would close an open toolbar popup.
  if (document.hasFocus()) stay.focus({ preventScroll: true });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

// Started last so every module-level binding above is initialized.
if (window.top === window && !window.__TAIF_MONITOR__) {
  window.__TAIF_MONITOR__ = true;
  start();
}

function returnLabel(event: TaifEvent): string {
  const source = event.chain?.source_host ?? "previous page";
  return event.chain?.opened_new_tab ? `Back to ${source} tab (closes this tab)` : `Back to ${source}`;
}

/* ---------------- Popup protection: cosmetic overlay suppression (opt-in) ---------------- */

const SENSITIVE_OVERLAY = /cookie|consent|privacy|gdpr|log ?in|sign ?in|password|payment|card|checkout|age verification|verify your age/i;

/**
 * Hides an overlay that has blocked the page with no usable close button. Never touches dialogs
 * that ask for a login, payment, consent or age check, and is undone with one click.
 */
function suppressOverlay(element: Element) {
  if (element.hasAttribute("data-taif-hidden")) return;
  const text = (element as HTMLElement).innerText ?? "";
  if (SENSITIVE_OVERLAY.test(text) || element.querySelector("input[type=password],input[autocomplete^=cc-],form")) return;
  let style = document.getElementById("taif-protect-style");
  if (!style) {
    style = document.createElement("style");
    style.id = "taif-protect-style";
    style.textContent = "[data-taif-hidden]{display:none!important}";
    document.documentElement.append(style);
  }
  element.setAttribute("data-taif-hidden", "1");
  if (element.hasAttribute("data-taif-hidden") && getComputedStyle(element).display === "none") {
    void send({ type: "TAIF_PROTECTION_LOG", kind: "overlay" });
    showToast("Protected by TAIF — a page overlay with no close button was hidden.", [
      { label: "Undo", run: () => element.removeAttribute("data-taif-hidden") }
    ]);
  }
}

function showToast(text: string, actions: { label: string; run: () => void }[]) {
  document.getElementById("taif-toast-host")?.remove();
  const host = document.createElement("div");
  host.id = "taif-toast-host";
  host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  const box = el("div", "");
  box.setAttribute("role", "status");
  box.style.cssText = "font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;background:#102e3a;color:#fff;padding:12px 14px;border-radius:12px;max-width:360px;box-shadow:0 10px 30px rgba(0,0,0,.35);border-left:4px solid #9ff0c4";
  const message = el("div", "", text);
  const row = el("div", "");
  row.style.cssText = "display:flex;gap:8px;margin-top:8px";
  for (const action of actions) {
    const control = button(action.label, "", () => {
      action.run();
      host.remove();
    });
    control.style.cssText = "font:inherit;font-weight:650;border:1px solid #d3efdf;background:transparent;color:#fff;border-radius:8px;padding:4px 10px;cursor:pointer";
    row.append(control);
  }
  box.append(message, row);
  shadow.append(box);
  document.documentElement.append(host);
  window.setTimeout(() => host.remove(), 8000);
}
