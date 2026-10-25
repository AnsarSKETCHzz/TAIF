import { timerRestarted } from "./shared/detectors";
import { buildTabView, eventFromDraft, findingToEvent, isProblem, upsertEvent, validateDraft, DISMISS_TTL_MS } from "./shared/events";
import { chooseReturn, emptyTracker, findTabUnder, processNav, type NavInput, type TrackerState } from "./shared/redirect";
import type { Finding, ScanRecord, StoredClaim, StoredTimer, TaifEvent, TimerObservation } from "./shared/types";
import { isSupportedUrl, pageKey, siteOf } from "./shared/url";
import {
  adFrameHosts,
  adblockSettings,
  applyNetworkSettings,
  blockedOnTab,
  cosmeticNavigated,
  cosmeticSelectorGroups,
  injectCosmetic,
  removeCosmetic,
  isKnownPopupDomain,
  isPaused,
  loadAdblockSettings,
  loadPopupDomains,
  networkStatus,
  resetFilterUpdate,
  updateFilterLists
} from "./adblock";

/* ---------------- Ad blocking: start-up, settings and live counts ---------------- */

void loadAdblockSettings().then(() => applyNetworkSettings()).catch((error: unknown) => console.warn("TAIF could not apply filter settings", error));
void loadPopupDomains();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.taif_adblock) return;
  void loadAdblockSettings().then(() => applyNetworkSettings()).then(() => {
    // Open pages switch cosmetic filtering on/off right away, without a reload.
    void chrome.tabs.query({}).then((tabs) => tabs.forEach((tab) => {
      if (tab.id === undefined || !isSupportedUrl(tab.url)) return;
      const host = new URL(tab.url!).hostname;
      if (adblockSettings().cosmetic && !isPaused(host)) void injectCosmetic(tab.id, tab.url);
      else void removeCosmetic(tab.id);
    }));
  });
});

/* ---------------- Session state (chrome.storage.session: in memory, cleared when the browser closes) ---------------- */

interface SessionState {
  nav: TrackerState;
  events: Record<string, TaifEvent[]>;
  /** dismiss_key → time; "Got it" and "Dismiss" both land here so a rescan cannot resurrect a card. */
  dismissed: Record<string, number>;
  scans: Record<string, ScanRecord>;
}

const HOSTS = ["http://*/*", "https://*/*"];
const MAX_EVENTS_PER_TAB = 60;
const BANNER_DELAY_MS = 1500;
const AUTO_SCAN_GAP_MS = 10_000;
let chain: Promise<unknown> = Promise.resolve();
let persisting: Promise<unknown> = Promise.resolve();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Busy pages produce many events per second; one storage write per 300 ms carries all of them
 * instead of one write per event, which keeps the extension responsive.
 */
function scheduleSave(state: SessionState) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    const snapshot = structuredClone({ taif_nav: state.nav, taif_events: state.events, taif_dismissed: state.dismissed, taif_scans: state.scans });
    persisting = persisting.then(() => chrome.storage.session.set(snapshot)).catch((error: unknown) => console.warn("TAIF could not save session state", error));
  }, 300);
}
/** In-memory copy for the worker's lifetime; storage is only read when the worker (re)starts. */
let cache: Promise<SessionState> | undefined;

async function loadState(): Promise<SessionState> {
  const raw = await chrome.storage.session.get(["taif_nav", "taif_events", "taif_dismissed", "taif_scans"]);
  return {
    nav: isObject(raw.taif_nav) && isObject(raw.taif_nav.tabs) ? raw.taif_nav as unknown as TrackerState : emptyTracker(),
    events: isObject(raw.taif_events) ? raw.taif_events as Record<string, TaifEvent[]> : {},
    dismissed: isObject(raw.taif_dismissed) ? raw.taif_dismissed as Record<string, number> : {},
    scans: isObject(raw.taif_scans) ? raw.taif_scans as Record<string, ScanRecord> : {}
  };
}

/**
 * Service-worker events interleave; every read-modify-write of session state goes through this
 * queue. Work runs against the in-memory copy so navigation handling never waits on storage;
 * writes are queued in order so a worker restart resumes from the latest state. The popup reads
 * the persisted copy directly, so it never waits on this worker.
 */
function withState<T>(work: (state: SessionState) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    cache ??= loadState().catch((error: unknown) => {
      cache = undefined;
      throw error;
    });
    const state = await cache;
    const result = await work(state);
    const now = Date.now();
    for (const [key, at] of Object.entries(state.dismissed)) if (now - at > DISMISS_TTL_MS) delete state.dismissed[key];
    scheduleSave(state);
    return result;
  });
  chain = run.catch(() => undefined);
  return run;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addEvent(state: SessionState, event: TaifEvent): { event: TaifEvent; isNew: boolean } {
  const key = String(event.tab_id);
  const result = upsertEvent(state.events[key] ?? [], event, state.dismissed, Date.now());
  state.events[key] = result.events.slice(-MAX_EVENTS_PER_TAB);
  return { event: result.events.find((item) => item.event_id === event.event_id)!, isNew: result.isNew };
}

