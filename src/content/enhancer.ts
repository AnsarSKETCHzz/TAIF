import {
  CAPTCHA_FRAME,
  CATEGORY_LABELS,
  STRENGTH,
  TEXT,
  explain,
  verify,
  withDefaults,
  type Candidate,
  type Category,
  type ContextChange,
  type EnhanceReport,
  type EnhanceSettings,
  type Size
} from "../shared/enhance";
import { contrastOf, effectiveBackground } from "../shared/dom";
import { extractReviews } from "./reviews";

/**
 * Analyze & Enhance, injected on demand into the active tab. Everything it changes is owned and
 * tracked here: a data-taif-enh attribute on the element plus one extension <style> per document
 * or shadow root. Original inline styles, nodes and listeners are never touched, so every change
 * can be undone exactly.
 */

interface Entry {
  candidate: Candidate;
  element: Element;
  css: string;
  applied: boolean;
}

interface Guide { id: string; host: HTMLElement; change: ContextChange }

const OWN = "taif-";
const ATTR = "data-taif-enh";
const RISK_ATTR = "data-taif-risk";

let counter = 0;
let settings: EnhanceSettings = withDefaults(undefined);
const entries = new Map<string, Entry>();
const ids = new WeakMap<Element, string>();
const excluded = new WeakSet<Element>();
const styles = new Map<Document | ShadowRoot, HTMLStyleElement>();
const guides = new Map<string, Guide>();
const riskChanges = new Map<string, { element: Element; change: ContextChange }>();
const armedUntil = new WeakMap<Element, number>();
let contextChanges: ContextChange[] = [];
let observer: MutationObserver | undefined;
let observerTimer: number | undefined;
let riskCard: HTMLElement | undefined;
let riskListener: ((event: MouseEvent) => void) | undefined;
let visitor: EnhanceReport["visitor"] = "first-time";
let visitCounted = false;
let lastReport: EnhanceReport | undefined;

/* ---------------- DOM helpers ---------------- */

/** The document plus every open shadow root (closed roots are unreachable by design). */
function roots(): (Document | ShadowRoot)[] {
  const found: (Document | ShadowRoot)[] = [document];
  const walk = (root: Document | ShadowRoot, depth: number) => {
    if (depth > 4) return;
    for (const element of Array.from(root.querySelectorAll("*")).slice(0, 6000)) {
      if (element.shadowRoot) {
        found.push(element.shadowRoot);
        walk(element.shadowRoot, depth + 1);
      }
    }
  };
  walk(document, 0);
  return found;
}

function queryAll(selector: string): Element[] {
  return roots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
}

function isOwn(element: Element): boolean {
  return Boolean(element.closest(`[id^="${OWN}"]`));
}

function visible(element: Element): boolean {
  if (!element.isConnected || isOwn(element) || element.closest("[aria-hidden='true']")) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.05 && rect.width > 1 && rect.height > 1;
}

function measure(element: Element): Size {
  const rect = element.getBoundingClientRect();
  return { w: rect.width, h: rect.height, font: Number.parseFloat(getComputedStyle(element).fontSize) || 0 };
}

function nameOf(element: Element): string {
  const html = element as HTMLElement;
  const input = element as HTMLInputElement;
  const labelled = html.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => element.getRootNode() instanceof Document ? document.getElementById(id)?.textContent : "").join(" ");
  const fromLabels = "labels" in input && input.labels?.length ? Array.from(input.labels).map((label) => label.textContent).join(" ") : "";
  const raw = html.getAttribute("aria-label") || labelled || fromLabels || html.innerText || input.value || html.getAttribute("title") ||
    html.getAttribute("alt") || html.getAttribute("placeholder") || element.querySelector("img[alt]")?.getAttribute("alt") || "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

function ownText(element: Element): string {
  return Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
}

function idFor(element: Element): string {
  let id = ids.get(element);
  if (!id) {
    id = `e${counter += 1}`;
    ids.set(element, id);
  }
  return id;
}

function screenMode(): "compact" | "spacious" {
  return settings.screen === "auto" ? (innerWidth < 900 ? "compact" : "spacious") : settings.screen;
}

