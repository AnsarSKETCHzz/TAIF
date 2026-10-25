import { siteOf } from "../shared/url";

/**
 * Popup guard, running in the page's own context before any page script (all frames, including
 * script-made about:blank frames). Blocks the standard popunder techniques:
 *  - window.open to another site when the user didn't click something meant to open it
 *  - window.open("about:blank") popunders opened the same way
 *  - script-generated clicks on links that open another site in a new tab
 *  - grabbing a fresh window.open from a hidden iframe
 * Links and buttons the user really clicks keep working. Every block is reported so TAIF can
 * show "Blocked a popup to … — Allow once".
 */

const INTERACTIVE = "a[href],button,input[type=submit],input[type=button],input[type=image],[role=button],[role=link],[role=menuitem],label,select,summary";
const ACTIVATION_MS = 1200;

let lastActivation = { at: 0, target: null as Element | null };
const allowed = new Map<string, number>();

function topSite(): string {
  try {
    return siteOf((window.top ?? window).location.hostname);
  } catch {
    return siteOf(location.hostname); // Cross-origin top: fall back to this frame.
  }
}

function siteOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url, location.href);
    if (parsed.protocol === "about:" || parsed.href === "about:blank") return "about:blank";
    return /^https?:$/.test(parsed.protocol) ? siteOf(parsed.hostname) : undefined;
  } catch {
    return undefined;
  }
}

function report(url: string, how: string) {
  const site = siteOfUrl(url) ?? "unknown";
  try {
    (window.top ?? window).postMessage({ __taif: "popup_blocked", site, how }, "*");
  } catch {
    window.postMessage({ __taif: "popup_blocked", site, how }, "*");
  }
}

/** True when a real, recent user click/key aimed at something meant to open this URL. */
function userIntended(targetSite: string): boolean {
  if (performance.now() - lastActivation.at > ACTIVATION_MS || !lastActivation.target) return false;
  const control = lastActivation.target.closest(INTERACTIVE);
  if (!control) return false; // A click on a video overlay, div or the page itself.
  const link = control.closest("a[href]") as HTMLAnchorElement | null;
  // A popup to a different site than the link clicked is a popunder riding on that click.
  if (link) return siteOfUrl(link.href) === targetSite || targetSite === topSite();
  return targetSite !== "about:blank";
}

function blocked(targetSite: string | undefined): boolean {
  if (!targetSite || targetSite === topSite()) return false;
  const until = allowed.get(targetSite) ?? 0;
  return until < Date.now();
}

/** Stand-in returned for a blocked window.open, so page scripts don't crash. */
function fakeWindow(): Window {
  const noop = () => undefined;
  const target = { closed: true, close: noop, focus: noop, blur: noop, postMessage: noop, location: { href: "", replace: noop, assign: noop }, document: { write: noop, close: noop, open: noop } };
  return new Proxy(target, { get: (object, key) => (key in object ? object[key as keyof typeof object] : noop) }) as unknown as Window;
}

function guardOpen(win: Window) {
  const owner = win as Window & { __taifGuarded?: boolean };
  if (owner.__taifGuarded) return;
  owner.__taifGuarded = true;
  const native = win.open;
  win.open = new Proxy(native, {
    apply(target, self, args: unknown[]) {
      const url = String(args[0] ?? "") || "about:blank";
      const site = siteOfUrl(url);
      if (blocked(site) && !userIntended(site!)) {
        report(url, "window.open");
        return fakeWindow();
      }
      return Reflect.apply(target, self, args);
    }
  });
}

function guardLinks() {
  // Script-generated clicks on links that leave the site in a new tab.
  const shouldBlock = (anchor: HTMLAnchorElement, trusted: boolean) => {
    const site = siteOfUrl(anchor.href);
    if (trusted || !blocked(site)) return false;
    const opensElsewhere = anchor.target === "_blank" || anchor.target === "_new" || !anchor.isConnected;
    const isUsersTarget = lastActivation.target && (anchor === lastActivation.target || anchor.contains(lastActivation.target));
    return opensElsewhere && !isUsersTarget;
  };
  document.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (anchor && shouldBlock(anchor, event.isTrusted)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      report(anchor.href, "synthetic link click");
    }
  }, true);
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (shouldBlock(this, false)) {
      report(this.href, "synthetic link click");
      return;
    }
    return nativeClick.call(this);
  };
}

function guardFrames() {
  // A hidden iframe's window.open is a fresh, unguarded copy; guard it when a script reaches for it.
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
  if (!descriptor?.get) return;
  const getter = descriptor.get;
  Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
    ...descriptor,
    get(this: HTMLIFrameElement) {
      const win = getter.call(this) as Window | null;
      try {
        if (win) guardOpen(win);
      } catch {
        // Cross-origin frame: its own copy of this script guards it.
      }
      return win;
    }
  });
}

export function startPopupGuard() {
  const remember = (event: Event) => {
    if (!event.isTrusted) return;
    if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
    lastActivation = { at: performance.now(), target: event.target instanceof Element ? event.target : null };
  };
  for (const type of ["pointerdown", "mousedown", "click", "keydown"]) window.addEventListener(type, remember, { capture: true, passive: true });
  window.addEventListener("message", (event) => {
    const data = event.data as { __taif?: string; site?: string } | null;
    if (data?.__taif === "allow_popup" && typeof data.site === "string") allowed.set(data.site, Date.now() + 60_000);
  });
  guardOpen(window);
  guardLinks();
  guardFrames();
}