function currentPage(state: SessionState, tabId: number): string {
  const page = state.nav.tabs[String(tabId)]?.page;
  return page ? page.display : "unsupported";
}

/** Fire-and-forget: browser UI calls can be slow during navigation and must not stall the state queue. */
function updateBadge(state: SessionState, tabId: number) {
  const page = currentPage(state, tabId);
  const problems = (state.events[String(tabId)] ?? []).filter((event) => event.page_key === page && isProblem(event));
  const ignore = () => undefined; // Tab closed before the badge update.
  chrome.action.setBadgeText({ tabId, text: problems.length ? String(problems.length) : "" }).catch(ignore);
  if (problems.length) {
    const urgent = problems.some((event) => event.severity === "high" || event.severity === "critical" || event.scenario_id === "A");
    chrome.action.setBadgeBackgroundColor({ tabId, color: urgent ? "#b3261e" : "#b26a00" }).catch(ignore);
  }
}

function wantsBanner(event: TaifEvent): boolean {
  return isProblem(event) && (event.scenario_id === "A" ? event.severity !== "low" : event.scenario_id === "C" && event.severity === "high");
}

/**
 * Shows the in-page alert after a short delay and only if the event still deserves it, so a
 * navigation reclassified by a late click signal never flashes a false alarm.
 */
function pushBanner(event: TaifEvent) {
  if (!wantsBanner(event)) return;
  setTimeout(() => {
    void withState((state) => (state.events[String(event.tab_id)] ?? []).find((item) => item.event_id === event.event_id))
      .then((latest) => {
        // If the page is still loading, its monitor asks for this alert itself (TAIF_MONITOR_READY).
        if (latest && wantsBanner(latest)) {
          chrome.tabs.sendMessage(latest.tab_id, { type: "TAIF_SHOW_ALERT", event: publicEvent(latest) }).catch(() => undefined);
        }
      });
  }, BANNER_DELAY_MS);
}

/** Strips the memory-only return URL before an event leaves the service worker. */
function publicEvent(event: TaifEvent): TaifEvent {
  const { return_url, ...rest } = event;
  return { ...rest, return_url: return_url ? "available" : undefined };
}

/* ---------------- Popup protection (our own; no third-party blocker is controlled) ---------------- */

interface ProtectionSettings { closeAdTabs: boolean; hideOverlays: boolean }
interface ProtectionEntry {
  id: string;
  at: number;
  kind: "ad-tab" | "overlay" | "network" | "cosmetic" | "popup" | "redirect-blocked";
  /** Requests blocked (network) or elements suppressed (cosmetic), as verified. */
  count?: number;
  host: string;
  /** Memory-only (session storage), used solely for "Reopen". */
  url?: string;
  openerTabId?: number;
  reopened?: boolean;
}

// Auto-closing ad tabs is an opt-in add-on: by default the redirect alert is shown instead.
const DEFAULT_PROTECTION: ProtectionSettings = { closeAdTabs: false, hideOverlays: false };
let protection: ProtectionSettings = DEFAULT_PROTECTION;
void chrome.storage.local.get("taif_protection").then(({ taif_protection: saved }) => {
  protection = { ...DEFAULT_PROTECTION, ...(isObject(saved) ? saved : {}) };
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.taif_protection) protection = { ...DEFAULT_PROTECTION, ...(isObject(changes.taif_protection.newValue) ? changes.taif_protection.newValue : {}) };
});

let logChain: Promise<unknown> = Promise.resolve();
function updateProtectionLog(change: (log: ProtectionEntry[]) => ProtectionEntry[]): Promise<ProtectionEntry[]> {
  const run = logChain.then(async () => {
    const { taif_protection_log: raw } = await chrome.storage.session.get("taif_protection_log");
    const next = change(Array.isArray(raw) ? raw as ProtectionEntry[] : []).slice(-50);
    await chrome.storage.session.set({ taif_protection_log: next });
    return next;
  });
  logChain = run.catch(() => undefined);
  return run;
}

/**
 * Only tabs TAIF is confident an ad opened: a new tab after a click on a non-link or with no click
 * at all, or any new tab (not a link the user chose) that lands on an EasyList ad-popup domain.
 */
function adTabToClose(event: TaifEvent): boolean {
  if (!protection.closeAdTabs || adblockSettings().paused || event.scenario_id !== "A" || !event.chain?.opened_new_tab || event.acknowledged) return false;
  const confident = (event.event_type === "ad_new_tab" || event.event_type === "popup_without_click") && event.confidence >= 0.65;
  const knownPopup = event.event_type !== "user_external_link" && event.chain.hops.some((hop) => isKnownPopupDomain(hop.host));
  return confident || knownPopup;
}

