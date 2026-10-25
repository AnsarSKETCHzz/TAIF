import { convertFilterList, hidingCss, mergeCosmetic, type CosmeticData, type DnrRule } from "./shared/filters";
import { siteOf } from "./shared/url";

/**
 * Ad blocking in the service worker:
 * - network filtering with Chrome's declarativeNetRequest (EasyList / EasyPrivacy static rulesets,
 *   optional dynamic updates, per-site pause rules)
 * - the cosmetic-filter data service for the page script
 * - verified counts of blocked requests (getMatchedRules; live onRuleMatchedDebug when unpacked)
 */

export interface AdblockSettings {
  network: boolean;
  privacy: boolean;
  cosmetic: boolean;
  notify: boolean;
  paused: boolean;
  pausedSites: string[];
}

export const DEFAULT_ADBLOCK: AdblockSettings = { network: true, privacy: false, cosmetic: true, notify: true, paused: false, pausedSites: [] };

interface ListMeta { id: string; title: string; url: string; version: string; rules: number; allowRuleIds: number[]; groupedDomains: number; cosmeticGeneric: number; cosmeticSpecific: number; skipped: Record<string, number> }
interface Meta { builtAt: string; licence: string; lists: ListMeta[] }
interface UpdateRecord { at: string; lists: { id: string; version: string; rules: number }[]; firstId: number; lastId: number }

const PAUSE_ID_START = 1000;
const UPDATE_ID_START = 100000;
const UPDATE_MAX_RULES = 14500;

let settings: AdblockSettings = DEFAULT_ADBLOCK;
let metaCache: Promise<Meta> | undefined;
let cosmeticCache: Promise<CosmeticSource> | undefined;
let adDomainCache: Promise<Set<string>> | undefined;
let popupDomains = new Set<string>();

export async function loadAdblockSettings(): Promise<AdblockSettings> {
  const { taif_adblock: saved } = await chrome.storage.local.get("taif_adblock");
  settings = { ...DEFAULT_ADBLOCK, ...(saved && typeof saved === "object" ? saved : {}) };
  return settings;
}

export function adblockSettings(): AdblockSettings {
  return settings;
}

async function loadJson<T>(path: string): Promise<T> {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export function filterMeta(): Promise<Meta> {
  metaCache ??= loadJson<Meta>("filters/meta.json");
  return metaCache;
}

export async function loadPopupDomains() {
  popupDomains = new Set(await loadJson<string[]>("filters/popup-domains.json").catch(() => []));
}

/** EasyList marks these domains as ad popups; a new tab landing there is an ad tab. */
export function isKnownPopupDomain(host: string | undefined): boolean {
  if (!host) return false;
  const parts = host.toLowerCase().split(".");
  for (let i = 0; i < parts.length - 1; i += 1) if (popupDomains.has(parts.slice(i).join("."))) return true;
  return false;
}

/* ---------------- Network filtering ---------------- */

async function updateRecord(): Promise<UpdateRecord | undefined> {
  const { taif_filter_update: record } = await chrome.storage.local.get("taif_filter_update");
  return record as UpdateRecord | undefined;
}

/** Brings Chrome's enabled rulesets and pause rules in line with the settings. */
export async function applyNetworkSettings(): Promise<void> {
  const update = await updateRecord();
  const active = settings.network && !settings.paused;
  // Downloaded (dynamic) lists replace the bundled static ones they update.
  const updated = new Set(update?.lists.map((list) => list.id) ?? []);
  const want = {
    easylist: active && !updated.has("easylist"),
    ublock: active && !updated.has("ublock"),
    // Ad-navigation shield: pages on known ad/popup domains open TAIF's explanation page instead.
    shield: active,
    easyprivacy: active && settings.privacy && !updated.has("easyprivacy")
  };
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: Object.entries(want).filter(([, on]) => on).map(([id]) => id),
    disableRulesetIds: Object.entries(want).filter(([, on]) => !on).map(([id]) => id)
  });
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
  const pauseIds = dynamic.filter((rule) => rule.id >= PAUSE_ID_START && rule.id < UPDATE_ID_START).map((rule) => rule.id);
  const sites = [...new Set(settings.pausedSites.map((site) => siteOf(site)))].slice(0, 500);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: pauseIds,
    addRules: sites.map((site, index) => ({
      id: PAUSE_ID_START + index,
      priority: 100,
      action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW_ALL_REQUESTS },
      condition: { requestDomains: [site], resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME, chrome.declarativeNetRequest.ResourceType.SUB_FRAME] }
    }))
  });
  // Updated lists live in the dynamic range; they follow the same on/off switches.
  if (update && !active) await setUpdatedRulesActive(false);
  else if (update) await setUpdatedRulesActive(true);
}

