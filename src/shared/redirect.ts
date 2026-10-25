import type { EventDraft } from "./events";
import type { ChainHop, ClaimStatus, RedirectChain, Severity, TaifEvent } from "./types";
import { scenarioName } from "./events";
import { isSupportedUrl, normalizeUrl, siteOf } from "./url";

/**
 * Feature A: correlates chrome.webNavigation events (plus optional click signals from the live
 * monitor) into redirect chains and classifies them. Pure and serializable so the MV3 service
 * worker can persist it in chrome.storage.session and tests can replay event sequences.
 */

export type NavInput =
  | { kind: "created_target"; tabId: number; sourceTabId: number; url: string; timestamp: number }
  | { kind: "before_navigate"; tabId: number; url: string; timestamp: number; frameId: number }
  | { kind: "committed"; tabId: number; url: string; timestamp: number; frameId: number; transitionType: string; qualifiers: string[] }
  | { kind: "gesture"; tabId: number; timestamp: number; target: string; href?: string; suspicious?: boolean }
  | { kind: "monitor_ready"; tabId: number; timestamp: number }
  | { kind: "tab_removed"; tabId: number; timestamp: number };

/** suspicious: an invisible/overlay link, so the click is not taken as choosing its destination. */
interface Gesture { ts: number; target: string; hrefSite?: string; hrefHost?: string; suspicious?: boolean }
interface PageRef { url: string; host: string; site: string; display: string; ts: number }

interface TabState {
  page?: PageRef;
  /** Whether the live monitor reported in on the current page; without it, clicks are unknown. */
  monitor: boolean;
  gesture?: Gesture;
  pending?: { url: string; ts: number };
  opener?: { tabId: number; page?: PageRef; gesture?: Gesture; monitor: boolean; ts: number };
  /** Which tab opened this one, and when; kept for the tab's lifetime (opener is cleared after commit). */
  createdBy?: { tabId: number; ts: number };
  chain?: { id: string; source: PageRef; startTs: number; hops: ChainHop[]; incomplete: string[]; newTab: boolean; openerTabId?: number; interaction: RedirectChain["user_interaction"]; clientRedirect: boolean; firstSite: string };
  lastCommit?: { key: string; ts: number };
}

export interface TrackerState { tabs: Record<string, TabState> }

export interface NavResult {
  outcome: "ignored" | "duplicate" | "baseline" | "same_site" | "event";
  reason?: string;
  event?: TaifEvent;
}

const GESTURE_WINDOW_MS = 2000;
const CLIENT_REDIRECT_CHAIN_MS = 15000;
/** Transitions the user drove directly (address bar, bookmark, reload…) are never "unexpected". */
const USER_DRIVEN = new Set(["typed", "auto_bookmark", "keyword", "keyword_generated", "generated", "reload", "start_page", "form_submit"]);

export function emptyTracker(): TrackerState {
  return { tabs: {} };
}

export function processNav(state: TrackerState, input: NavInput): NavResult {
  const key = String(input.tabId);
  const tab: TabState = state.tabs[key] ?? (state.tabs[key] = { monitor: false });

  switch (input.kind) {
    case "tab_removed":
      delete state.tabs[key];
      return { outcome: "ignored", reason: "tab closed" };
    case "monitor_ready":
      tab.monitor = true;
      return { outcome: "ignored", reason: "monitor ready" };
    case "gesture": {
      const href = normalizeUrl(input.href);
      const gesture: Gesture = { ts: input.timestamp, target: input.target.slice(0, 80), hrefSite: href?.site, hrefHost: href?.host, suspicious: input.suspicious === true };
      // The click message can reach the worker after the navigation it caused; it then belongs
      // to the previous page and is only used to correct that navigation's classification.
      const late = tab.page !== undefined && input.timestamp < tab.page.ts;
      if (!late) {
        tab.monitor = true;
        tab.gesture = gesture;
      }
      const event = reclassifyWithLateGesture(state, input.tabId, gesture);
      return event ? { outcome: "event", reason: "late click reclassified", event } : { outcome: "ignored", reason: "gesture recorded" };
    }
    case "created_target": {
      if (tab.page) return { outcome: "ignored", reason: "tab already navigated" };
      const source = state.tabs[String(input.sourceTabId)];
      tab.opener = { tabId: input.sourceTabId, page: source?.page, gesture: source?.gesture, monitor: Boolean(source?.monitor), ts: input.timestamp };
      tab.createdBy = { tabId: input.sourceTabId, ts: input.timestamp };
      return { outcome: "ignored", reason: "new tab correlated with opener" };
    }
    case "before_navigate":
      if (input.frameId !== 0) return { outcome: "ignored", reason: "subframe" };
      if (!isSupportedUrl(input.url)) return { outcome: "ignored", reason: "unsupported URL" };
      tab.pending = { url: input.url, ts: input.timestamp };
      return { outcome: "ignored", reason: "navigation started" };
    case "committed":
      return commit(tab, input);
  }
}

