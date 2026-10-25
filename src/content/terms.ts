/**
 * Add-on: highlights "Terms and Conditions"-style phrases on every page with the CSS Custom
 * Highlight API. Nothing is inserted into or wrapped around the page's own nodes, so layout,
 * links and frameworks are untouched. On by default; `taif_terms_highlight: false` turns it off.
 */

const NAME = "taif-terms";
const KEY = "taif_terms_highlight";
const PHRASE = /\b(?:terms\s*(?:and|&)\s*conditions|terms\s+of\s+(?:service|use|sale)|conditions\s+of\s+(?:use|sale)|t\s?&\s?cs?)\b/gi;
const HINT = /terms|conditions|t\s?&\s?c/i;
const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "INPUT", "SELECT", "OPTION", "TEMPLATE", "SVG", "CODE", "PRE"]);
const INLINE = new Set(["A", "ABBR", "B", "BDI", "BDO", "BIG", "CITE", "DFN", "EM", "FONT", "I", "KBD", "LABEL", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "TIME", "U", "VAR"]);

let enabled = true;
let highlight: Highlight | undefined;
let observer: MutationObserver | undefined;
let timer: number | undefined;
const pending = new Set<Element>();

function supported(): boolean {
  return typeof Highlight === "function" && "highlights" in CSS;
}

function ensureStyle() {
  if (document.getElementById(`${NAME}-style`)) return;
  const style = document.createElement("style");
  style.id = `${NAME}-style`;
  style.textContent = `::highlight(${NAME}){background-color:#ffe94d;color:#111;text-decoration:underline 2px #ff7a00}`;
  (document.head ?? document.documentElement).append(style);
}

function skipped(element: Element | null): boolean {
  for (let node = element; node; node = node.parentElement) {
    if (SKIP.has(node.tagName.toUpperCase()) || node.id.startsWith("taif-") || (node as HTMLElement).isContentEditable) return true;
  }
  return false;
}

/** Nearest non-inline ancestor: a phrase may run across inline tags (Terms <b>and</b> Conditions) but not across blocks. */
function blockOf(node: Node): Element | null {
  let element = node.parentElement;
  while (element && INLINE.has(element.tagName.toUpperCase())) element = element.parentElement;
  return element;
}

/** Finds phrase matches under `root`, joining text nodes of the same block, and returns them as Ranges. */
function find(root: Element): Range[] {
  if (!HINT.test(root.textContent ?? "")) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeValue?.trim() && !skipped(node.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  let nodes: Text[] = [];
  let block: Element | null = null;
  const flush = () => {
    if (!nodes.length) return;
    const starts: number[] = [];
    let text = "";
    for (const node of nodes) {
      starts.push(text.length);
      text += node.data;
    }
    if (HINT.test(text)) {
      for (const match of text.matchAll(PHRASE)) {
        const at = (offset: number): [Text, number] => {
          let i = starts.length - 1;
          while (i > 0 && starts[i] > offset) i -= 1;
          return [nodes[i], offset - starts[i]];
        };
        const [startNode, startOffset] = at(match.index!);
        const [endNode, endOffset] = at(match.index! + match[0].length - 1);
        const range = document.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset + 1);
        ranges.push(range);
      }
    }
    nodes = [];
  };
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const owner = blockOf(node);
    if (owner !== block) {
      flush();
      block = owner;
    }
    nodes.push(node);
  }
  flush();
  return ranges;
}

/** Re-scans `root`: drops its old ranges (and any whose text left the page), then adds fresh ones. */
function scan(root: Element) {
  if (!highlight) return;
  for (const range of [...highlight]) {
    const container = (range as Range).commonAncestorContainer;
    if (!container.isConnected || root.contains(container)) highlight.delete(range);
  }
  for (const range of find(root)) highlight.add(range);
}

function flushPending() {
  timer = undefined;
  if (!enabled || document.hidden) return;
  const roots = [...pending].filter((element) => element.isConnected);
  pending.clear();
  // Scan only the outermost changed blocks.
  for (const root of roots) if (!roots.some((other) => other !== root && other.contains(root))) scan(root);
}

function queue(element: Element) {
  pending.add(element);
  if (timer === undefined) timer = window.setTimeout(flushPending, 800);
}

function start() {
  if (!supported() || !document.body) return;
  ensureStyle();
  highlight = new Highlight();
  CSS.highlights.set(NAME, highlight);
  const first = () => queue(document.body);
  if ("requestIdleCallback" in window) requestIdleCallback(first, { timeout: 1500 });
  else first();
  observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || skipped(target)) continue;
      if (record.type === "characterData" || [...record.addedNodes].some((node) => node.nodeType === Node.TEXT_NODE || (node instanceof Element && !node.id.startsWith("taif-")))) {
        queue(blockOf(record.target) ?? target);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function stop() {
  observer?.disconnect();
  observer = undefined;
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  pending.clear();
  if (supported()) CSS.highlights.delete(NAME);
  highlight = undefined;
  document.getElementById(`${NAME}-style`)?.remove();
}

declare global {
  interface Window {
    __TAIF_TERMS__?: boolean;
  }
}

if (!window.__TAIF_TERMS__) {
  window.__TAIF_TERMS__ = true;
  // A tab that loaded in the background is scanned when it is first shown.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && highlight && pending.size) flushPending();
  });
  void chrome.storage.local.get(KEY).then((stored) => {
    enabled = stored[KEY] !== false;
    if (enabled) start();
  }, () => start());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(KEY in changes)) return;
    enabled = changes[KEY].newValue !== false;
    if (enabled && !highlight) start();
    else if (!enabled) stop();
  });
}

export {};
