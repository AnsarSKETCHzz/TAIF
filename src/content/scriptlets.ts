import data from "../generated/scriptlets.json";
import { siteOf } from "../shared/url";

/**
 * Site-specific scriptlets from the uBlock filters list (GPLv3 data), with TAIF's own
 * implementations of the seven most-used ones. They run in the page's context at document_start,
 * before the site's ad scripts, and only on the sites the list names.
 */

type Rules = Record<string, string[][]>;

function hostKeys(host: string): string[] {
  const clean = host.toLowerCase().replace(/^www\./, "");
  const parts = clean.split(".");
  const chain = parts.map((_, index) => parts.slice(index).join(".")).filter((item) => item.includes("."));
  const site = siteOf(clean);
  const suffix = site.slice(site.indexOf("."));
  return [...chain, ...chain.filter((item) => item.endsWith(suffix) && item.length > suffix.length).map((item) => `${item.slice(0, -suffix.length)}.*`)];
}

/** uBO needles: "/regex/flags" or a plain substring; empty matches everything. */
function needle(raw: string | undefined): (text: string) => boolean {
  if (!raw) return () => true;
  const negate = raw.startsWith("!");
  const body = negate ? raw.slice(1) : raw;
  const regex = body.match(/^\/(.+)\/([gimsuy]*)$/);
  let test: (text: string) => boolean;
  try {
    const pattern = regex ? new RegExp(regex[1], regex[2]) : undefined;
    test = pattern ? (text) => pattern.test(text) : (text) => text.includes(body);
  } catch {
    test = (text) => text.includes(body);
  }
  return negate ? (text) => !test(text) : test;
}

/** Runs `onOwner(owner, prop)` for a dotted property path, waiting for missing parents to be assigned. */
function onPath(root: object, path: string, onOwner: (owner: Record<string, unknown>, prop: string) => void) {
  const [head, ...rest] = path.split(".");
  if (!rest.length) {
    onOwner(root as Record<string, unknown>, head);
    return;
  }
  const owner = root as Record<string, unknown>;
  const current = owner[head];
  if (current !== undefined && current !== null && (typeof current === "object" || typeof current === "function")) {
    onPath(current as object, rest.join("."), onOwner);
    return;
  }
  let value = current;
  try {
    Object.defineProperty(owner, head, {
      configurable: true,
      get: () => value,
      set: (next) => {
        value = next;
        if (next && (typeof next === "object" || typeof next === "function")) onPath(next as object, rest.join("."), onOwner);
      }
    });
  } catch {
    // Property can't be redefined on this page.
  }
}

function define(owner: Record<string, unknown>, prop: string, descriptor: PropertyDescriptor) {
  try {
    Object.defineProperty(owner, prop, { configurable: false, ...descriptor });
  } catch {
    // Already non-configurable.
  }
}

const abort = () => new ReferenceError("Blocked by TAIF");

const CONSTANTS: Record<string, () => unknown> = {
  true: () => true, false: () => false, null: () => null, undefined: () => undefined,
  noopFunc: () => () => undefined, trueFunc: () => () => true, falseFunc: () => () => false,
  emptyStr: () => "", "''": () => "", "\"\"": () => "", emptyArr: () => [], "[]": () => [], emptyObj: () => ({}), "{}": () => ({}),
  "-1": () => -1, yes: () => "yes", no: () => "no"
};

const timeoutRules: { match: (text: string) => boolean; delay?: string }[] = [];
const listenerRules: { type: (text: string) => boolean; handler: (text: string) => boolean }[] = [];
const openRules: ((text: string) => boolean)[] = [];

function wrapSetTimeout() {
  const native = window.setTimeout;
  window.setTimeout = new Proxy(native, {
    apply(target, self, args: unknown[]) {
      const code = String(args[0]);
      const delay = String(args[1] ?? "");
      const hit = timeoutRules.some((rule) => rule.match(code) && (!rule.delay || (rule.delay.startsWith("!") ? rule.delay.slice(1) !== delay : rule.delay === delay)));
      return hit ? 0 : Reflect.apply(target, self, args);
    }
  }) as typeof window.setTimeout;
}

function wrapAddEventListener() {
  const native = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = new Proxy(native, {
    apply(target, self, args: unknown[]) {
      const type = String(args[0]);
      const handler = String(args[1]);
      if (listenerRules.some((rule) => rule.type(type) && rule.handler(handler))) return undefined;
      return Reflect.apply(target, self, args);
    }
  });
}

function wrapOpen() {
  const native = window.open;
  window.open = new Proxy(native, {
    apply(target, self, args: unknown[]) {
      const url = String(args[0] ?? "");
      if (openRules.some((rule) => rule(url))) {
        try {
          (window.top ?? window).postMessage({ __taif: "popup_blocked", site: url ? new URL(url, location.href).hostname : "about:blank", how: "site rule" }, "*");
        } catch {
          // Ignore reporting failures.
        }
        return null;
      }
      return Reflect.apply(target, self, args);
    }
  });
}

const RUNNERS: Record<string, (...args: string[]) => void> = {
  aopr: (path) => onPath(window, path, (owner, prop) => define(owner, prop, { get: () => { throw abort(); }, set: () => undefined })),
  aopw: (path) => onPath(window, path, (owner, prop) => {
    let value = owner[prop];
    define(owner, prop, { get: () => value, set: () => { throw abort(); } });
    void value;
  }),
  acs: (path, rawNeedle) => {
    const match = needle(rawNeedle);
    onPath(window, path, (owner, prop) => {
      let value = owner[prop];
      const check = () => {
        const script = document.currentScript;
        if (script instanceof HTMLScriptElement && match(script.src || script.textContent || "")) throw abort();
      };
      define(owner, prop, { get: () => { check(); return value; }, set: (next) => { check(); value = next; } });
    });
  },
  set: (path, raw) => {
    const make = CONSTANTS[raw] ?? (/^-?\d+$/.test(raw) ? () => Number(raw) : undefined);
    if (!make) return;
    const constant = make();
    onPath(window, path, (owner, prop) => define(owner, prop, { get: () => constant, set: () => undefined }));
  },
  aeld: (type, handler) => {
    if (!listenerRules.length) wrapAddEventListener();
    listenerRules.push({ type: needle(type), handler: needle(handler) });
  },
  nostif: (code, delay) => {
    if (!timeoutRules.length) wrapSetTimeout();
    timeoutRules.push({ match: needle(code), delay: delay || undefined });
  },
  nowoif: (url) => {
    if (!openRules.length) wrapOpen();
    openRules.push(needle(url));
  }
};

export function runScriptlets() {
  const rules = data as Rules;
  const seen = new Set<string>();
  for (const key of hostKeys(location.hostname)) {
    for (const [name, ...args] of rules[key] ?? []) {
      const id = `${name}|${args.join("|")}`;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        RUNNERS[name]?.(...args);
      } catch {
        // One failing scriptlet must not stop the others.
      }
    }
  }
}