function targetSize(): number {
  return settings.targetPx + (screenMode() === "spacious" ? 4 : 0);
}

/* ---------------- Detection ---------------- */

const CONTROL = "button,input[type=submit],input[type=button],input[type=reset],[role=button],a[href],[role=link],summary,[role=tab],[role=menuitem]";
const FIELD = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=checkbox]):not([type=radio]):not([type=image]):not([type=file]):not([type=range]):not([type=color]),select,textarea";
const CAPTCHA_BOX = ".g-recaptcha,.h-captcha,.cf-turnstile,.frc-captcha,[data-sitekey],[id*=captcha i],[class*=captcha i],[name*=captcha i]";

function filledBackground(element: Element): boolean {
  const own = getComputedStyle(element).backgroundColor;
  const match = own.match(/rgba?\(([^)]+)\)/);
  if (!match) return false;
  const alpha = match[1].split(/[,\s/]+/)[3];
  if (alpha !== undefined && Number(alpha) < 0.3) return false;
  const parent = element.parentElement ? effectiveBackground(element.parentElement).color : undefined;
  return !parent || own.replace(/\s/g, "") !== `rgb(${parent.slice(0, 3).map(Math.round).join(",")})`;
}

function inNavigation(element: Element): boolean {
  return Boolean(element.closest("nav,header,[role=navigation],[role=menu],[role=menubar],[role=tablist]"));
}

function captchaContainer(element: Element): Element | undefined {
  let outer: Element | undefined;
  for (let node: Element | null = element.parentElement; node && node !== document.body; node = node.parentElement) {
    if (node.matches(CAPTCHA_BOX)) outer = node;
  }
  return outer;
}

function isCaptchaFrame(element: Element): boolean {
  const frame = element as HTMLIFrameElement;
  return element.tagName === "IFRAME" && CAPTCHA_FRAME.test(`${frame.src} ${frame.title} ${frame.name}`);
}

interface Found { element: Element; category: Category; name: string; issues: string[]; reason: string; suggestion: string; css: string; eligible: boolean }