/**
 * Closes an unwanted ad tab after a short re-check (a late click signal may reclassify it as a
 * link the user chose). The notice is sent only after the browser confirms the tab was closed.
 */
function scheduleAdTabClose(event: TaifEvent, fullUrl: string | undefined) {
  setTimeout(() => {
    void (async () => {
      const latest = await withState((state) => (state.events[String(event.tab_id)] ?? []).find((item) => item.event_id === event.event_id));
      if (!latest || !adTabToClose(latest)) {
        if (latest && wantsBanner(latest)) pushBanner(latest);
        return;
      }
      try {
        await chrome.tabs.remove(event.tab_id);
      } catch {
        return; // Already closed by the user: nothing was blocked, so no notice.
      }
      const host = event.chain?.hops.at(-1)?.host ?? "unknown site";
      const opener = event.chain?.opener_tab_id;
      const entry: ProtectionEntry = { id: `p${Date.now().toString(36)}`, at: Date.now(), kind: "ad-tab", host, url: fullUrl, openerTabId: opener };
      await updateProtectionLog((log) => [...log, entry]);
      if (opener !== undefined) {
        await chrome.tabs.update(opener, { active: true }).catch(() => undefined);
        chrome.tabs.sendMessage(opener, { type: "TAIF_PROTECTED", entry: { id: entry.id, kind: entry.kind, host, source: event.chain?.source_host } }).catch(() => undefined);
      }
    })();
  }, BANNER_DELAY_MS);
}

async function reopen(id: string) {
  const log = await updateProtectionLog((entries) => entries.map((entry) => entry.id === id ? { ...entry, reopened: true } : entry));
  const entry = log.find((item) => item.id === id);
  if (!entry?.url || !isSupportedUrl(entry.url)) throw new Error("The closed tab's address is no longer available.");
  await chrome.tabs.create({ url: entry.url, openerTabId: entry.openerTabId, active: true });
  return { ok: true };
}

/* ---------------- Sites reached by unexpected redirects (remembered across visits) ---------------- */

interface RedirectSite { from: string; count: number; first: number; last: number }
let redirectSites: Record<string, RedirectSite> = {};
void chrome.storage.local.get("taif_redirect_sites").then(({ taif_redirect_sites: saved }) => {
  if (isObject(saved)) redirectSites = saved as Record<string, RedirectSite>;
});

function rememberRedirectSite(event: TaifEvent) {
  const host = event.chain?.hops.at(-1)?.host;
  if (!host || !event.chain) return;
  const site = siteOf(host);
  const now = Date.now();
  const previous = redirectSites[site];
  redirectSites[site] = { from: event.chain.source_host, count: (previous?.count ?? 0) + 1, first: previous?.first ?? now, last: now };
  // Keep the 300 most recent.
  redirectSites = Object.fromEntries(Object.entries(redirectSites).sort((a, b) => b[1].last - a[1].last).slice(0, 300));
  void chrome.storage.local.set({ taif_redirect_sites: redirectSites });
}

/** An alert for opening a site that TAIF saw as the target of an unexpected redirect before. */
function revisitEvent(tabId: number, url: string, timestamp: number): TaifEvent | undefined {
  if (!isSupportedUrl(url)) return;
  const host = new URL(url).hostname;
  const record = redirectSites[siteOf(host)];
  if (!record) return;
  const when = new Date(record.last).toLocaleDateString();
  return {
    event_id: `A-revisit-${tabId}-${Math.round(timestamp)}`,
    scenario_id: "A",
    scenario_name: "Redirect and new-tab tracking",
    event_type: "revisit_redirect_site",
    title: "Site reached by an unexpected redirect before",
    summary: `${host} is a site you were sent to unexpectedly from ${record.from}${record.count > 1 ? ` (${record.count} times, most recently ${when})` : ` on ${when}`}. Be careful with downloads, sign-ins and payments here.`,
    tab_id: tabId,
    timestamp,
    page_key: pageKey(url),
    evidence: [`First unexpected redirect here: ${new Date(record.first).toLocaleString()}`, `Times seen: ${record.count}`, `Came from: ${record.from}`],
    claims: [{ claim: "This site was an unexpected-redirect destination before", status: "observed" }, { claim: "This site is malicious", status: "inconclusive" }],
    severity: "medium",
    confidence: 0.75,
    verification_status: "observed",
    classification: "Previously seen redirect destination",
    alternatives: ["You may have opened it on purpose this time."],
    limitations: "Based on redirects TAIF saw in this browser. It does not prove the site is harmful.",
    recommended_action: "If you didn't mean to open this site, close the tab.",
    acknowledged: false,
    occurrences: 1,
    dismiss_key: `A|revisit|${siteOf(host)}`
  };
}

/* ---------------- Feature A: navigation observation ---------------- */

