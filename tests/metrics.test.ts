import { describe, expect, it } from "vitest";
import { canBePrimary } from "../src/shared/events";
import { promptDrafts } from "../src/shared/live";
import { emptyTracker, processNav, type NavInput } from "../src/shared/redirect";

/**
 * Labeled synthetic corpus. Labels were written alongside the rules, so these numbers measure
 * consistency with the stated design, not real-world accuracy.
 */
const T = 1_760_000_000_000;
const typed = (url: string): NavInput[] => [{ kind: "committed", tabId: 1, url, timestamp: T, frameId: 0, transitionType: "typed", qualifiers: [] }, { kind: "monitor_ready", tabId: 1, timestamp: T + 10 }];
const commit = (url: string, dt: number, qualifiers: string[] = [], tabId = 1): NavInput => ({ kind: "committed", tabId, url, timestamp: T + dt, frameId: 0, transitionType: "link", qualifiers });
const click = (dt: number, href?: string): NavInput => ({ kind: "gesture", tabId: 1, timestamp: T + dt, target: "x", href });

const NAV_CASES: { name: string; alert: boolean; steps: NavInput[] }[] = [
  { name: "same-site link", alert: false, steps: [...typed("https://shop.example/"), click(500, "https://shop.example"), commit("https://shop.example/item", 600)] },
  { name: "subdomain link", alert: false, steps: [...typed("https://shop.example/"), click(500, "https://help.shop.example"), commit("https://help.shop.example/", 600)] },
  { name: "external link", alert: false, steps: [...typed("https://blog.example/"), click(500, "https://wikipedia.org"), commit("https://wikipedia.org/x", 600)] },
  { name: "external link new tab", alert: false, steps: [...typed("https://blog.example/"), click(500, "https://github.com"), { kind: "created_target", tabId: 2, sourceTabId: 1, url: "https://github.com", timestamp: T + 510 }, commit("https://github.com/", 600, [], 2)] },
  { name: "typed elsewhere", alert: false, steps: [...typed("https://a.example/"), { kind: "committed", tabId: 1, url: "https://b.example/", timestamp: T + 900, frameId: 0, transitionType: "typed", qualifiers: [] }] },
  { name: "back button", alert: false, steps: [...typed("https://a.example/"), commit("https://b.example/", 900, ["forward_back"])] },
  { name: "auto redirect", alert: true, steps: [...typed("https://moviesda.ski/"), commit("https://search.yahoo.com/", 4000, ["client_redirect"])] },
  { name: "no-click nav", alert: true, steps: [...typed("https://moviesda.ski/"), commit("https://ads.example-ad.net/", 9000)] },
  { name: "click on div nav", alert: true, steps: [...typed("https://moviesda.ski/"), click(500), commit("https://ads.example-ad.net/", 700)] },
  { name: "popunder", alert: true, steps: [...typed("https://moviesda.ski/"), click(500), { kind: "created_target", tabId: 2, sourceTabId: 1, url: "https://ad.example/", timestamp: T + 510 }, commit("https://ad.example/", 600, [], 2)] },
  { name: "multi hop", alert: true, steps: [...typed("https://moviesda.ski/"), commit("https://hop.example/", 3000, ["client_redirect"]), commit("https://final.example/", 3500, ["client_redirect"])] },
  { name: "link then redirect elsewhere", alert: true, steps: [...typed("https://blog.example/"), click(500, "https://short.link"), { kind: "before_navigate", tabId: 1, url: "https://short.link/a", timestamp: T + 600, frameId: 0 }, commit("https://scam.example/", 900, ["server_redirect"])] }
];

const PROMPT_CASES: { text: string; links?: string[]; notify?: boolean; overlay?: boolean; alert: boolean }[] = [
  { text: "Your computer is infected! Download now immediately", links: ["fix.exe"], overlay: true, alert: true },
  { text: "Microsoft security alert: call Microsoft support right now", overlay: true, alert: true },
  { text: "Click Allow to continue watching", notify: true, alert: true },
  { text: "Your browser is out of date. Update Chrome now", links: ["update.exe"], overlay: true, alert: true },
  { text: "Download our app", links: ["app.apk"], alert: false },
  { text: "How to remove a virus detected warning", alert: false },
  { text: "Enable notifications for new messages", notify: true, alert: false },
  { text: "Release notes: update your dependencies", alert: false }
];

function score(results: { expected: boolean; actual: boolean }[]) {
  const tp = results.filter((r) => r.expected && r.actual).length;
  const fp = results.filter((r) => !r.expected && r.actual).length;
  const fn = results.filter((r) => r.expected && !r.actual).length;
  const tn = results.filter((r) => !r.expected && !r.actual).length;
  return { tp, fp, fn, tn, precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), fpr: fp / (fp + tn || 1) };
}

describe("synthetic corpus metrics", () => {
  it("navigation correlation", () => {
    const started = performance.now();
    let steps = 0;
    const results = NAV_CASES.map((test) => {
      const state = emptyTracker();
      const events = test.steps.map((step) => { steps += 1; return processNav(state, step).event; }).filter(Boolean);
      return { expected: test.alert, actual: events.some((event) => canBePrimary(event!)) };
    });
    const latencyMs = (performance.now() - started) / steps;
    const metrics = score(results);
    console.info("[metrics] navigation", { ...metrics, cases: NAV_CASES.length, avgProcessingMsPerEvent: latencyMs.toFixed(4) });
    expect(metrics.precision).toBe(1);
    expect(metrics.recall).toBe(1);
  });

  it("prompt detection", () => {
    const results = PROMPT_CASES.map((test) => ({
      expected: test.alert,
      actual: promptDrafts({
        key: "k", element: "div", text: test.text, inViewport: true, isOverlay: Boolean(test.overlay), notificationRequested: Boolean(test.notify),
        downloadLinks: (test.links ?? []).map((file) => ({ file, text: "" }))
      }).some((draft) => draft.severity !== "informational" && draft.severity !== "low")
    }));
    const metrics = score(results);
    console.info("[metrics] prompts", { ...metrics, cases: PROMPT_CASES.length });
    expect(metrics.fpr).toBe(0);
    expect(metrics.recall).toBe(1);
  });
});