function detect(): Found[] {
  const target = targetSize();
  const minFont = settings.minFontPx;
  const found: Found[] = [];
  const claimed = new WeakSet<Element>();
  const add = (item: Found) => {
    if (claimed.has(item.element) || excluded.has(item.element)) return;
    claimed.add(item.element);
    found.push(item);
  };
  const sizeIssues = (size: Size) => size.w < target - 0.5 || size.h < target - 0.5
    ? [`${Math.round(size.w)} × ${Math.round(size.h)} px is below your ${target} px target`] : [];
  const fontIssues = (size: Size, min = minFont) => size.font && size.font < min - 0.25 ? [`text is ${Math.round(size.font)} px (target ${min} px)`] : [];
  // Zoom strength (Normal / Large / Extra large): whole controls are zoomed, text grows by its own factor.
  const power = STRENGTH[settings.strength];
  const zoomCss = (factor = power.zoom) => factor > 1 ? `zoom:${factor}!important;` : "";
  const textPx = (base: number) => Math.round(base * power.text);

  // CAPTCHA first: frames, containers, images, instructions. Enlarged, never solved or bypassed.
  const captchaTargets = new Set<Element>();
  for (const frame of queryAll("iframe").filter((element) => isCaptchaFrame(element) && visible(element))) {
    // Scale the CAPTCHA itself; a full-width wrapper would make the scale far too small.
    const box = captchaContainer(frame);
    const snug = box && box.getBoundingClientRect().width <= frame.getBoundingClientRect().width * 1.3;
    captchaTargets.add(snug ? box : frame);
  }
  const framed = [...captchaTargets];
  for (const box of queryAll(".g-recaptcha,.h-captcha,.cf-turnstile,.frc-captcha,[data-sitekey]").filter(visible)) {
    if (![...captchaTargets].some((existing) => existing.contains(box) || box.contains(existing)) && !framed.some((frame) => box.contains(frame))) captchaTargets.add(box);
  }
  for (const image of queryAll("img,canvas").filter((element) =>
    /captcha/i.test(`${element.getAttribute("alt")} ${element.getAttribute("src")} ${element.id} ${element.getAttribute("class")}`) && visible(element))) {
    captchaTargets.add(image);
  }
  for (const element of captchaTargets) {
    const size = measure(element);
    const scale = Math.min(power.captchaMax, (innerWidth - 24) / Math.max(1, size.w));
    if (scale < 1.08) {
      add({ element, category: "captcha", name: nameOf(element) || "CAPTCHA", issues: ["already fills the screen width"], reason: "it already fills the screen width; use “Zoom whole page” instead",
        suggestion: "Use Zoom whole page", css: "", eligible: false });
      continue;
    }
    const s = Math.round(Math.max(1.3, Math.min(scale, power.captchaMax)) * 100) / 100;
    const isFrame = element.tagName === "IFRAME";
    // Frames are scaled with transform (keeps clicks aligned inside cross-origin frames); space is reserved with margins.
    const css = isFrame || element.querySelector("iframe")
      ? `transform:scale(${s})!important;transform-origin:top left!important;margin-right:${Math.round(size.w * (s - 1))}px!important;margin-bottom:${Math.round(size.h * (s - 1))}px!important;`
      : `zoom:${s}!important;`;
    add({ element, category: "captcha", name: nameOf(element) || "CAPTCHA", issues: [`shown at ${Math.round(size.w)} × ${Math.round(size.h)} px`],
      reason: "CAPTCHAs are hard to see and tap at their default size", suggestion: `Scale ×${s} and scroll into view`, css, eligible: true });
  }

  // OTP, CAPTCHA and regular fields.
  const fields = queryAll(FIELD).filter(visible).slice(0, 120);
  for (const field of fields) {
    const input = field as HTMLInputElement;
    const hint = `${input.autocomplete} ${input.name} ${input.id} ${input.placeholder} ${field.getAttribute("aria-label") ?? ""} ${nameOf(field)}`;
    const singleBox = input.maxLength === 1 && (field.parentElement?.querySelectorAll("input[maxlength='1']").length ?? 0) >= 4;
    const size = measure(field);
    let category: Category = "input";
    if (/one-time-code/.test(input.autocomplete) || TEXT.otp.test(hint) || singleBox) category = "otp";
    else if (TEXT.captcha.test(hint) || captchaContainer(field)) category = "captcha";
    const minForField = category === "otp" ? 22 : minFont;
    const issues = [...sizeIssues(size).filter(() => size.h < target - 0.5), ...fontIssues(size, minForField)];
    const css = zoomCss() + (category === "otp"
      ? `min-height:${target + 4}px!important;font-size:${Math.max(size.font, singleBox ? 26 : 22)}px!important;${singleBox ? `min-width:${target}px!important;text-align:center!important;` : "letter-spacing:.2em!important;"}box-sizing:border-box!important;`
      : `min-height:${target}px!important;font-size:${Math.max(size.font, category === "captcha" ? minFont + 2 : minFont)}px!important;padding:6px 10px!important;box-sizing:border-box!important;max-width:100%!important;`);
    add({
      element: field, category, name: nameOf(field) || input.type || "field", issues,
      reason: issues.length ? issues.join("; ") : power.zoom > 1 ? `your zoom strength is ${power.label} (×${power.zoom})` : "it already meets your size and text targets",
      suggestion: category === "otp" ? "Larger, spaced code characters" : "Taller field with larger text", css,
      eligible: issues.length > 0 || category === "captcha" || power.zoom > 1
    });
    for (const label of Array.from(input.labels ?? []).filter(visible)) {
      const labelSize = measure(label);
      const labelIssues = fontIssues(labelSize);
      if (!labelIssues.length && power.zoom === 1) continue;
      add({ element: label, category: category === "otp" ? "otp" : category === "captcha" ? "captcha" : "input", name: `Label: ${nameOf(label)}`,
        issues: labelIssues, reason: labelIssues.join("; "), suggestion: "Larger label text",
        css: `font-size:${textPx(Math.max(labelSize.font, minFont))}px!important;line-height:1.4!important;`, eligible: true });
    }
  }

  // CAPTCHA instructions near the challenge.
  for (const element of queryAll("p,span,label,div,h2,h3,h4,legend,small").filter((item) => ownText(item).length >= 8 && TEXT.captcha.test(ownText(item)) && visible(item)).slice(0, 6)) {
    const size = measure(element);
    add({ element, category: "captcha", name: ownText(element).slice(0, 60), issues: fontIssues(size, minFont + 2),
      reason: "CAPTCHA instructions are easy to miss", suggestion: "Larger, bolder instructions",
      css: `font-size:${textPx(Math.max(size.font, minFont + 2))}px!important;font-weight:600!important;line-height:1.5!important;`, eligible: true });
  }

  // Buttons, links and other controls.
  let navCount = 0;
  for (const control of queryAll(CONTROL).filter(visible).slice(0, 400)) {
    if (captchaContainer(control)) continue;
    const name = nameOf(control);
    const size = measure(control);
    const style = getComputedStyle(control);
    const isLink = control.matches("a[href],[role=link]");
    const inline = style.display === "inline";
    // Links inside running text are exempt from target-size rules (as in WCAG 2.5.8).
    if (isLink && inline && !inNavigation(control) && !TEXT.auth.test(name) && !TEXT.submit.test(name)) continue;
    let category: Category;
    if (TEXT.auth.test(name)) category = "auth";
    else if ((control as HTMLInputElement).type === "submit" || TEXT.submit.test(name)) category = "submit";
    else if (inNavigation(control)) {
      if ((navCount += 1) > 30) continue;
      category = "navigation";
    } else if (isLink) category = "small-target";
    else category = filledBackground(control) ? "primary" : "secondary";
    const issues = [...sizeIssues(size), ...fontIssues(size)];
    if (!issues.length && (category === "small-target" || category === "navigation")) continue;
    // With Large/Extra large, every action button is zoomed, not only undersized ones; navigation stays modest.
    const eligible = issues.length > 0 || (power.zoom > 1 && category !== "navigation" && category !== "small-target");
    const controlZoom = zoomCss(category === "navigation" ? Math.min(power.zoom, 1.3) : power.zoom);
    const display = inline || style.display === "inline-block" ? "display:inline-flex!important;align-items:center!important;justify-content:center!important;" : "";
    const spacing = screenMode() === "spacious" && (category === "navigation" || category === "small-target" || category === "secondary") ? "margin:3px!important;" : "";
    add({
      element: control, category, name: name || control.tagName.toLowerCase(), issues,
      reason: issues.length ? issues.join("; ") : power.zoom > 1 ? `your zoom strength is ${power.label} (×${power.zoom})` : "it already meets your size and text targets",
      suggestion: eligible ? `${power.zoom > 1 ? `Zoom ×${power.zoom}, ` : ""}at least ${target} × ${target} px${size.font < minFont ? `, ${minFont} px text` : ""}` : "No change needed",
      css: `${controlZoom}min-width:${target}px!important;min-height:${target}px!important;box-sizing:border-box!important;${display}${size.font && size.font < minFont ? `font-size:${minFont}px!important;` : ""}${spacing}${screenMode() === "compact" ? "max-width:100%!important;" : ""}`,
      eligible
    });
  }

  // Error and validation messages.
  const describedBy = queryAll("[aria-invalid='true'][aria-describedby]").flatMap((field) =>
    (field.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => document.getElementById(id)).filter((item): item is HTMLElement => Boolean(item)));
  const errorCandidates = [...queryAll("[role=alert],[aria-live=assertive],.error,.errors,.invalid-feedback,.error-message,.field-error,[class*=error i],[id*=error i]"), ...describedBy];
  for (const element of errorCandidates.filter(visible).slice(0, 15)) {
    const text = (element as HTMLElement).innerText?.trim() ?? "";
    if (text.length < 3 || text.length > 240 || !(element.matches("[role=alert]") || TEXT.error.test(text))) continue;
    const size = measure(element);
    add({ element, category: "error", name: text.slice(0, 60), issues: fontIssues(size),
      reason: fontIssues(size)[0] ?? "error messages should stand out", suggestion: "Larger, bold message",
      css: `font-size:${textPx(Math.max(size.font, minFont))}px!important;font-weight:600!important;line-height:1.5!important;`, eligible: true });
  }

  // Warnings, disclosures and other small text.
  let warnings = 0;
  let small = 0;
  for (const element of queryAll("p,small,span,label,li,div,td,dd").filter((item) => item.childElementCount <= 3 && ownText(item).length >= 15).slice(0, 1500)) {
    if (!visible(element)) continue;
    const text = ownText(element);
    const size = measure(element);
    if (TEXT.warning.test(text) && size.font < minFont - 0.25 && warnings < 20) {
      warnings += 1;
      add({ element, category: "warning", name: text.slice(0, 60), issues: fontIssues(size), reason: fontIssues(size)[0], suggestion: `${minFont} px text`,
        css: `font-size:${textPx(minFont)}px!important;line-height:1.5!important;`, eligible: true });
    } else if (size.font && size.font < 12 && small < 25) {
      small += 1;
      const contrast = contrastOf(element).contrast;
      add({ element, category: "small-text", name: text.slice(0, 60),
        issues: [...fontIssues(size), ...(contrast !== undefined && contrast < 4.5 ? [`contrast ${contrast.toFixed(1)}:1`] : [])],
        reason: fontIssues(size)[0], suggestion: `${minFont} px text`,
        css: `font-size:${textPx(minFont)}px!important;line-height:1.5!important;`, eligible: true });
    }
  }
  return found;
}