function commit(tab: TabState, input: Extract<NavInput, { kind: "committed" }>): NavResult {
  if (input.frameId !== 0) return { outcome: "ignored", reason: "subframe" };
  const dest = normalizeUrl(input.url);
  if (!dest) {
    tab.page = undefined;
    tab.chain = undefined;
    tab.pending = undefined;
    tab.monitor = false;
    return { outcome: "ignored", reason: "restricted or unsupported page" };
  }
  const commitKey = `${input.url}|${input.transitionType}|${input.qualifiers.join(",")}`;
  if (tab.lastCommit && tab.lastCommit.key === commitKey && input.timestamp - tab.lastCommit.ts < 1500) {
    return { outcome: "duplicate", reason: "repeated navigation event" };
  }
  tab.lastCommit = { key: commitKey, ts: input.timestamp };

  const destRef: PageRef = { url: input.url, host: dest.host, site: dest.site, display: dest.display, ts: input.timestamp };
  const qualifiers = new Set(input.qualifiers);
  const clientRedirect = qualifiers.has("client_redirect");
  const serverRedirect = qualifiers.has("server_redirect");
  const previous = tab.page;
  const opener = tab.opener;
  const pending = tab.pending;
  const sourceMonitor = tab.monitor;
  tab.opener = undefined;
  tab.pending = undefined;
  tab.monitor = false;
  tab.page = destRef;

  if (USER_DRIVEN.has(input.transitionType) || qualifiers.has("forward_back") || qualifiers.has("from_address_bar")) {
    tab.chain = undefined;
    tab.gesture = undefined;
    return { outcome: "baseline", reason: `user-driven navigation (${input.transitionType})` };
  }

  const via = clientRedirect ? "client-side redirect" : serverRedirect ? "server redirect" : opener && !previous ? "new tab" : input.transitionType;
  const continuing = clientRedirect && tab.chain && input.timestamp - tab.chain.startTs < CLIENT_REDIRECT_CHAIN_MS;

  if (continuing && tab.chain) {
    appendServerStart(tab.chain, pending, dest.host, serverRedirect);
    tab.chain.hops.push({ host: dest.host, path: dest.path, timestamp: input.timestamp, via });
    tab.chain.clientRedirect = true;
  } else {
    const source = opener && !previous ? opener.page : previous;
    if (!source) {
      tab.chain = undefined;
      return { outcome: "baseline", reason: opener ? "opener page unknown (restricted or not observed)" : "first observed page in tab" };
    }
    const startTs = (opener && !previous ? opener.ts : pending?.ts) ?? input.timestamp;
    const firstUrl = normalizeUrl(pending?.url) ?? dest;
    const gesture = opener && !previous ? opener.gesture : tab.gesture;
    const monitored = opener && !previous ? opener.monitor : sourceMonitor;
    tab.chain = {
      id: `${input.tabId}-${Math.round(startTs)}`,
      source,
      startTs,
      hops: [],
      incomplete: [],
      newTab: Boolean(opener && !previous),
      openerTabId: opener && !previous ? opener.tabId : undefined,
      interaction: interaction(gesture, monitored, startTs, firstUrl.site),
      clientRedirect,
      firstSite: firstUrl.site
    };
    appendServerStart(tab.chain, pending, dest.host, serverRedirect);
    tab.chain.hops.push({ host: dest.host, path: dest.path, timestamp: input.timestamp, via });
    if (!opener && !previous) tab.chain.incomplete.push("The page before this navigation was not observed.");
    if (opener && !opener.page) tab.chain.incomplete.push("The opener tab's page was not observed.");
  }
  tab.gesture = undefined;

  const chain = tab.chain;
  if (dest.site === chain.source.site) {
    return { outcome: "same_site", reason: "destination is on the same site as the source" };
  }
  return { outcome: "event", event: classify(chain, destRef, input.tabId) };
}