function handleNav(input: NavInput): Promise<void> {
  return withState(async (state) => {
    const result = processNav(state.nav, input);
    if (input.kind === "tab_removed") {
      delete state.events[String(input.tabId)];
      delete state.scans[String(input.tabId)];
      return;
    }
    if (input.kind === "committed" && input.frameId === 0 && result.outcome !== "duplicate") {
      const page = pageKey(input.url);
      const key = String(input.tabId);
      const kept = (state.events[key] ?? []).filter((event) => event.page_key === page || event.scenario_id === "A");
      state.events[key] = [...kept.filter((event) => event.scenario_id !== "A"), ...kept.filter((event) => event.scenario_id === "A").slice(-5)];
      if (state.scans[key]?.page !== page) delete state.scans[key];
    }
    if (result.event) {
      const { event, isNew } = addEvent(state, result.event);
      if (isNew) {
        if (adTabToClose(event)) scheduleAdTabClose(event, state.nav.tabs[String(event.tab_id)]?.page?.url);
        else pushBanner(event);
        if (wantsBanner(event)) rememberRedirectSite(event);
      }
      updateBadge(state, event.tab_id);
    } else if (input.kind === "committed" && input.frameId === 0 && result.outcome !== "same_site" && result.outcome !== "duplicate") {
      // Arriving at a site that redirected you unexpectedly before (any way: typed, link, bookmark);
      // pages within that site don't repeat the alert.
      const revisit = revisitEvent(input.tabId, input.url, input.timestamp);
      if (revisit) {
        const { event, isNew } = addEvent(state, revisit);
        if (isNew) pushBanner(event);
      }
    }
    if (input.kind === "committed" && input.frameId === 0) updateBadge(state, input.tabId);
  }).catch((error: unknown) => console.warn("TAIF navigation handling failed", error));
}

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void handleNav({ kind: "created_target", tabId: details.tabId, sourceTabId: details.sourceTabId, url: details.url, timestamp: details.timeStamp });
});
// Some ad scripts open tabs without a webNavigation "navigation target"; the opener id still links them.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined && tab.openerTabId !== undefined) {
    void handleNav({ kind: "created_target", tabId: tab.id, sourceTabId: tab.openerTabId, url: tab.pendingUrl ?? tab.url ?? "", timestamp: Date.now() });
  }
});
/** Memory-only: the last page each tab showed and the last navigation it attempted (for the shield page). */
const lastPage = new Map<number, string>();
const lastAttempt = new Map<number, string>();

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (isSupportedUrl(details.url)) lastAttempt.set(details.tabId, details.url);
  void handleNav({ kind: "before_navigate", tabId: details.tabId, url: details.url, timestamp: details.timeStamp, frameId: details.frameId });
});
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId === 0 && isSupportedUrl(details.url)) lastPage.set(details.tabId, details.url);
});

/** What the shield page needs: the blocked destination and where the tab came from. */
async function blockedInfo(tabId: number) {
  const url = lastAttempt.get(tabId);
  const previous = lastPage.get(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const opener = tab?.openerTabId !== undefined && await chrome.tabs.get(tab.openerTabId).then(() => true, () => false) ? tab.openerTabId : undefined;
  const host = url ? new URL(url).hostname : undefined;
  return { url, host, previous, opener };
}

async function blockedAction(tabId: number, action: string) {
  const info = await blockedInfo(tabId);
  if (action === "continue") {
    if (!info.url || !info.host) throw new Error("The blocked address is no longer known; reload the page instead.");
    // Allowed for this browser session only.
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const id = 70000 + existing.length + 1;
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{ id, priority: 100, action: { type: chrome.declarativeNetRequest.RuleActionType.ALLOW }, condition: { requestDomains: [info.host], resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME] } }]
    });
    await chrome.tabs.update(tabId, { url: info.url });
    return { ok: true };
  }
  if (action === "back" && info.previous && (!info.opener || lastPage.has(tabId))) {
    await chrome.tabs.update(tabId, { url: info.previous });
    return { ok: true };
  }
  // A tab an ad opened (or "Close this tab"): return to the tab that opened it and close this one.
  if (info.opener !== undefined) {
    const opener = await chrome.tabs.update(info.opener, { active: true }).catch(() => undefined);
    if (opener?.windowId !== undefined) await chrome.windows.update(opener.windowId, { focused: true }).catch(() => undefined);
  }
  await chrome.tabs.remove(tabId);
  return { ok: true };
}
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  // Ad-hiding stylesheets go in first, outside the state queue, so they apply before the page paints.
  cosmeticNavigated(details.tabId);
  void injectCosmetic(details.tabId, details.url);
  void handleNav({
    kind: "committed", tabId: details.tabId, url: details.url, timestamp: details.timeStamp, frameId: details.frameId,
    transitionType: details.transitionType, qualifiers: details.transitionQualifiers
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  cosmeticNavigated(tabId);
  void handleNav({ kind: "tab_removed", tabId, timestamp: Date.now() });
});

/* ---------------- Live monitor registration (optional host permission) ---------------- */