/* ---------------- Applying and undoing ---------------- */

function rootOf(element: Element): Document | ShadowRoot {
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root : document;
}

function rebuildStyles() {
  const byRoot = new Map<Document | ShadowRoot, string[]>();
  for (const [id, entry] of entries) {
    if (!entry.applied || !entry.css || !entry.element.isConnected) continue;
    const root = rootOf(entry.element);
    byRoot.set(root, [...(byRoot.get(root) ?? []), `[${ATTR}="${id}"]{${entry.css}}`]);
  }
  for (const [root, style] of styles) {
    if (!byRoot.has(root)) {
      style.remove();
      styles.delete(root);
    }
  }
  for (const [root, rules] of byRoot) {
    let style = styles.get(root);
    if (!style || !style.isConnected) {
      style = document.createElement("style");
      style.id = `${OWN}enhance`;
      (root instanceof Document ? root.head ?? root.documentElement : root).append(style);
      styles.set(root, style);
    }
    const focus = settings.focusRing ? `[${ATTR}]:focus-visible{outline:3px solid #d97706!important;outline-offset:2px!important}` : "";
    style.textContent = rules.join("\n") + focus;
  }
}

async function settle(): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    new Promise<void>((resolve) => setTimeout(resolve, 150))
  ]);
}

async function apply(idsToApply: string[]): Promise<void> {
  const target = targetSize();
  const chosen = idsToApply.map((id) => entries.get(id)).filter((entry): entry is Entry => Boolean(entry && entry.css && entry.element.isConnected));
  for (const entry of chosen) {
    entry.element.setAttribute(ATTR, entry.candidate.id);
    entry.applied = true;
    entry.candidate.status = "applied";
    entry.candidate.context = `${screenMode() === "spacious" ? "Spacious" : "Compact"} screen (${innerWidth} × ${innerHeight} px)`;
  }
  rebuildStyles();
  await settle();
  for (const entry of chosen) {
    const after = measure(entry.element);
    entry.candidate.after = after;
    entry.candidate.status = verify(entry.candidate, after, target, settings.minFontPx);
  }
  const captcha = chosen.find((entry) => entry.candidate.category === "captcha" && entry.element.tagName !== "LABEL");
  captcha?.element.scrollIntoView({ block: "center", behavior: "smooth" });
  if (screenMode() === "compact" && document.documentElement.scrollWidth > innerWidth + 2) {
    addContext("Screen size: compact", "Page", "Prevent horizontal overflow", "Enhanced elements are capped at the screen width.");
  }
  watch();
}

