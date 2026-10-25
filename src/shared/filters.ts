/**
 * Converts Adblock Plus-syntax filter lists (EasyList, EasyPrivacy) into Chrome declarativeNetRequest
 * rules and cosmetic (element-hiding) data. Used at build time (Node, type-stripped) and by the
 * service worker for list updates, so it has no imports and uses only erasable TypeScript syntax.
 *
 * Unsupported syntax is skipped and counted, never approximated with broader rules.
 */

export interface DnrCondition {
  urlFilter?: string;
  requestDomains?: string[];
  isUrlFilterCaseSensitive?: boolean;
  domainType?: "firstParty" | "thirdParty";
  initiatorDomains?: string[];
  excludedInitiatorDomains?: string[];
  resourceTypes?: string[];
  excludedResourceTypes?: string[];
}

export interface DnrRule {
  id: number;
  priority: number;
  action: { type: "block" | "allow" | "allowAllRequests" };
  condition: DnrCondition;
}

export interface CosmeticData {
  /** Selectors hidden on every site. */
  generic: string[];
  /** hostname → selectors hidden only there. */
  specific: Record<string, string[]>;
  /** hostname → selectors that must NOT be hidden there (#@# exceptions). */
  exceptions: Record<string, string[]>;
  /** Sites where generic hiding is switched off ($generichide / $elemhide exceptions). */
  genericHide: string[];
}

export interface ConversionStats {
  lines: number;
  networkRules: number;
  groupedDomains: number;
  cosmeticGeneric: number;
  cosmeticSpecific: number;
  scriptlets: number;
  skipped: Record<string, number>;
}

export interface Conversion {
  rules: DnrRule[];
  cosmetic: CosmeticData;
  /** Domains the list marks as ad popups ($popup): DNR cannot block popups; TAIF closes these tabs. */
  popupDomains: string[];
  /** Domains fully blocked as ad/tracking servers (used to recognise ad iframes). */
  blockedDomains: string[];
  /** site (or entity site.*) → scriptlet calls [name, ...args] run on that site. */
  scriptlets: Record<string, string[][]>;
  stats: ConversionStats;
}

const TYPE_MAP: Record<string, string> = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  object: "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  frame: "sub_frame",
  ping: "ping",
  beacon: "ping",
  media: "media",
  font: "font",
  websocket: "websocket",
  other: "other"
};

const UNSUPPORTED_OPTIONS = /^(?:csp|redirect|redirect-rule|rewrite|removeparam|queryprune|header|permissions|replace|cookie|sitekey|webrtc|genericblock|empty|mp4|denyallow|to|method|urltransform|uritransform|jsonprune|hls|app|network|stealth|content|extension|jsinject|urlblock|specifichide|ehide|shide|ghide|all|badfilter|strict1p|strict3p|header|inline-script|inline-font|match-case-insensitive)$/;