async function syncMonitor(): Promise<boolean> {
  const granted = await chrome.permissions.contains({ origins: HOSTS });
  const registered = (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.id).filter((id) => id.startsWith("taif-"));
  // The id carries a version so an older registration (e.g. top frame only) is replaced.
  const complete = registered.length === 4 && ["taif-monitor", "taif-guard-v2", "taif-scriptlets-v1", "taif-terms-v1"].every((id) => registered.includes(id));
  if (granted && complete) return true;
  // Re-register from a clean slate so a partial or stale registration can't cause duplicate-id errors.
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered });
  if (granted) {
    // Ad hiding needs no content script: the worker injects native stylesheets on each navigation.
    await chrome.scripting.registerContentScripts([
      // Popup guard + scriptlets: every frame, including script-made about:blank frames, before page scripts.
      { id: "taif-guard-v2", js: ["monitor-main.js"], matches: HOSTS, runAt: "document_start", world: "MAIN", allFrames: true, matchOriginAsFallback: true },
      // Site-specific scriptlets (top frame): the site list is large, so frames don't each load it.
      { id: "taif-scriptlets-v1", js: ["scriptlets.js"], matches: HOSTS, runAt: "document_start", world: "MAIN", allFrames: false },
      { id: "taif-monitor", js: ["monitor.js"], matches: HOSTS, runAt: "document_idle", allFrames: false },
      // Add-on: highlights "Terms and Conditions" phrases (separate script; on/off via taif_terms_highlight).
      { id: "taif-terms-v1", js: ["terms.js"], matches: HOSTS, runAt: "document_idle", allFrames: false }
    ]);
  }
  return granted;
}

chrome.permissions.onAdded.addListener(() => void syncMonitor());
chrome.permissions.onRemoved.addListener(() => void syncMonitor());
chrome.runtime.onInstalled.addListener(() => void syncMonitor());
chrome.runtime.onStartup.addListener(() => void syncMonitor());

/* ---------------- Messages ---------------- */