function undo(idsToUndo: string[]) {
  for (const id of idsToUndo) {
    const entry = entries.get(id);
    if (entry) {
      entry.element.removeAttribute(ATTR);
      entry.applied = false;
      entry.candidate.after = undefined;
      entry.candidate.status = "undone";
    }
    const guide = guides.get(id);
    if (guide) {
      guide.host.remove();
      guides.delete(id);
      contextChanges = contextChanges.filter((change) => change.id !== id);
    }
    const risk = riskChanges.get(id);
    if (risk) {
      risk.element.removeAttribute(RISK_ATTR);
      riskChanges.delete(id);
      contextChanges = contextChanges.filter((change) => change.id !== id);
    }
  }
  rebuildStyles();
}

function restoreAll() {
  undo([...entries.keys(), ...guides.keys(), ...riskChanges.keys()]);
  clearRisk();
  for (const style of styles.values()) style.remove();
  styles.clear();
  queryAll(`[${ATTR}]`).forEach((element) => element.removeAttribute(ATTR));
  contextChanges = [];
  observer?.disconnect();
  observer = undefined;
}

/** One observer: re-tags elements a framework re-rendered, and enlarges CAPTCHA challenges that appear later. */
function watch() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (records.every((record) => Array.from(record.addedNodes).every((node) => node instanceof Element && isOwn(node)))) return;
    if (observerTimer !== undefined) return;
    observerTimer = window.setTimeout(() => {
      observerTimer = undefined;
      void reconcile();
    }, 600);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