/** Selector syntax Chrome's CSS engine cannot evaluate (procedural/extended filters). */
const EXTENDED_SELECTOR = /:-abp-|:has-text|:contains\(|:matches-css|:xpath|:upward|:remove\(|:style\(|:watch-attr|:min-text-length|:others\(|:matches-path|:matches-attr|:matches-prop|:if\(|:if-not|:nth-ancestor|:remove-attr|:remove-class|:matches-media|:shadow/;

const HOST = /^[a-z0-9.-]+\.[a-z0-9-]+$|^[a-z0-9-]+\.[a-z]{2,}$/;

function isAsciiPattern(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

/** uBO "entity" domain: example.* matches example under any ending (piracy sites rotate TLDs). */
const ENTITY = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.\*$/;

function domainList(raw: string, allowEntities = false): { include: string[]; exclude: string[]; valid: boolean } {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const part of raw.split("|").map((item) => item.trim().toLowerCase()).filter(Boolean)) {
    const negated = part.startsWith("~");
    const domain = negated ? part.slice(1) : part;
    // Entity domains have no network (DNR) equivalent, but page-side rules can match them.
    if (!HOST.test(domain) && !(allowEntities && ENTITY.test(domain))) return { include, exclude, valid: false };
    (negated ? exclude : include).push(domain);
  }
  return { include, exclude, valid: true };
}

/** Scriptlets TAIF implements itself, with the uBO names and aliases that map to them. */
const SCRIPTLETS: Record<string, string> = {
  "nowoif": "nowoif", "no-window-open-if": "nowoif", "window.open-defuser": "nowoif",
  "aopr": "aopr", "abort-on-property-read": "aopr",
  "aopw": "aopw", "abort-on-property-write": "aopw",
  "acs": "acs", "abort-current-script": "acs", "acis": "acs", "abort-current-inline-script": "acs",
  "set": "set", "set-constant": "set",
  "aeld": "aeld", "addEventListener-defuser": "aeld", "add-event-listener-defuser": "aeld",
  "nostif": "nostif", "no-setTimeout-if": "nostif", "setTimeout-defuser": "nostif"
};

/** Splits scriptlet arguments on commas, honouring backslash-escaped commas. */
function scriptletArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "\\" && raw[i + 1] === ",") {
      current += ",";
      i += 1;
    } else if (raw[i] === ",") {
      args.push(current.trim());
      current = "";
    } else current += raw[i];
  }
  args.push(current.trim());
  return args.map((arg) => arg.replace(/^(['"])(.*)\1$/, "$2"));
}

function bump(stats: ConversionStats, reason: string) {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
}

export function convertFilterList(text: string, options: { startId?: number; maxRules?: number } = {}): Conversion {
  const stats: ConversionStats = { lines: 0, networkRules: 0, groupedDomains: 0, cosmeticGeneric: 0, cosmeticSpecific: 0, scriptlets: 0, skipped: {} };
  const scriptlets: Record<string, string[][]> = {};
  const cosmetic: CosmeticData = { generic: [], specific: {}, exceptions: {}, genericHide: [] };
  const genericSet = new Set<string>();
  const popupDomains = new Set<string>();
  const blockedDomains = new Set<string>();
  const individual: Omit<DnrRule, "id">[] = [];
  /** Plain `||domain^` rules sharing the same options become one rule with a requestDomains list. */
  const groups = new Map<string, { base: Omit<DnrRule, "id">; domains: Set<string> }>();

  // uBO preprocessor blocks (!#if env_…) target specific browsers; skip them rather than guess.
  let conditional = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("!#if")) {
      conditional += 1;
      continue;
    }
    if (line.startsWith("!#endif")) {
      conditional = Math.max(0, conditional - 1);
      continue;
    }
    if (conditional) {
      if (line && !line.startsWith("!")) bump(stats, "platform-specific (!#if) block");
      continue;
    }
    if (!line || line.startsWith("!") || line.startsWith("[")) continue;
    stats.lines += 1;

    // ---- Cosmetic (element hiding) ----
    const cosmeticMatch = line.match(/^([^#]*)(#@?#|#\?#|#\$#|#%#|#@\?#|#@\$#)(.+)$/);
    if (cosmeticMatch && !line.startsWith("|") && !line.startsWith("/")) {
      const [, domainsPart, separator, selector] = cosmeticMatch;
      if (separator !== "##" && separator !== "#@#") {
        bump(stats, "procedural cosmetic filter");
        continue;
      }
      const scriptlet = selector.match(/^\+js\((.*)\)$/);
      if (scriptlet) {
        const [name, ...args] = scriptletArgs(scriptlet[1]);
        const known = SCRIPTLETS[name.replace(/\.js$/, "")];
        const sites = domainsPart ? domainList(domainsPart.replace(/,/g, "|"), true) : undefined;
        if (separator !== "##" || !known || !sites?.valid || !sites.include.length) {
          bump(stats, known ? "scriptlet (generic or exception)" : "scriptlet not implemented");
          continue;
        }
        for (const site of sites.include) (scriptlets[site] ??= []).push([known, ...args]);
        stats.scriptlets += 1;
        continue;
      }
      if (/^\^/.test(selector)) {
        bump(stats, "HTML filter (not possible in MV3)");
        continue;
      }
      if (EXTENDED_SELECTOR.test(selector)) {
        bump(stats, "extended selector syntax");
        continue;
      }
      const domains = domainsPart ? domainList(domainsPart.replace(/,/g, "|"), true) : { include: [], exclude: [], valid: true };
      if (!domains.valid) {
        bump(stats, "unsupported cosmetic domain");
        continue;
      }
      if (separator === "#@#") {
        for (const domain of domains.include) (cosmetic.exceptions[domain] ??= []).push(selector);
        if (!domains.include.length) bump(stats, "generic cosmetic exception");
        continue;
      }
      if (!domains.include.length) {
        if (!genericSet.has(selector)) {
          genericSet.add(selector);
          cosmetic.generic.push(selector);
          stats.cosmeticGeneric += 1;
        }
        for (const domain of domains.exclude) (cosmetic.exceptions[domain] ??= []).push(selector);
      } else {
        for (const domain of domains.include) (cosmetic.specific[domain] ??= []).push(selector);
        stats.cosmeticSpecific += 1;
      }
      continue;
    }

    // ---- Network ----
    let pattern = line;
    let allow = false;
    if (pattern.startsWith("@@")) {
      allow = true;
      pattern = pattern.slice(2);
    }
    if (/^\/.*\/(?:\$.*)?$/.test(pattern) && !pattern.startsWith("//")) {
      bump(stats, "regular-expression filter");
      continue;
    }
    let optionText = "";
    const dollar = pattern.lastIndexOf("$");
    if (dollar > 0 && /^[\w~,=.|*\-:]+$/.test(pattern.slice(dollar + 1))) {
      optionText = pattern.slice(dollar + 1);
      pattern = pattern.slice(0, dollar);
    }

    const condition: DnrCondition = {};
    const types: string[] = [];
    const excludedTypes: string[] = [];
    let important = false;
    let popupOnly = false;
    let documentRule = false;
    let unsupported = "";
    let hideException = false;
    let allTypes = false;
    for (const option of optionText ? optionText.split(",") : []) {
      const [nameRaw, value] = option.split("=");
      const name = nameRaw.toLowerCase();
      const negated = name.startsWith("~");
      const bare = negated ? name.slice(1) : name;
      if (bare === "third-party" || bare === "3p") condition.domainType = negated ? "firstParty" : "thirdParty";
      else if (bare === "first-party" || bare === "1p") condition.domainType = negated ? "thirdParty" : "firstParty";
      else if (bare === "domain" || bare === "from") {
        const domains = domainList(value ?? "");
        if (!domains.valid) unsupported = "unsupported $domain value";
        if (domains.include.length) condition.initiatorDomains = domains.include;
        if (domains.exclude.length) condition.excludedInitiatorDomains = domains.exclude;
      } else if (bare === "match-case") condition.isUrlFilterCaseSensitive = true;
      else if (bare === "important") important = true;
      else if (bare === "popup" || bare === "popunder") popupOnly = true;
      else if (bare === "all") {
        // uBO $all: every request type including the page itself, plus popups.
        types.push("main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "media", "websocket", "other");
        allTypes = true;
      }
      else if (bare === "document" || bare === "doc") documentRule = !negated;
      else if (bare === "elemhide" || bare === "generichide" || bare === "ehide" || bare === "ghide") hideException = true;
      else if (TYPE_MAP[bare]) (negated ? excludedTypes : types).push(TYPE_MAP[bare]);
      else if (UNSUPPORTED_OPTIONS.test(bare)) unsupported = `$${bare} option`;
      else unsupported = `unknown option $${bare}`;
    }

    const plainDomain = pattern.match(/^\|\|([a-z0-9.-]+)\^?$/i)?.[1]?.toLowerCase();
    if (allTypes && !allow && plainDomain && HOST.test(plainDomain)) popupDomains.add(plainDomain);

    if (hideException) {
      // @@||site^$generichide / $elemhide: turn generic cosmetic hiding off on that site.
      if (allow && plainDomain && HOST.test(plainDomain)) cosmetic.genericHide.push(plainDomain);
      else bump(stats, "cosmetic exception option");
      continue;
    }
    if (popupOnly && !types.length && !documentRule) {
      if (!allow && plainDomain && HOST.test(plainDomain)) popupDomains.add(plainDomain);
      else bump(stats, "$popup rule (popups are not a request type)");
      continue;
    }
    if (unsupported) {
      bump(stats, unsupported);
      continue;
    }
    if (!pattern || pattern === "*" || pattern === "||" || pattern.length < 4 || !isAsciiPattern(pattern) || pattern.startsWith("||*") || pattern.slice(2).includes("||")) {
      bump(stats, "pattern too broad or not ASCII");
      continue;
    }

    if (documentRule) types.push("main_frame");
    if (types.length) condition.resourceTypes = [...new Set(types)];
    if (excludedTypes.length && !types.length) condition.excludedResourceTypes = [...new Set(excludedTypes)];
    const action: DnrRule["action"] = { type: allow ? (documentRule ? "allowAllRequests" : "allow") : "block" };
    if (action.type === "allowAllRequests") condition.resourceTypes = ["main_frame", "sub_frame"];
    const priority = allow ? (important ? 4 : 2) : important ? 3 : 1;

    if (plainDomain && HOST.test(plainDomain) && action.type !== "allowAllRequests" && !condition.isUrlFilterCaseSensitive) {
      const key = JSON.stringify({ action, priority, condition });
      const group = groups.get(key) ?? { base: { priority, action, condition }, domains: new Set<string>() };
      group.domains.add(plainDomain);
      groups.set(key, group);
      if (!allow && !condition.resourceTypes && !condition.initiatorDomains) blockedDomains.add(plainDomain);
      continue;
    }
    individual.push({ priority, action, condition: { ...condition, urlFilter: pattern, isUrlFilterCaseSensitive: Boolean(condition.isUrlFilterCaseSensitive) } });
  }

  let id = options.startId ?? 1;
  const rules: DnrRule[] = [];
  for (const group of groups.values()) {
    const domains = [...group.domains].sort();
    for (let index = 0; index < domains.length; index += 1000) {
      const chunk = domains.slice(index, index + 1000);
      rules.push({ id: id++, priority: group.base.priority, action: group.base.action, condition: { ...group.base.condition, requestDomains: chunk } });
      stats.groupedDomains += chunk.length;
    }
  }
  for (const rule of individual) rules.push({ id: id++, ...rule });
  const limited = options.maxRules ? rules.slice(0, options.maxRules) : rules;
  if (options.maxRules && rules.length > options.maxRules) stats.skipped["over rule limit"] = rules.length - options.maxRules;
  stats.networkRules = limited.length;
  return { rules: limited, cosmetic, popupDomains: [...popupDomains].sort(), blockedDomains: [...blockedDomains].sort(), scriptlets, stats };
}

/**
 * Element-hiding CSS. Selectors are grouped inside :is(), whose selector list is forgiving: one
 * selector the browser can't parse is ignored instead of invalidating its whole group.
 */
export function hidingCss(selectors: string[], groupSize = 300): string {
  const rules: string[] = [];
  for (let index = 0; index < selectors.length; index += groupSize) {
    rules.push(`:is(${selectors.slice(index, index + groupSize).join(",")}){display:none!important}`);
  }
  return rules.join("\n");
}

export function mergeCosmetic(target: CosmeticData, source: CosmeticData): CosmeticData {
  const generic = new Set(target.generic);
  for (const selector of source.generic) generic.add(selector);
  const merge = (a: Record<string, string[]>, b: Record<string, string[]>) => {
    const out: Record<string, string[]> = { ...a };
    for (const [key, list] of Object.entries(b)) out[key] = [...new Set([...(out[key] ?? []), ...list])];
    return out;
  };
  return {
    generic: [...generic],
    specific: merge(target.specific, source.specific),
    exceptions: merge(target.exceptions, source.exceptions),
    genericHide: [...new Set([...target.genericHide, ...source.genericHide])]
  };
}

/** Index generic selectors by the class or id they require, so a page only checks selectors it could match. */
export function selectorToken(selector: string): string | undefined {
  // A class/id inside :not() is not required for a match, so it cannot be used as the key.
  const required = selector.replace(/:not\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "");
  const match = required.match(/([.#])([\w-]+)/);
  return match ? `${match[1]}${match[2]}` : undefined;
}