type Message = { type?: string; [key: string]: unknown };
const lastAutoScan = new Map<number, { page: string; at: number }>();

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message.type !== "string") return;
  const fromExtensionPage = Boolean(sender.url?.startsWith(chrome.runtime.getURL("")));
  const tabId = sender.tab?.id;
  const reply = (work: Promise<unknown>) => {
    work.then(sendResponse, (error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "TAIF could not complete the request." }));
    return true;
  };

  if (!fromExtensionPage && tabId !== undefined) {
    const now = Date.now();
    const page = pageKey(sender.tab?.url ?? sender.url);
    switch (message.type) {
      case "TAIF_MONITOR_READY":
        return reply(withState((state) => {
          processNav(state.nav, { kind: "monitor_ready", tabId, timestamp: now });
          const pending = (state.events[String(tabId)] ?? []).filter((event) =>
            event.scenario_id === "A" && event.page_key === page && now - event.timestamp < 60000 && wantsBanner(event));
          return { event: pending.length ? publicEvent(pending[pending.length - 1]) : undefined };
        }));
      case "TAIF_GESTURE": {
        const timestamp = typeof message.timestamp === "number" && Math.abs(message.timestamp - now) < 10_000 ? message.timestamp : now;
        return reply(handleNav({
          kind: "gesture", tabId, timestamp,
          target: typeof message.target === "string" ? message.target : "unknown",
          href: typeof message.href === "string" ? message.href : undefined,
          suspicious: message.suspicious === true
        }).then(() => ({ ok: true })));
      }
      case "TAIF_LIVE_EVENT": {
        const { draft, error } = validateDraft(message.draft);
        if (!draft) return reply(Promise.resolve({ error }));
        return reply(withState(async (state) => {
          const added = addEvent(state, eventFromDraft(draft, tabId, page, now));
          if (added.isNew) pushBanner(added.event);
          updateBadge(state, tabId);
          return { ok: true };
        }));
      }
      case "TAIF_PAGE_CHANGED":
        // Page changes no longer trigger re-checks (busy ad pages change constantly); "Check again" does.
        return reply(Promise.resolve({ skipped: true }));
      case "TAIF_PAGE_READY": {
        // Automatic checks while browsing: once per page load.
        const last = lastAutoScan.get(tabId);
        if (last && last.page === page && now - last.at < AUTO_SCAN_GAP_MS) return reply(Promise.resolve({ skipped: true }));
        lastAutoScan.set(tabId, { page, at: now });
        return reply(runScan(tabId, false).then(() => ({ ok: true }), () => ({ ok: false })));
      }
      case "TAIF_ACTION":
        return reply(applyAction(String(message.action), String(message.eventId), tabId));
      case "TAIF_REOPEN":
        return reply(reopen(String(message.id)));
      case "TAIF_PROTECTION_LOG": {
        // The monitor reports a cosmetic overlay it actually hid.
        const host = sender.tab?.url ? new URL(sender.tab.url).hostname : "this page";
        // The monitor reports overlays it hid and popups the guard blocked.
        const kind = message.kind === "popup" ? "popup" : "overlay";
        const blockedSite = typeof message.site === "string" ? message.site.slice(0, 120) : host;
        return reply(updateProtectionLog((log) => [...log, { id: `p${Date.now().toString(36)}`, at: Date.now(), kind, host: kind === "popup" ? `${blockedSite} (from ${host})` : host }]).then(() => ({ ok: true })));
      }
      case "TAIF_OPEN_POPUP":
        return reply(chrome.action.openPopup().then(() => ({ ok: true }), () => ({ ok: false })));
      case "TAIF_COSMETIC_SELECTORS": {
        const host = sender.tab?.url && isSupportedUrl(sender.tab.url) ? new URL(sender.tab.url).hostname : "";
        if (!host) return reply(Promise.resolve({ enabled: false, groups: [] }));
        return reply(cosmeticSelectorGroups(host).then((result) => ({ ...result, notify: adblockSettings().notify })));
      }
      case "TAIF_COSMETIC_APPLY":
        return reply(injectCosmetic(tabId, sender.tab?.url).then((applied) => ({ applied })));
      case "TAIF_COSMETIC_REMOVE":
        return reply(removeCosmetic(tabId, true).then(() => ({ ok: true })));
      case "TAIF_AD_FRAMES": {
        const hosts = Array.isArray(message.hosts) ? message.hosts.filter((host): host is string => typeof host === "string").slice(0, 200) : [];
        return reply(adFrameHosts(hosts).then((ads) => ({ ads })));
      }
      case "TAIF_COSMETIC_RESULT": {
        // Logged only with counts the page script verified (elements actually hidden).
        const count = Number(message.count);
        if (!Number.isFinite(count) || count < 1) return reply(Promise.resolve({ ok: false }));
        const host = sender.tab?.url && isSupportedUrl(sender.tab.url) ? new URL(sender.tab.url).hostname : "this page";
        return reply(updateProtectionLog((log) => [...log, { id: `c${Date.now().toString(36)}`, at: Date.now(), kind: "cosmetic", host, count }]).then(() => ({ ok: true })));
      }
    }
    return;
  }

  if (!fromExtensionPage) return;
  const targetTab = typeof message.tabId === "number" ? message.tabId : undefined;
  switch (message.type) {
    case "TAIF_GET_STATE":
      if (targetTab === undefined) return;
      return reply(getState(targetTab, typeof message.url === "string" ? message.url : undefined));
    case "TAIF_ACTION":
      if (targetTab === undefined) return;
      return reply(applyAction(String(message.action), String(message.eventId), targetTab));
    case "TAIF_SYNC_MONITOR":
      return reply(syncMonitor().then((enabled) => ({ enabled })));
    case "TAIF_REOPEN":
      return reply(reopen(String(message.id)));
    case "TAIF_ADBLOCK_APPLY":
      // Real operation behind the "Applying network-filtering rules" stage.
      return reply(loadAdblockSettings().then(() => applyNetworkSettings()).then(() => networkStatus()));
    case "TAIF_ADBLOCK_STATUS":
      return reply(Promise.all([networkStatus(), targetTab === undefined ? undefined : blockedOnTab(targetTab)]).then(([network, blocked]) => ({ network, blocked })));
    case "TAIF_FILTER_UPDATE":
      return reply(updateFilterLists());
    case "TAIF_FILTER_RESET":
      return reply(resetFilterUpdate().then(() => ({ ok: true })));
    case "TAIF_SITE_LISTED": {
      // Is this site on the ad / ad-popup lists TAIF ships with? (used by the Trust verdict)
      const host = typeof message.host === "string" ? message.host.toLowerCase() : "";
      if (!host) return reply(Promise.resolve({ listed: false }));
      return reply(adFrameHosts([host]).then((ads) => ({ listed: ads.length > 0 || isKnownPopupDomain(host) })));
    }
    case "TAIF_BLOCKED_INFO": {
      // From the shield page itself (an extension page shown in the tab).
      if (sender.tab?.id === undefined) return;
      const shieldTab = sender.tab.id;
      return reply(blockedInfo(shieldTab).then(async (info) => {
        if (info.host) await updateProtectionLog((log) => log.some((entry) => entry.kind === "redirect-blocked" && entry.url === info.url && Date.now() - entry.at < 10_000)
          ? log
          : [...log, { id: `r${Date.now().toString(36)}`, at: Date.now(), kind: "redirect-blocked", host: info.host!, url: info.url }]);
        return {
          host: info.host,
          url: info.url ? `${new URL(info.url).origin}${new URL(info.url).pathname}` : undefined,
          from: info.previous ? new URL(info.previous).hostname : undefined,
          openedBy: info.opener
        };
      }));
    }
    case "TAIF_BLOCKED_ACTION":
      if (sender.tab?.id === undefined) return;
      return reply(blockedAction(sender.tab.id, String(message.action)));
    case "TAIF_SCAN":
      return reply(runScan(targetTab, true));
  }
  return;
});