async function reconcile() {
  const lost = [...entries.values()].filter((entry) => entry.applied && !entry.element.isConnected);
  const fresh = detect();
  for (const entry of lost) {
    const match = fresh.find((item) => item.category === entry.candidate.category && item.name === entry.candidate.name && !ids.has(item.element));
    if (match) {
      ids.set(match.element, entry.candidate.id);
      entry.element = match.element;
      match.element.setAttribute(ATTR, entry.candidate.id);
    }
  }
  // New CAPTCHA frames (e.g. the image challenge) get the same treatment without another click.
  const captchaOn = [...entries.values()].some((entry) => entry.applied && entry.candidate.category === "captcha");
  const added: string[] = [];
  if (captchaOn && settings.categories.captcha) {
    for (const item of fresh.filter((found) => found.category === "captcha" && found.eligible && !ids.has(found.element))) {
      added.push(register(item).candidate.id);
    }
  }
  if (added.length) await apply(added);
  else rebuildStyles();
}

function register(item: Found): Entry {
  const id = idFor(item.element);
  const existing = entries.get(id);
  const before = existing?.applied ? existing.candidate.before : measure(item.element);
  const candidate: Candidate = {
    id, category: item.category, name: item.name, tag: item.element.tagName.toLowerCase(), before,
    issues: item.issues, reason: item.reason, suggestion: item.suggestion,
    eligible: item.eligible && settings.categories[item.category] && Boolean(item.css),
    status: existing?.applied ? existing.candidate.status : item.css ? (item.eligible ? "detected" : "skipped") : "unsupported",
    after: existing?.applied ? existing.candidate.after : undefined
  };
  if (!settings.categories[item.category] && item.eligible) {
    candidate.status = "skipped";
    candidate.reason = `the ${CATEGORY_LABELS[item.category]} category is turned off`;
  }
  const entry: Entry = { candidate, element: item.element, css: existing?.applied ? existing.css : item.css, applied: existing?.applied ?? false };
  entries.set(id, entry);
  return entry;
}

/* ---------------- Context: session and simulated risk ---------------- */

function addContext(signal: string, element: string, rule: string, change: string, id = `c${counter += 1}`): ContextChange {
  const item = { id, signal, element, rule, change };
  contextChanges.push(item);
  return item;
}

function visitKey(): string {
  let h = 2166136261;
  for (const char of location.hostname) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}

async function countVisit(): Promise<number> {
  const { taif_visits: raw } = await chrome.storage.local.get("taif_visits");
  const visits = (raw && typeof raw === "object" ? raw : {}) as Record<string, number>;
  const previous = visits[visitKey()] ?? 0;
  if (!visitCounted) {
    visitCounted = true;
    visits[visitKey()] = previous + 1;
    await chrome.storage.local.set({ taif_visits: visits });
  }
  return previous;
}