/** Upgrades a navigation recorded as "no click observed" when the click arrives late. */
function reclassifyWithLateGesture(state: TrackerState, gestureTabId: number, gesture: Gesture): TaifEvent | undefined {
  for (const [key, tab] of Object.entries(state.tabs)) {
    const chain = tab.chain;
    if (!chain || !tab.page || (chain.interaction !== "not_observed" && chain.interaction !== "unknown")) continue;
    const fromThisTab = chain.newTab ? chain.openerTabId === gestureTabId : Number(key) === gestureTabId;
    if (!fromThisTab || gesture.ts > chain.startTs + 500 || chain.startTs - gesture.ts > GESTURE_WINDOW_MS) continue;
    chain.interaction = interaction(gesture, true, chain.startTs, chain.firstSite);
    if (tab.page.site === chain.source.site) return;
    return classify(chain, tab.page, Number(key));
  }
  return;
}

export type ReturnPlan =
  | { kind: "switch"; tabId: number; closeTabId: number }
  | { kind: "navigate"; url: string }
  | { kind: "none" };

/**
 * Where "Return to previous page" goes. A tab opened by an ad returns to the tab that opened it
 * (and the ad tab is closed); a "tab-under" (the site reopened in a new tab while this tab was sent
 * to the ad) returns to that new tab; an ad that replaced the page in this same tab goes back.
 */
export function chooseReturn(input: {
  tabId: number;
  chain?: RedirectChain;
  /** Tabs that still exist, with their URL (from the browser or the tracker) and last use. */
  tabs: { id: number; url?: string; lastAccessed?: number }[];
  browserOpenerTabId?: number;
  tabUnderTabId?: number;
  returnUrl?: string;
}): ReturnPlan {
  const exists = (id: number | undefined) => id !== undefined && id !== input.tabId && input.tabs.some((tab) => tab.id === id);
  const sourceSite = input.chain ? siteOf(input.chain.source_host) : undefined;
  const showsSource = (id: number) => {
    const url = input.tabs.find((tab) => tab.id === id)?.url;
    return Boolean(sourceSite && normalizeUrl(url)?.site === sourceSite);
  };
  if (input.chain?.opened_new_tab && exists(input.chain.opener_tab_id)) {
    return { kind: "switch", tabId: input.chain.opener_tab_id!, closeTabId: input.tabId };
  }
  if (exists(input.browserOpenerTabId) && showsSource(input.browserOpenerTabId!)) {
    return { kind: "switch", tabId: input.browserOpenerTabId!, closeTabId: input.tabId };
  }
  if (exists(input.tabUnderTabId)) return { kind: "switch", tabId: input.tabUnderTabId!, closeTabId: input.tabId };
  // The site is already open in another tab (opener link not recorded): go there and close the ad tab
  // rather than loading the site a second time inside the ad tab.
  const elsewhere = input.tabs
    .filter((tab) => tab.id !== input.tabId && showsSource(tab.id))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  if (elsewhere) return { kind: "switch", tabId: elsewhere.id, closeTabId: input.tabId };
  if (input.returnUrl && isSupportedUrl(input.returnUrl)) return { kind: "navigate", url: input.returnUrl };
  return { kind: "none" };
}

