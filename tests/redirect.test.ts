import { afterEach, describe, expect, it, vi } from "vitest";
import { canBePrimary, rankEvents, upsertEvent, DISMISS_TTL_MS } from "../src/shared/events";
import { emptyTracker, processNav, type TrackerState } from "../src/shared/redirect";
import type { TaifEvent } from "../src/shared/types";

const T0 = 1_760_000_000_000;

function go(state: TrackerState, tabId: number, url: string, t: number, transitionType = "link", qualifiers: string[] = []) {
  processNav(state, { kind: "before_navigate", tabId, url, timestamp: t - 5, frameId: 0 });
  return processNav(state, { kind: "committed", tabId, url, timestamp: t, frameId: 0, transitionType, qualifiers });
}

/** User types the site into the address bar and the live monitor loads on it. */
function onSite(url: string, tabId = 1, monitor = true) {
  const state = emptyTracker();
  go(state, tabId, url, T0, "typed", ["from_address_bar"]);
  if (monitor) processNav(state, { kind: "monitor_ready", tabId, timestamp: T0 + 100 });
  return state;
}

describe("Feature A: redirect detection (mandatory cases)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("1. same-domain navigation (including subdomains) raises no event", () => {
    const state = onSite("https://moviesda.ski/");
    expect(go(state, 1, "https://moviesda.ski/movie/123", T0 + 1000).outcome).toBe("same_site");
    expect(go(state, 1, "https://cdn.moviesda.ski/player", T0 + 2000).outcome).toBe("same_site");
  });

  it("2. a clicked external link is recorded as expected and never as a primary alert", () => {
    const state = onSite("https://moviesda.ski/");
    processNav(state, { kind: "gesture", tabId: 1, timestamp: T0 + 1000, target: "a \"Wikipedia\"", href: "https://en.wikipedia.org" });
    const result = go(state, 1, "https://en.wikipedia.org/wiki/Film", T0 + 1100);
    expect(result.event?.event_type).toBe("user_external_link");
    expect(result.event?.severity).toBe("informational");
    expect(canBePrimary(result.event!)).toBe(false);
  });

  it("3. unexpected cross-domain navigation reports the real source and destination", () => {
    const state = onSite("https://moviesda.ski/");
    const result = go(state, 1, "https://search.yahoo.com/search?p=secret-query", T0 + 5000, "link", ["client_redirect"]);
    const event = result.event!;
    expect(event.event_type).toBe("unexpected_redirect");
    expect(event.chain?.source_host).toBe("moviesda.ski");
    expect(event.destination_url).toBe("https://search.yahoo.com/search");
    expect(JSON.stringify({ ...event, return_url: undefined })).not.toContain("secret-query");
    expect(event.claims).toContainEqual({ claim: "Cross-site navigation from moviesda.ski to search.yahoo.com", status: "verified" });
    expect(canBePrimary(event)).toBe(true);
  });

  it("works for arbitrary domains, not just MoviesDA/Yahoo", () => {
    const state = onSite("https://news.example.co.uk/a");
    const event = go(state, 1, "https://promo.other-shop.com.au/", T0 + 3000, "link", ["client_redirect"]).event!;
    expect(event.summary).toContain("news.example.co.uk");
    expect(event.summary).toContain("promo.other-shop.com.au");
  });

  it("4. an advertisement opening a new tab is correlated with its opener tab", () => {
    const state = onSite("https://moviesda.ski/");
    processNav(state, { kind: "gesture", tabId: 1, timestamp: T0 + 2000, target: "div \"Download HD\"" });
    processNav(state, { kind: "created_target", tabId: 7, sourceTabId: 1, url: "https://ads.example-ad.net/c", timestamp: T0 + 2010 });
    const event = go(state, 7, "https://ads.example-ad.net/c", T0 + 2100).event!;
    expect(event.event_type).toBe("ad_new_tab");
    expect(event.chain?.opened_new_tab).toBe(true);
    expect(event.chain?.opener_tab_id).toBe(1);
    expect(event.tab_id).toBe(7);
  });

  it("5. a multi-hop chain updates one event and lists every observed hop", () => {
    const state = onSite("https://moviesda.ski/");
    const first = go(state, 1, "https://ads.example-ad.net/r", T0 + 3000, "link", ["client_redirect"]).event!;
    const second = go(state, 1, "https://search.yahoo.com/", T0 + 3800, "link", ["client_redirect"]).event!;
    expect(second.event_id).toBe(first.event_id);
    expect(second.event_type).toBe("multi_hop_redirect");
    expect(second.chain?.hops.map((hop) => hop.host)).toEqual(["ads.example-ad.net", "search.yahoo.com"]);
  });

  it("5b. server redirects mark the chain incomplete instead of inventing hops", () => {
    const state = onSite("https://moviesda.ski/");
    processNav(state, { kind: "before_navigate", tabId: 1, url: "https://track.adclick.example/x", timestamp: T0 + 4000, frameId: 0 });
    const event = processNav(state, { kind: "committed", tabId: 1, url: "https://search.yahoo.com/", timestamp: T0 + 4300, frameId: 0, transitionType: "link", qualifiers: ["server_redirect"] }).event!;
    expect(event.chain?.complete).toBe(false);
    expect(event.chain?.incomplete_reasons[0]).toContain("not observable");
    expect(event.chain?.hops.map((hop) => hop.host)).toEqual(["track.adclick.example", "search.yahoo.com"]);
  });

  it("6. incomplete information is reported as unknown/inconclusive, not guessed", () => {
    const noOpener = emptyTracker();
    processNav(noOpener, { kind: "created_target", tabId: 9, sourceTabId: 99, url: "https://x.example/", timestamp: T0 });
    expect(go(noOpener, 9, "https://x.example/", T0 + 50).outcome).toBe("baseline");

    const unmonitored = onSite("https://moviesda.ski/", 1, false);
    processNav(unmonitored, { kind: "created_target", tabId: 2, sourceTabId: 1, url: "https://ads.example-ad.net/", timestamp: T0 + 900 });
    const event = go(unmonitored, 2, "https://ads.example-ad.net/", T0 + 1000).event!;
    expect(event.event_type).toBe("new_tab_unclassified");
    expect(event.chain?.user_interaction).toBe("unknown");
    expect(event.verification_status).toBe("inconclusive");
  });

  it("7. repeated navigation events are deduplicated", () => {
    const state = onSite("https://moviesda.ski/");
    const commit = { kind: "committed" as const, tabId: 1, url: "https://search.yahoo.com/", timestamp: T0 + 5000, frameId: 0, transitionType: "link", qualifiers: ["client_redirect"] };
    expect(processNav(state, commit).outcome).toBe("event");
    expect(processNav(state, { ...commit, timestamp: T0 + 5200 }).outcome).toBe("duplicate");
  });

  it("8. restricted browser pages are ignored and never used as a source", () => {
    const state = emptyTracker();
    expect(go(state, 1, "chrome://newtab/", T0, "typed").reason).toContain("unsupported");
    expect(go(state, 1, "https://moviesda.ski/", T0 + 1000).outcome).toBe("baseline");
    expect(processNav(state, { kind: "before_navigate", tabId: 1, url: "chrome-extension://abc/index.html", timestamp: T0, frameId: 0 }).reason).toContain("unsupported");
  });

  it("9. detection works with the backend unavailable (no network is used)", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("backend down")));
    vi.stubGlobal("fetch", fetchSpy);
    const state = onSite("https://moviesda.ski/");
    expect(go(state, 1, "https://search.yahoo.com/", T0 + 5000, "link", ["client_redirect"]).event).toBeDefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("10. a dismissed alert is no longer primary", () => {
    const event = go(onSite("https://moviesda.ski/"), 1, "https://search.yahoo.com/", T0 + 5000, "link", ["client_redirect"]).event!;
    const dismissed = { ...event, acknowledged: true };
    expect(rankEvents([dismissed], event.page_key, T0 + 6000).primary).toBeUndefined();
    expect(rankEvents([dismissed], event.page_key, T0 + 6000).others).toHaveLength(1);
  });

  it("11. the same redirect again after dismissal is recorded but not re-raised until the dismissal expires", () => {
    const state = onSite("https://moviesda.ski/");
    const first = go(state, 1, "https://search.yahoo.com/", T0 + 5000, "link", ["client_redirect"]).event!;
    const dismissed = { [first.dismiss_key]: T0 + 6000 };
    go(state, 1, "https://moviesda.ski/", T0 + 7000, "typed");
    const again = go(state, 1, "https://search.yahoo.com/", T0 + 30000, "link", ["client_redirect"]).event!;
    expect(again.event_id).not.toBe(first.event_id);
    const store: TaifEvent[] = [{ ...first, acknowledged: true }];
    const result = upsertEvent(store, again, dismissed, T0 + 31000);
    expect(result.isNew).toBe(false);
    expect(result.events.find((e) => e.event_id === again.event_id)?.acknowledged).toBe(true);
    const later = upsertEvent([], again, dismissed, T0 + 6000 + DISMISS_TTL_MS + 1);
    expect(later.isNew).toBe(true);
  });

  it("12. a legitimate external link is never labeled malicious", () => {
    const state = onSite("https://docs.example.org/");
    processNav(state, { kind: "gesture", tabId: 1, timestamp: T0 + 1000, target: "a", href: "https://github.com" });
    const event = go(state, 1, "https://github.com/org/repo", T0 + 1050).event!;
    expect(`${event.title} ${event.summary} ${event.classification}`.toLowerCase()).not.toMatch(/malicious|dangerous|scam/);
    expect(event.claims.some((claim) => /malicious/i.test(claim.claim))).toBe(true);
    expect(event.claims.find((claim) => /malicious/i.test(claim.claim))?.status).toBe("inconclusive");
  });

  it("user-driven navigations (typed, back/forward, reload) are never unexpected", () => {
    const state = onSite("https://moviesda.ski/");
    expect(go(state, 1, "https://yahoo.com/", T0 + 1000, "typed").outcome).toBe("baseline");
    expect(go(state, 1, "https://moviesda.ski/", T0 + 2000, "link", ["forward_back"]).outcome).toBe("baseline");
  });

  it("a click on a non-link element followed by navigation is classified as unexpected", () => {
    const state = onSite("https://moviesda.ski/");
    processNav(state, { kind: "gesture", tabId: 1, timestamp: T0 + 1000, target: "div \"Play\"" });
    expect(go(state, 1, "https://ads.example-ad.net/", T0 + 1200).event?.event_type).toBe("unexpected_redirect");
  });
});
