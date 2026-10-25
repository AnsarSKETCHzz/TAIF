import { describe, expect, it } from "vitest";
import { buildTabView, findingToEvent, upsertEvent } from "../src/shared/events";
import { chooseReturn, emptyTracker, findTabUnder, processNav, type TrackerState } from "../src/shared/redirect";
import type { Finding, TaifEvent } from "../src/shared/types";

const T0 = 1_760_000_000_000;

function go(state: TrackerState, tabId: number, url: string, t: number, transitionType = "link", qualifiers: string[] = []) {
  processNav(state, { kind: "before_navigate", tabId, url, timestamp: t - 5, frameId: 0 });
  return processNav(state, { kind: "committed", tabId, url, timestamp: t, frameId: 0, transitionType, qualifiers });
}

function onSite(url: string, tabId = 1) {
  const state = emptyTracker();
  go(state, tabId, url, T0, "typed");
  processNav(state, { kind: "monitor_ready", tabId, timestamp: T0 + 100 });
  return state;
}

describe("late click signals", () => {
  it("withdraws an 'unexpected redirect' when the link click arrives after the navigation", () => {
    const state = onSite("https://docs.example.org/");
    const early = go(state, 1, "https://github.com/org/repo", T0 + 1000).event!;
    expect(early.event_type).toBe("unexpected_redirect");
    const late = processNav(state, { kind: "gesture", tabId: 1, timestamp: T0 + 990, target: "a", href: "https://github.com" });
    expect(late.event?.event_id).toBe(early.event_id);
    expect(late.event?.event_type).toBe("user_external_link");
    expect(late.event?.severity).toBe("informational");
  });

  it("does not treat the old page's late click as a click on the new page", () => {
    const state = onSite("https://a.example/");
    go(state, 1, "https://b.example/", T0 + 1000);
    processNav(state, { kind: "gesture", tabId: 1, timestamp: T0 + 990, target: "a", href: "https://b.example" });
    processNav(state, { kind: "monitor_ready", tabId: 1, timestamp: T0 + 1500 });
    // A later script redirect on b.example must still count as "no click observed".
    const next = go(state, 1, "https://ads.example-ad.net/", T0 + 9000);
    expect(next.event?.chain?.user_interaction).toBe("not_observed");
  });

  it("reclassifies a new tab when the opener's click arrives late", () => {
    const state = onSite("https://moviesda.ski/");
    processNav(state, { kind: "created_target", tabId: 2, sourceTabId: 1, url: "https://ad.example/", timestamp: T0 + 2000 });
    const before = go(state, 2, "https://ad.example/", T0 + 2100).event!;
    expect(before.event_type).toBe("popup_without_click");
    const after = processNav(state, { kind: "gesture", tabId: 1, timestamp: T0 + 1995, target: "div \"Play\"" }).event!;
    expect(after.event_type).toBe("ad_new_tab");
  });
});