function bubble(anchor: Element, text: string): HTMLElement {
  const host = document.createElement("div");
  host.id = `${OWN}guide-${counter += 1}`;
  const rect = anchor.getBoundingClientRect();
  host.style.cssText = `all:initial;position:absolute;z-index:2147483646;left:${Math.round(rect.left + scrollX)}px;top:${Math.round(rect.bottom + scrollY + 6)}px`;
  const shadow = host.attachShadow({ mode: "closed" });
  const box = document.createElement("div");
  box.style.cssText = "font:13px/1.4 system-ui,sans-serif;background:#102e3a;color:#fff;padding:8px 10px;border-radius:8px;max-width:260px;box-shadow:0 6px 18px rgba(0,0,0,.3)";
  box.textContent = text;
  const close = document.createElement("button");
  close.textContent = "Got it";
  close.style.cssText = "margin-left:8px;font:inherit;border:0;border-radius:6px;padding:2px 8px;background:#d3efdf;color:#163f37;cursor:pointer";
  close.addEventListener("click", () => {
    const id = [...guides.entries()].find(([, guide]) => guide.host === host)?.[0];
    if (id) undo([id]);
  });
  box.append(close);
  shadow.append(box);
  document.body.append(host);
  return host;
}

function showGuidance(candidates: Candidate[]) {
  if (!settings.guidance) return;
  const picks: [Category, string][] = [
    ["captcha", "This is a CAPTCHA. TAIF made it bigger; you still complete it yourself."],
    ["otp", "Type the code you received here."],
    ["submit", "This is the main button to continue."]
  ];
  for (const [category, text] of picks) {
    const candidate = candidates.find((item) => item.category === category && (item.status === "verified" || item.status === "applied" || item.status === "skipped"));
    const element = candidate && entries.get(candidate.id)?.element;
    if (!element || !visible(element)) continue;
    const id = `g${counter += 1}`;
    const host = bubble(element, text);
    const change = addContext("Session: first-time visitor", `${CATEGORY_LABELS[category]} "${candidate.name}"`, "Show one short tip next to key controls on a first visit", `Tip: “${text}”`, id);
    guides.set(id, { id, host, change });
  }
}

function clearRisk() {
  for (const { element } of riskChanges.values()) element.removeAttribute(RISK_ATTR);
  riskChanges.clear();
  document.getElementById(`${OWN}risk-style`)?.remove();
  riskCard?.remove();
  riskCard = undefined;
  if (riskListener) document.removeEventListener("click", riskListener, true);
  riskListener = undefined;
  contextChanges = contextChanges.filter((change) => !change.signal.startsWith("Simulated risk"));
}

/** Test input only: highlights consequential controls and asks for a second click. Never blocks for good. */
function applyRisk() {
  clearRisk();
  if (!settings.risk) return;
  const controls = queryAll(CONTROL).filter((element) => visible(element) && TEXT.risky.test(nameOf(element))).slice(0, 15);
  const style = document.createElement("style");
  style.id = `${OWN}risk-style`;
  style.textContent = `[${RISK_ATTR}]{outline:3px dashed #b3261e!important;outline-offset:3px!important}`;
  document.head.append(style);
  for (const element of controls) {
    const id = `r${counter += 1}`;
    element.setAttribute(RISK_ATTR, id);
    riskChanges.set(id, { element, change: addContext("Simulated risk (test input)", `"${nameOf(element)}"`, "Highlight consequential actions and ask for a second click", "Red dashed outline + review step", id) });
  }
  riskCard = document.createElement("div");
  riskCard.id = `${OWN}risk-card`;
  riskCard.style.cssText = "all:initial;position:fixed;left:12px;bottom:12px;z-index:2147483646";
  const shadow = riskCard.attachShadow({ mode: "closed" });
  const card = document.createElement("div");
  card.style.cssText = "font:13px/1.45 system-ui,sans-serif;background:#5c1f1a;color:#fff;padding:10px 12px;border-radius:10px;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.35)";
  card.textContent = `Simulated risk signal is ON (a test input you turned on in TAIF). ${controls.length} consequential action(s) on this page are outlined in red and ask for a second click. TAIF does not verify fraud.`;
  shadow.append(card);
  document.body.append(riskCard);
  riskListener = (event: MouseEvent) => {
    const control = (event.target as Element | null)?.closest(`[${RISK_ATTR}]`);
    if (!control) return;
    if ((armedUntil.get(control) ?? 0) > Date.now()) return; // Second click: the real click goes through untouched.
    event.preventDefault();
    event.stopImmediatePropagation();
    armedUntil.set(control, Date.now() + 10_000);
    card.textContent = `Review: you're about to “${nameOf(control)}”. Check the amount and details, then click it again within 10 s to proceed. (Simulated risk test.)`;
  };
  document.addEventListener("click", riskListener, true);
}