async function setUpdatedRulesActive(on: boolean) {
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
  const present = dynamic.some((rule) => rule.id >= UPDATE_ID_START);
  if (on && !present) {
    const { taif_filter_rules: stored } = await chrome.storage.local.get("taif_filter_rules");
    if (Array.isArray(stored)) await chrome.declarativeNetRequest.updateDynamicRules({ addRules: stored as chrome.declarativeNetRequest.Rule[] });
  } else if (!on && present) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynamic.filter((rule) => rule.id >= UPDATE_ID_START).map((rule) => rule.id) });
  }
}

/**
 * Downloads the lists again, converts and validates them, and installs them as dynamic rules.
 * Any failure leaves the current rules untouched.
 */
export async function updateFilterLists(): Promise<{ ok: boolean; message: string }> {
  const meta = await filterMeta();
  const lists = meta.lists.filter((list) => list.id === "easylist" || list.id === "ublock" || (list.id === "easyprivacy" && settings.privacy));
  const rules: DnrRule[] = [];
  const record: UpdateRecord = { at: new Date().toISOString(), lists: [], firstId: UPDATE_ID_START, lastId: UPDATE_ID_START };
  let cosmetic: CosmeticData | undefined;
  for (const list of lists) {
    const response = await fetch(list.url, { cache: "no-store" }).catch(() => undefined);
    if (!response?.ok) return { ok: false, message: `Could not download ${list.title}; the current rules were kept.` };
    const text = await response.text();
    if (!/^\[Adblock Plus/.test(text)) return { ok: false, message: `${list.title} did not look like a filter list; the current rules were kept.` };
    const result = convertFilterList(text, { startId: UPDATE_ID_START + rules.length, maxRules: UPDATE_MAX_RULES });
    if (!result.rules.length || result.rules.some((rule) => !rule.condition.urlFilter && !rule.condition.requestDomains)) {
      return { ok: false, message: `${list.title} produced invalid rules; the current rules were kept.` };
    }
    rules.push(...result.rules);
    if (list.id !== "easyprivacy") cosmetic = cosmetic ? mergeCosmetic(cosmetic, result.cosmetic) : result.cosmetic;
    record.lists.push({ id: list.id, version: text.match(/^! Version: (.+)$/m)?.[1] ?? "unknown", rules: result.rules.length });
  }
  record.lastId = UPDATE_ID_START + rules.length - 1;
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
  const oldIds = dynamic.filter((rule) => rule.id >= UPDATE_ID_START).map((rule) => rule.id);
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds, addRules: rules as chrome.declarativeNetRequest.Rule[] });
  } catch (error) {
    // Chrome validated the rules and refused them; restore the previous dynamic set.
    const { taif_filter_rules: previous } = await chrome.storage.local.get("taif_filter_rules");
    if (Array.isArray(previous)) await chrome.declarativeNetRequest.updateDynamicRules({ addRules: previous as chrome.declarativeNetRequest.Rule[] }).catch(() => undefined);
    return { ok: false, message: `Chrome rejected the updated rules (${error instanceof Error ? error.message : "unknown error"}); the previous rules were kept.` };
  }
  await chrome.storage.local.set({ taif_filter_update: record, taif_filter_rules: rules, ...(cosmetic ? { taif_cosmetic_update: cosmetic } : {}) });
  cosmeticCache = undefined;
  genericGroupsCache = undefined;
  await applyNetworkSettings();
  return { ok: true, message: `Updated: ${record.lists.map((list) => `${list.id} ${list.version} (${list.rules} rules)`).join(", ")}.` };
}

export async function resetFilterUpdate() {
  const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: dynamic.filter((rule) => rule.id >= UPDATE_ID_START).map((rule) => rule.id) });
  await chrome.storage.local.remove(["taif_filter_update", "taif_filter_rules", "taif_cosmetic_update"]);
  cosmeticCache = undefined;
  genericGroupsCache = undefined;
  await applyNetworkSettings();
}