describe("Return to previous page", () => {
  const chain = (openedNewTab: boolean, opener?: number) => ({
    source_host: "moviesda.ski", hops: [], complete: true, incomplete_reasons: [],
    opened_new_tab: openedNewTab, opener_tab_id: opener, user_interaction: "observed_nonmatching" as const
  });

  it("switches to the opener tab and closes the ad tab when the ad opened a new tab", () => {
    expect(chooseReturn({ tabId: 7, chain: chain(true, 1), tabs: [{ id: 1 }, { id: 7 }], returnUrl: undefined }))
      .toEqual({ kind: "switch", tabId: 1, closeTabId: 7 });
  });

  it("uses the browser's opener when it still shows the source site", () => {
    const tabs = [{ id: 1, url: "https://moviesda.ski/film" }, { id: 7, url: "https://search.yahoo.com/" }];
    expect(chooseReturn({ tabId: 7, chain: chain(false), tabs, browserOpenerTabId: 1, returnUrl: "https://moviesda.ski/" }))
      .toEqual({ kind: "switch", tabId: 1, closeTabId: 7 });
  });

  it("does not jump to an unrelated opener (e.g. the search page the user came from)", () => {
    const tabs = [{ id: 1, url: "https://www.google.com/search" }, { id: 7, url: "https://search.yahoo.com/" }];
    expect(chooseReturn({ tabId: 7, chain: chain(false), tabs, browserOpenerTabId: 1, returnUrl: "https://moviesda.ski/" }))
      .toEqual({ kind: "navigate", url: "https://moviesda.ski/" });
  });

  it("handles a tab-under: the site reopened in a new tab while this tab went to the ad", () => {
    const state = onSite("https://moviesda.ski/");
    processNav(state, { kind: "created_target", tabId: 3, sourceTabId: 1, url: "https://moviesda.ski/", timestamp: T0 + 2000 });
    go(state, 3, "https://moviesda.ski/", T0 + 2050);
    const event = go(state, 1, "https://search.yahoo.com/", T0 + 2200, "link", ["client_redirect"]).event!;
    const underTab = findTabUnder(state, 1, event.timestamp);
    expect(underTab).toBe(3);
    expect(chooseReturn({ tabId: 1, chain: event.chain, tabs: [{ id: 1 }, { id: 3 }], tabUnderTabId: underTab, returnUrl: event.return_url }))
      .toEqual({ kind: "switch", tabId: 3, closeTabId: 1 });
  });

  it("keeps same-tab ads going back to the previous page", () => {
    const state = onSite("https://moviesda.ski/");
    const event = go(state, 1, "https://search.yahoo.com/", T0 + 5000, "link", ["client_redirect"]).event!;
    expect(chooseReturn({ tabId: 1, chain: event.chain, tabs: [{ id: 1 }], tabUnderTabId: findTabUnder(state, 1, event.timestamp), returnUrl: event.return_url }))
      .toEqual({ kind: "navigate", url: "https://moviesda.ski/" });
  });
});

describe("popup list and Got it", () => {
  const finding = (id: string, severity: Finding["severity"], confidence = 0.8): Finding => ({
    finding_id: id, scenario_id: 1, scenario_name: "Dark-mode readability", category: "x", severity, confidence,
    confidence_rationale: "", title: id, summary: "", evidence: [], affected_element_description: "", page_url: "",
    detected_at: new Date(T0).toISOString(), recommended_action: "", limitations: "", verification_status: "observed"
  });
  const page = "https://shop.example/deal";

  it("shows every real problem, hides informational ones in details, and is clean when nothing is wrong", () => {
    const events = [finding("a", "medium"), finding("b", "low"), finding("c", "informational"), finding("d", "low", 0.3)]
      .map((item) => findingToEvent(item, 1, page));
    const view = buildTabView(events, { page, status: "done", at: T0 }, page, true, T0, page);
    expect(view.status).toBe("issue");
    expect(view.problems.map((event) => event.title)).toEqual(["a", "b"]);
    expect(view.details).toHaveLength(2);
    const clean = buildTabView([findingToEvent(finding("c", "informational"), 1, page)], { page, status: "done", at: T0 }, page, true, T0, page);
    expect(clean.status).toBe("clean");
    expect(clean.problems).toEqual([]);
  });

  it("puts a redirect alert first", () => {
    const state = onSite("https://moviesda.ski/");
    const redirect = go(state, 1, "https://search.yahoo.com/", T0 + 5000, "link", ["client_redirect"]).event!;
    const scan = findingToEvent(finding("contrast", "high"), 1, redirect.page_key);
    const view = buildTabView([scan, redirect], undefined, "https://search.yahoo.com/", true, T0 + 6000, redirect.page_key);
    expect(view.problems[0].scenario_id).toBe("A");
  });

  it("keeps a finding hidden after 'Got it' even when the page is rescanned", () => {
    const first = findingToEvent(finding("a", "medium"), 1, page);
    const dismissed = { [first.dismiss_key]: T0 };
    // A rescan deletes scan events and recreates them from scratch.
    const rescanned: TaifEvent[] = upsertEvent([], findingToEvent(finding("a", "medium"), 1, page), dismissed, T0 + 60_000).events;
    expect(rescanned[0].acknowledged).toBe(true);
    expect(buildTabView(rescanned, undefined, page, true, T0, page).problems).toEqual([]);
  });
});