/** A tab this tab opened within 10 s of its redirect: the classic tab-under pattern. */
export function findTabUnder(state: TrackerState, tabId: number, aroundTs: number): number | undefined {
  const match = Object.entries(state.tabs).find(([, tab]) =>
    tab.createdBy?.tabId === tabId && Math.abs(tab.createdBy.ts - aroundTs) < 10_000);
  return match ? Number(match[0]) : undefined;
}

function appendServerStart(chain: NonNullable<TabState["chain"]>, pending: TabState["pending"], destHost: string, serverRedirect: boolean) {
  const start = normalizeUrl(pending?.url);
  if (!serverRedirect || !start || start.host === destHost) return;
  chain.hops.push({ host: start.host, path: start.path, timestamp: pending!.ts, via: "initial request" });
  chain.incomplete.push(`Server redirect from ${start.host} to ${destHost}: intermediate HTTP redirects are not observable with webNavigation alone.`);
}

function interaction(gesture: Gesture | undefined, monitored: boolean, startTs: number, firstSite: string): RedirectChain["user_interaction"] {
  if (!monitored) return "unknown";
  if (!gesture || startTs - gesture.ts > GESTURE_WINDOW_MS || gesture.ts - startTs > 500) return "not_observed";
  return gesture.hrefSite === firstSite && !gesture.suspicious ? "observed_matching" : "observed_nonmatching";
}

interface Verdict { type: string; classification: string; title: string; summary: string; severity: Severity; confidence: number }