/* ---------------- Report ---------------- */

function buildReport(): EnhanceReport {
  const candidates = [...entries.values()].map((entry) => entry.candidate);
  lastReport = {
    url: `${location.origin}${location.pathname}`,
    host: location.hostname,
    candidates: candidates.map((candidate) => ({ ...candidate, reason: candidate.reason, suggestion: candidate.suggestion, explanation: explain(candidate, settings) } as Candidate)),
    context: contextChanges,
    screen: { width: innerWidth, height: innerHeight, mode: screenMode() },
    visitor,
    analyzedAt: new Date().toISOString()
  };
  return lastReport;
}

async function analyze(saved: unknown, autoApply: boolean): Promise<EnhanceReport> {
  settings = withDefaults(saved);
  for (const [id, entry] of entries) if (!entry.applied) entries.delete(id);
  contextChanges = contextChanges.filter((change) => change.signal.startsWith("Simulated risk") || guides.has(change.id));
  for (const item of detect()) register(item);
  const previous = await countVisit();
  visitor = previous === 0 ? "first-time" : "returning";
  addContext(`Screen size: ${screenMode()} (${innerWidth} × ${innerHeight} px${settings.screen === "auto" ? "" : ", manual override"})`, "All enhanced controls",
    screenMode() === "spacious" ? "Spacious adds 4 px to targets and spacing between small controls" : "Compact keeps targets but caps widths to prevent horizontal scrolling",
    `Target size ${targetSize()} px`);
  if (autoApply) {
    await apply([...entries.values()].filter((entry) => entry.candidate.eligible && !entry.applied).map((entry) => entry.candidate.id));
  } else {
    for (const entry of entries.values()) if (entry.candidate.eligible && !entry.applied) entry.candidate.status = "suggested";
  }
  if (visitor === "first-time" && !guides.size) showGuidance([...entries.values()].map((entry) => entry.candidate));
  else if (visitor === "returning") addContext(`Session: returning visitor (visit ${previous + 1})`, "Tips", "Skip first-visit tips; everything else unchanged", "No tips shown");
  applyRisk();
  return buildReport();
}

declare global {
  interface Window {
    __TAIF_ENHANCE__?: Record<string, (...args: never[]) => unknown>;
  }
}

if (!window.__TAIF_ENHANCE__) {
  window.__TAIF_ENHANCE__ = {
    analyze: (saved: unknown, autoApply: boolean) => analyze(saved, autoApply),
    apply: async (list: string[]) => {
      await apply(list);
      return buildReport();
    },
    undo: (list: string[]) => {
      undo(list);
      return buildReport();
    },
    exclude: (id: string) => {
      const entry = entries.get(id);
      if (entry) {
        undo([id]);
        excluded.add(entry.element);
        entry.candidate.status = "skipped";
        entry.candidate.eligible = false;
        entry.candidate.reason = "you excluded it for this session";
      }
      return buildReport();
    },
    setRisk: (saved: unknown) => {
      settings = withDefaults(saved);
      applyRisk();
      return buildReport();
    },
    restoreAll: () => {
      restoreAll();
      entries.clear();
      return buildReport();
    },
    report: () => (entries.size || contextChanges.length ? buildReport() : undefined),
    reviews: () => extractReviews()
  } as unknown as Window["__TAIF_ENHANCE__"];
}