async function getState(tabId: number, url: string | undefined) {
  const monitor = await chrome.permissions.contains({ origins: HOSTS });
  return withState((state) => {
    const view = buildTabView(state.events[String(tabId)] ?? [], state.scans[String(tabId)], url, monitor, Date.now(), pageKey(url));
    return { ...view, problems: view.problems.map(publicEvent), details: view.details.map(publicEvent), monitor };
  });
}

async function applyAction(action: string, eventId: string, tabId: number) {
  const { target, tabUnder, knownUrls } = await withState(async (state) => {
    const events = state.events[String(tabId)] ?? [];
    const event = events.find((item) => item.event_id === eventId);
    if (!event) throw new Error("This alert is no longer available.");
    event.acknowledged = true;
    // Page findings are remembered by key so a rescan doesn't bring them back. Redirect alerts are
    // only silenced by an explicit "Dismiss": Back/Stay must not hide the next redirect.
    if (event.scenario_id !== "A" || action === "dismiss") state.dismissed[event.dismiss_key] = Date.now();
    updateBadge(state, tabId);
    // Page URLs the tracker saw, so other tabs on the source site are found even without host access.
    const urls = Object.fromEntries(Object.entries(state.nav.tabs).map(([id, tab]) => [id, tab.page?.url]));
    return { target: event, tabUnder: findTabUnder(state.nav, tabId, event.timestamp), knownUrls: urls };
  });
  if (action !== "return") return { ok: true };

  const [current, all] = await Promise.all([chrome.tabs.get(tabId), chrome.tabs.query({})]);
  const plan = chooseReturn({
    tabId,
    chain: target.chain,
    tabs: all.flatMap((tab) => tab.id === undefined ? [] : [{ id: tab.id, url: tab.url ?? knownUrls[String(tab.id)], lastAccessed: tab.lastAccessed }]),
    browserOpenerTabId: current.openerTabId,
    tabUnderTabId: tabUnder,
    returnUrl: target.return_url
  });
  if (plan.kind === "switch") {
    const previous = await chrome.tabs.update(plan.tabId, { active: true });
    if (previous?.windowId !== undefined) await chrome.windows.update(previous.windowId, { focused: true });
    // Chrome refuses tab edits for a moment while the user drags a tab; retry once.
    await chrome.tabs.remove(plan.closeTabId).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await chrome.tabs.remove(plan.closeTabId);
    });
    return { ok: true, note: "Back on the tab you were browsing. The ad tab was closed." };
  }
  if (plan.kind === "navigate") {
    await chrome.tabs.update(tabId, { url: plan.url });
    return { ok: true };
  }
  throw new Error("The previous page is not known, so TAIF cannot return to it. Use the browser Back button.");
}

/* ---------------- Page checks (original eleven scenarios) ---------------- */

interface PageHistory { timers: StoredTimer[]; claims: StoredClaim[]; at: number }
const MAX_HISTORY_PAGES = 50;

async function readHistory(): Promise<Record<string, PageHistory>> {
  const { taif_history: raw } = await chrome.storage.local.get("taif_history");
  if (!isObject(raw)) return {};
  const safe: Record<string, PageHistory> = {};
  for (const [page, value] of Object.entries(raw)) {
    if (!isObject(value)) continue;
    const timers = Array.isArray(value.timers) ? (value.timers as StoredTimer[]).filter((timer) =>
      typeof timer?.key === "string" && Number.isFinite(timer.seconds) && Number.isFinite(timer.at) && Number.isFinite(timer.restarts)).slice(0, 20) : [];
    const claims = Array.isArray(value.claims) ? (value.claims as StoredClaim[]).filter((claim) =>
      typeof claim?.text === "string" && Number.isFinite(claim.at)).slice(-20) : [];
    safe[page] = { timers, claims, at: Number(value.at) || 0 };
  }
  return safe;
}

/** Remembers countdown values and stock claims per page so later visits can be compared. */
async function updateHistory(page: string, timers: TimerObservation[], claims: { text: string; count?: number }[], now: number) {
  const history = await readHistory();
  const previous = history[page] ?? { timers: [], claims: [], at: now };
  const priorTimers = new Map(previous.timers.map((timer) => [timer.key, timer]));
  const nextTimers = timers.filter((timer) => timer.seconds !== undefined).slice(0, 20).map((timer) => {
    const prior = priorTimers.get(timer.key);
    const restarts = prior ? prior.restarts + (timerRestarted(prior, timer, now) ? 1 : 0) : 0;
    return { key: timer.key.slice(0, 120), seconds: timer.seconds!, at: now, restarts };
  });
  // One claim entry per visit (10 min apart), so "seen on every visit" counts visits, not rescans.
  const lastClaimAt = Math.max(0, ...previous.claims.map((claim) => claim.at));
  const nextClaims = claims.length && now - lastClaimAt > 10 * 60_000
    ? [...previous.claims, ...claims.slice(0, 3).map((claim) => ({ text: claim.text.slice(0, 80), count: claim.count, at: now }))].slice(-20)
    : previous.claims;
  history[page] = { timers: nextTimers.length ? nextTimers : previous.timers, claims: nextClaims, at: now };
  const pages = Object.entries(history).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_HISTORY_PAGES);
  await chrome.storage.local.set({ taif_history: Object.fromEntries(pages) });
}