export async function networkStatus() {
  const [meta, enabled, available, dynamic, update] = await Promise.all([
    filterMeta(),
    chrome.declarativeNetRequest.getEnabledRulesets(),
    chrome.declarativeNetRequest.getAvailableStaticRuleCount(),
    chrome.declarativeNetRequest.getDynamicRules(),
    updateRecord()
  ]);
  const updatedRules = dynamic.filter((rule) => rule.id >= UPDATE_ID_START).length;
  const staticRules = meta.lists.filter((list) => enabled.includes(list.id)).reduce((sum, list) => sum + list.rules, 0);
  return {
    enabledRulesets: enabled,
    activeRules: staticRules + updatedRules,
    staticRules,
    updatedRules,
    pausedSiteRules: dynamic.filter((rule) => rule.id >= PAUSE_ID_START && rule.id < UPDATE_ID_START).length,
    availableStaticRuleCount: available,
    lists: meta.lists.map(({ allowRuleIds: _, ...list }) => ({ ...list, enabled: enabled.includes(list.id) || Boolean(update?.lists.some((item) => item.id === list.id) && updatedRules) })),
    builtAt: meta.builtAt,
    licence: meta.licence,
    update
  };
}

/* ---------------- Verified blocked-request counts ---------------- */

/** Requests blocked on a tab, as reported by Chrome (matches from the last 5 minutes). */
export async function blockedOnTab(tabId: number): Promise<{ count?: number; live?: number; source: string }> {
  const live: number | undefined = undefined;
  try {
    const [meta, matches] = await Promise.all([filterMeta(), chrome.declarativeNetRequest.getMatchedRules({ tabId })]);
    const allow = new Map(meta.lists.map((list) => [list.id, new Set(list.allowRuleIds)]));
    const blocked = matches.rulesMatchedInfo.filter(({ rule }) =>
      rule.rulesetId === "_dynamic" ? rule.ruleId >= UPDATE_ID_START : !allow.get(rule.rulesetId)?.has(rule.ruleId));
    return { count: blocked.length, live, source: "Chrome declarativeNetRequest matched rules (last 5 minutes on this tab)" };
  } catch (error) {
    return { live, source: `Chrome did not return matched rules (${error instanceof Error ? error.message : "quota"}).` };
  }
}

/* ---------------- Cosmetic filtering: native CSS injected by the browser ---------------- */

interface CosmeticSource { data: CosmeticData; genericCss?: string }

function cosmeticData(): Promise<CosmeticSource> {
  cosmeticCache ??= (async () => {
    const { taif_cosmetic_update: updated } = await chrome.storage.local.get("taif_cosmetic_update");
    if (updated && typeof updated === "object") {
      const data = updated as CosmeticData;
      // Downloaded lists: generic hiding comes from the update instead of the bundled file.
      return { data, genericCss: hidingCss(data.generic) };
    }
    return { data: await loadJson<CosmeticData>("filters/cosmetic.json") };
  })();
  return cosmeticCache;
}

let genericGroupsCache: Promise<string[]> | undefined;

/** Generic hiding selectors grouped as forgiving :is(...) lists, for counting matches on a page. */
function genericGroups(): Promise<string[]> {
  genericGroupsCache ??= (async () => {
    const { genericCss } = await cosmeticData();
    const css: string = genericCss ?? await fetch(chrome.runtime.getURL("filters/generic.css")).then((response) => response.text());
    return css.split("\n").map((line) => line.replace(/\{display:none!important\}$/, "")).filter(Boolean);
  })();
  return genericGroupsCache;
}

/**
 * Keys a site's rules can be filed under: the host and its parent domains, plus uBlock-style
 * entity forms (moviesite.* for moviesite.xyz), so rules survive a site switching domain endings.
 */
function hostChain(host: string): string[] {
  const clean = host.toLowerCase().replace(/^www\./, "");
  const parts = clean.split(".");
  const chain = parts.map((_, index) => parts.slice(index).join(".")).filter((item) => item.includes("."));
  const site = siteOf(clean);
  const suffix = site.slice(site.indexOf("."));
  const entities = chain.filter((item) => item.endsWith(suffix) && item.length > suffix.length).map((item) => `${item.slice(0, -suffix.length)}.*`);
  return [...chain, ...entities];
}

interface Injected { generic: "file" | "css" | "none"; css: string }
const injected = new Map<number, Injected>();
/** Tabs where the user restored the page; nothing is re-applied until the next navigation. */
const restoredTabs = new Set<number>();
/** Elements the page script decided must stay visible (main content, forms). */
const KEEP_CSS = "[data-taif-keep]{display:revert!important}";