function classify(chain: NonNullable<TabState["chain"]>, dest: PageRef, tabId: number): TaifEvent {
  const source = chain.source;
  const hopSites = chain.hops.map((hop) => siteOf(hop.host)).filter((site, i, all) => site !== source.site && all.indexOf(site) === i);
  const multiHop = hopSites.length >= 2;
  const it = chain.interaction;
  const where = `You were browsing ${source.host}, but `;
  let verdict: Verdict;

  if (it === "observed_matching" && dest.site === chain.firstSite && !chain.clientRedirect) {
    verdict = {
      type: "user_external_link", classification: "Expected external link",
      title: chain.newTab ? "External link opened in a new tab" : "You followed an external link",
      summary: `You clicked a link to ${dest.host}. This looks like an ordinary external link and is not flagged as suspicious.`,
      severity: "informational", confidence: 0.85
    };
  } else if (it === "observed_matching") {
    verdict = {
      type: "redirect_after_click", classification: "Link led elsewhere",
      title: "Link redirected to a different website",
      summary: `${where}the link you clicked ended on ${dest.host}, a different site from the link target.`,
      severity: "medium", confidence: 0.7
    };
  } else if (chain.newTab) {
    verdict = it === "observed_nonmatching" ? {
      type: "ad_new_tab", classification: "Unexpected new tab",
      title: "New tab opened unexpectedly",
      summary: `${where}a click on ${source.host} opened ${dest.host} in a new tab. The element you clicked was not a link to that site, which is typical of pop-up advertisements.`,
      severity: "medium", confidence: 0.78
    } : it === "not_observed" ? {
      type: "popup_without_click", classification: "Unexpected new tab",
      title: "New tab opened without a click",
      summary: `${where}${source.host} opened ${dest.host} in a new tab and no click on the page was observed just before it.`,
      severity: "medium", confidence: 0.65
    } : {
      type: "new_tab_unclassified", classification: "Unclassified new tab",
      title: "New tab opened from another website",
      summary: `${where}it opened ${dest.host} in a new tab. Live monitoring was off on ${source.host}, so TAIF cannot tell whether you clicked a link.`,
      severity: "low", confidence: 0.45
    };
  } else if (chain.clientRedirect || it === "not_observed" || it === "observed_nonmatching") {
    verdict = {
      type: "unexpected_redirect", classification: "Unexpected redirect",
      title: "Unexpected redirect detected",
      summary: `${where}your browser has navigated to ${dest.host}.` + (it === "observed_nonmatching"
        ? " The navigation followed a click on something that was not a link to this site."
        : chain.clientRedirect ? " The page redirected itself with a script or meta refresh." : " No click was observed just before it."),
      severity: "medium",
      confidence: it === "unknown" ? 0.6 : it === "observed_nonmatching" ? 0.72 : 0.8
    };
  } else {
    verdict = {
      type: "cross_site_unclassified", classification: "Cross-site navigation (cause unknown)",
      title: "You are now on a different website",
      summary: `${where}you are now on ${dest.host}. Live monitoring was off, so TAIF cannot tell whether you clicked a link.`,
      severity: "low", confidence: 0.4
    };
  }

  if (multiHop && verdict.type !== "user_external_link") {
    verdict = { ...verdict, type: "multi_hop_redirect", title: `Redirect chain through ${hopSites.length} websites`, severity: verdict.severity === "low" ? "medium" : verdict.severity };
  }

  const claims: ClaimStatus[] = [
    { claim: `Cross-site navigation from ${source.host} to ${dest.host}`, status: "verified" },
    {
      claim: verdict.classification,
      status: verdict.type === "user_external_link" ? "observed" : chain.interaction === "unknown" ? "inconclusive" : "inferred"
    },
    { claim: "Destination is malicious", status: "inconclusive" }
  ];
  if (chain.newTab) claims.splice(1, 0, { claim: `Tab ${tabId} was opened by tab ${chain.openerTabId}`, status: "verified" });

  const interactionText: Record<RedirectChain["user_interaction"], string> = {
    observed_matching: "A click on a link to this site was observed just before navigation.",
    observed_nonmatching: "A click was observed just before navigation, but not on a link to this site.",
    not_observed: "Live monitoring was active and no click or key press was observed just before navigation.",
    unknown: "Live monitoring was not active on the source page, so user interaction is unknown."
  };
  const route = [source.host, ...chain.hops.map((hop) => hop.host)].filter((h, i, all) => i === 0 || all[i - 1] !== h);

  return {
    event_id: `A-${chain.id}`,
    scenario_id: "A",
    scenario_name: scenarioName("A"),
    event_type: verdict.type,
    title: verdict.title,
    summary: verdict.summary,
    source_url: source.display,
    destination_url: dest.display,
    tab_id: tabId,
    timestamp: chain.startTs,
    page_key: dest.display,
    evidence: [
      `Observed route: ${route.join(" → ")}${chain.incomplete.length ? " (incomplete)" : ""}`,
      `Navigation type: ${chain.hops.map((hop) => hop.via).join(", ")}`,
      interactionText[chain.interaction],
      ...(normalizeUrl(dest.url)?.hadQuery ? ["Query string and fragment removed from displayed URLs."] : [])
    ],
    chain: {
      source_host: source.host,
      hops: chain.hops,
      complete: chain.incomplete.length === 0,
      incomplete_reasons: chain.incomplete,
      opened_new_tab: chain.newTab,
      opener_tab_id: chain.openerTabId,
      user_interaction: chain.interaction
    },
    claims,
    severity: verdict.severity,
    confidence: verdict.confidence,
    verification_status: claims.find((item) => item.claim === verdict.classification)!.status,
    classification: verdict.classification,
    alternatives: verdict.type === "user_external_link" ? [] : [
      "A site may intentionally send you to a partner, login or payment provider.",
      "An advertisement on the page may have caused the navigation.",
      ...(chain.interaction === "unknown" ? ["You may have clicked a link; enable live monitoring to observe clicks."] : [])
    ],
    limitations: "Navigation events prove the domain changed, not that the destination is harmful. Intermediate server redirects and cross-origin frame clicks may not be visible.",
    recommended_action: verdict.type === "user_external_link"
      ? "No action needed."
      : `Check that you meant to visit ${dest.host} before entering any information, or return to ${source.host}.`,
    acknowledged: false,
    occurrences: 1,
    dismiss_key: `A|${source.site}|${dest.site}`,
    return_url: chain.newTab ? undefined : source.url
  };
}

export type { EventDraft };