async function runScan(requestedTab: number | undefined, manual: boolean) {
  const tabId = requestedTab ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  if (tabId === undefined) throw new Error("A page tab is required to start a scan.");
  try {
    const scan = await scanTab(tabId, manual);
    await withState(async (state) => {
      const key = String(tabId);
      const page = pageKey(String(scan.url));
      state.events[key] = (state.events[key] ?? []).filter((event) => event.event_type !== "page_scan_finding");
      for (const finding of scan.findings as Finding[]) addEvent(state, findingToEvent(finding, tabId, page));
      state.scans[key] = { page, status: "done", at: Date.now() };
      updateBadge(state, tabId);
    });
    return { scan };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The scan could not be completed.";
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    await withState((state) => {
      state.scans[String(tabId)] = { page: pageKey(tab?.url), status: "failed", error: message, at: Date.now() };
    });
    throw error;
  }
}

async function scanTab(tabId: number, manual: boolean): Promise<Record<string, unknown>> {
  const tab = await chrome.tabs.get(tabId);
  if (!isSupportedUrl(tab.url)) {
    throw new Error("This browser page cannot be scanned. Open a normal HTTP(S) website.");
  }
  const page = pageKey(tab.url);
  await chrome.scripting.executeScript({ target: { tabId }, files: ["scanner.js"] });
  const [stored, history] = await Promise.all([chrome.storage.local.get("comparisonPage"), readHistory()]);
  const comparisonPage = sanitizeComparisonPage(stored.comparisonPage);
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (context) => {
      const scan = (window as Window & { __TAIF_SCAN__?: (context?: unknown) => unknown }).__TAIF_SCAN__;
      if (!scan) throw new Error("The page scanner did not initialize.");
      return scan(context);
    },
    args: [{ previousTimers: history[page]?.timers, previousClaims: history[page]?.claims, comparisonPage }]
  });
  if (!result || !result.result || typeof result.result !== "object" || Array.isArray(result.result)) {
    throw new Error("The page scanner returned no result. Reload the TAIF extension and try again.");
  }
  const scan = result.result as Record<string, unknown>;
  const observations = scan.observations as { timers?: TimerObservation[]; claims?: { text: string; count?: number }[] } | undefined;
  delete scan.observations;
  const timers = Array.isArray(observations?.timers)
    ? observations.timers.filter((timer) => typeof timer?.key === "string" && (timer.seconds === undefined || Number.isFinite(timer.seconds)))
    : [];
  const claims = Array.isArray(observations?.claims) ? observations.claims.filter((claim) => typeof claim?.text === "string") : [];
  await updateHistory(page, timers, claims, Date.now());

  const url = new URL(String(scan.url ?? ""));
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  scan.url = url.href;
  scan.title = String(scan.title ?? "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number masked]")
    .replace(/\b(?:sk|pk|api|key)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[key-like value masked]");
  scan.scannedAt = new Date().toISOString();
  if (manual) {
    // Only scans you start yourself go to the dashboard history; automatic checks stay in session memory.
    const previous = await chrome.storage.local.get("scans");
    const scans = Array.isArray(previous.scans) ? previous.scans : [];
    scans.unshift(scan);
    await chrome.storage.local.set({ scans: scans.slice(0, 30), latestScan: scan });
  }
  return scan;
}

function sanitizeComparisonPage(value: unknown): { url: string; title: string; text: string; sku?: string; name?: string } | undefined {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || !("url" in value) || !("title" in value) || !("text" in value)) {
    throw new Error("Saved comparison data is invalid. Select the comparison page again.");
  }
  const page = value as { url: unknown; title: unknown; text: unknown; sku?: unknown; name?: unknown };
  if (typeof page.url !== "string" || typeof page.title !== "string" || typeof page.text !== "string") {
    throw new Error("Saved comparison data is invalid. Select the comparison page again.");
  }
  let url: URL;
  try {
    url = new URL(page.url);
  } catch {
    throw new Error("Saved comparison URL is invalid. Select the comparison page again.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Saved comparison page is not an HTTP(S) website. Select it again.");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  const title = page.title.slice(0, 200)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number masked]")
    .replace(/\b(?:sk|pk|api|key)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[key-like value masked]");
  return {
    url: `${url.origin}${url.pathname}`,
    title,
    text: page.text.slice(0, 2000),
    sku: typeof page.sku === "string" ? page.sku.slice(0, 60) : undefined,
    name: typeof page.name === "string" ? page.name.slice(0, 200) : undefined
  };
}