async function siteCss(host: string) {
  const { data, genericCss } = await cosmeticData();
  const chain = hostChain(host);
  const exceptions = [...new Set(chain.flatMap((item) => data.exceptions[item] ?? []))];
  const genericOff = chain.some((item) => data.genericHide.includes(item));
  const specific = [...new Set(chain.flatMap((item) => data.specific[item] ?? []))].filter((selector) => !exceptions.includes(selector));
  // #@# exceptions undo matching generic rules: a later user-origin rule wins at equal specificity.
  const override = exceptions.length ? `:is(${exceptions.join(",")}){display:revert!important}` : "";
  const generic: Injected["generic"] = genericOff ? "none" : genericCss ? "css" : "file";
  return { generic, genericCss, css: [hidingCss(specific), override, KEEP_CSS].filter(Boolean).join("\n") };
}

/** Hides ads with stylesheets Chrome applies natively, including ads added later; no per-element script work. */
export async function injectCosmetic(tabId: number, url: string | undefined): Promise<boolean> {
  if (!url || !/^https?:/.test(url)) return false;
  const host = new URL(url).hostname;
  if (!settings.cosmetic || isPaused(host) || restoredTabs.has(tabId)) return false;
  if (injected.has(tabId)) return true;
  const plan = await siteCss(host);
  const target = { tabId, frameIds: [0] };
  try {
    if (plan.generic === "file") await chrome.scripting.insertCSS({ target, files: ["filters/generic.css"], origin: "USER" });
    else if (plan.generic === "css" && plan.genericCss) await chrome.scripting.insertCSS({ target, css: plan.genericCss, origin: "USER" });
    await chrome.scripting.insertCSS({ target, css: plan.css, origin: "USER" });
    injected.set(tabId, { generic: plan.generic, css: plan.css });
    return true;
  } catch {
    return false; // No access to this page (browser pages, Web Store).
  }
}

export async function removeCosmetic(tabId: number, byUser = false): Promise<void> {
  const state = injected.get(tabId);
  if (byUser) restoredTabs.add(tabId);
  if (!state) return;
  injected.delete(tabId);
  const target = { tabId, frameIds: [0] };
  const { genericCss } = await cosmeticData();
  if (state.generic === "file") await chrome.scripting.removeCSS({ target, files: ["filters/generic.css"], origin: "USER" }).catch(() => undefined);
  else if (state.generic === "css" && genericCss) await chrome.scripting.removeCSS({ target, css: genericCss, origin: "USER" }).catch(() => undefined);
  await chrome.scripting.removeCSS({ target, css: state.css, origin: "USER" }).catch(() => undefined);
}

/** A new document starts without TAIF's stylesheets. */
export function cosmeticNavigated(tabId: number) {
  injected.delete(tabId);
  restoredTabs.delete(tabId);
}

/** Selector groups for counting what the stylesheets hide on a page (used by Clean Page). */
export async function cosmeticSelectorGroups(host: string): Promise<{ enabled: boolean; groups: string[] }> {
  if (!settings.cosmetic || isPaused(host)) return { enabled: false, groups: [] };
  const { data } = await cosmeticData();
  const chain = hostChain(host);
  const exceptions = new Set(chain.flatMap((item) => data.exceptions[item] ?? []));
  const specific = [...new Set(chain.flatMap((item) => data.specific[item] ?? []))].filter((selector) => !exceptions.has(selector));
  const genericOff = chain.some((item) => data.genericHide.includes(item));
  const groups = genericOff ? [] : [...await genericGroups()];
  for (let index = 0; index < specific.length; index += 300) groups.push(`:is(${specific.slice(index, index + 300).join(",")})`);
  return { enabled: true, groups };
}

/** Which of the given frame hosts are known ad servers (EasyList). */
export async function adFrameHosts(hosts: string[]): Promise<string[]> {
  adDomainCache ??= loadJson<string[]>("filters/ad-domains.json").then((list) => new Set(list)).catch(() => new Set<string>());
  const domains = await adDomainCache;
  return hosts.filter((host) => hostChain(host).some((item) => domains.has(item)) || domains.has(host));
}

export function isPaused(host: string): boolean {
  return settings.paused || settings.pausedSites.some((site) => hostChain(host).includes(siteOf(site)));
}
