import { describe, expect, it } from "vitest";
import { contrastRatio, effectiveBackground } from "../src/content/scan";
import { detect, detectorCount, prices, similarity, timerRestarted } from "../src/shared/detectors";
import type { ElementEvidence, PageEvidence } from "../src/shared/types";

const NOW = "2026-01-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

const baseline = (): PageEvidence => ({
  url: "https://user:secret@example.test/product?session=secret#reviews",
  title: "Product",
  text: "A product page.",
  observedAt: NOW,
  elements: [],
  timers: [],
  formCount: 0,
  formsNoValidate: false
});

const scenario = (page: PageEvidence, id: number) => detect(page).filter((finding) => finding.scenario_id === id);
const text = (overrides: Partial<ElementEvidence>): ElementEvidence => ({ tag: "p", description: "p", text: "Some readable words", ...overrides });

describe("TAIF scenario detectors", () => {
  it("registers all 11 independent scenarios and is silent on a normal page", () => {
    expect(detectorCount).toBe(11);
    expect(detect(baseline())).toEqual([]);
  });

  describe("1 · readability / dark mode", () => {
    it("groups real contrast failures into one finding and raises severity for controls", () => {
      const page = baseline();
      page.elements = [
        text({ contrast: 2.1, interactive: true, tag: "a", text: "Cancel subscription" }),
        text({ contrast: 2.5 }),
        text({ contrast: 9 })
      ];
      const [finding] = scenario(page, 1);
      expect(finding.title).toBe("Buttons or links are hard to read");
      expect(finding.severity).toBe("medium");
      expect(finding.evidence[0]).toContain("2.10:1");
      expect(scenario(page, 1)).toHaveLength(1);
    });

    it("ignores text on images, large text above 3:1, and a single borderline paragraph", () => {
      const page = baseline();
      page.elements = [
        text({ contrast: 1.5, backgroundImage: true }),
        text({ contrast: 3.4, large: true }),
        text({ contrast: 4.2 })
      ];
      expect(scenario(page, 1)).toEqual([]);
    });

    it("never flags a missing dark theme on its own", () => {
      const page = baseline();
      page.darkMode = { supported: false, preferred: true, pageIsDark: false };
      expect(scenario(page, 1)).toEqual([]);
    });

    it("labels dark-mode readability when the user prefers dark and the page is dark", () => {
      const page = baseline();
      page.darkMode = { supported: true, preferred: true, pageIsDark: true };
      page.elements = [text({ contrast: 1.8 }), text({ contrast: 2 }), text({ contrast: 2.2 })];
      expect(scenario(page, 1)[0].title).toBe("Text is hard to read in dark mode");
    });
  });

  describe("2 · urgency", () => {
    it("detects a countdown that restarts between visits", () => {
      const page = baseline();
      page.timers = [{ key: "/deal|0|", text: "05:00", seconds: 300, context: "Hurry, offer ends soon!" }];
      page.previousTimers = [{ key: "/deal|0|", seconds: 300, at: NOW_MS - 10 * 60_000, restarts: 0 }];
      const [finding] = scenario(page, 2);
      expect(finding.title).toBe("Countdown restarted when you came back");
      expect(finding.summary).toContain("should have ended");
      expect(finding.evidence.join(" ")).toContain("Hurry");
      expect(finding.severity).toBe("medium");
    });

    it("escalates after repeated restarts", () => {
      const page = baseline();
      page.timers = [{ key: "k", text: "10:00", seconds: 600 }];
      page.previousTimers = [{ key: "k", seconds: 600, at: NOW_MS - 3 * 60_000, restarts: 2 }];
      const [finding] = scenario(page, 2);
      expect(finding.title).toContain("3 times");
      expect(finding.verification_status).toBe("observed");
    });

    it("does not flag a genuine countdown that kept running", () => {
      const page = baseline();
      page.timers = [{ key: "k", text: "04:00", seconds: 240 }];
      page.previousTimers = [{ key: "k", seconds: 300, at: NOW_MS - 60_000, restarts: 0 }];
      expect(scenario(page, 2)).toEqual([]);
      expect(timerRestarted({ key: "k", seconds: 300, at: NOW_MS - 60_000, restarts: 0 }, { key: "k", text: "", seconds: 240 }, NOW_MS)).toBe(false);
    });
  });

  it("3 · admin: visible admin links are informational; an admin route with controls is low and inconclusive", () => {
    const links = baseline();
    links.adminControls = 1;
    expect(scenario(links, 3)[0].severity).toBe("informational");
    const route = baseline();
    route.url = "https://example.test/admin/users";
    route.adminControls = 3;
    const [finding] = scenario(route, 3);
    expect(finding.verification_status).toBe("inconclusive");
    expect(finding.summary).toContain("cannot verify");
  });

  describe("4 · scarcity", () => {
    it("treats a single stock claim as informational, not false", () => {
      const page = baseline();
      page.claims = [{ text: "Only 2 left", count: 2 }];
      expect(scenario(page, 4)[0].severity).toBe("informational");
    });

    it("flags a stock count that went up", () => {
      const page = baseline();
      page.claims = [{ text: "Only 5 left", count: 5 }];
      page.previousClaims = [{ text: "Only 2 left", count: 2, at: NOW_MS - 3600_000 }];
      expect(scenario(page, 4)[0].title).toContain("went up");
    });

    it("flags the same claim on many visits over a long period", () => {
      const page = baseline();
      page.claims = [{ text: "Only 1 left", count: 1 }];
      page.previousClaims = [
        { text: "Only 1 left", count: 1, at: NOW_MS - 48 * 3600_000 },
        { text: "Only 1 left", count: 1, at: NOW_MS - 24 * 3600_000 }
      ];
      expect(scenario(page, 4)[0].severity).toBe("medium");
    });
  });

  it("5 · verification: only personal-data forms without checks, inconclusive", () => {
    const search = baseline();
    search.forms = [{ description: "form 1", sensitive: [], validated: false, novalidate: true }];
    expect(scenario(search, 5)).toEqual([]);
    const signup = baseline();
    signup.forms = [{ description: "form 1", sensitive: ["email", "password"], validated: false, novalidate: true }];
    const [finding] = scenario(signup, 5);
    expect(finding.severity).toBe("medium");
    expect(finding.verification_status).toBe("inconclusive");
  });

  it("6 · performance: slow load or freezes, never a load-test claim", () => {
    const page = baseline();
    page.navigation = { loadMs: 900, longTasks: 1, failedResources: 0 };
    expect(scenario(page, 6)).toEqual([]);
    page.navigation = { loadMs: 6500, longTasks: 7, resourceCount: 25 };
    const [finding] = scenario(page, 6);
    expect(finding.summary).toContain("not the server's capacity");
    expect(finding.limitations).toContain("not a server load test");
  });

  it("7 · sensitive info: secrets are high and masked; emails are informational", () => {
    const secret = baseline();
    secret.text = "config AKIAABCDEFGHIJKLMNOP and contact user@example.test";
    const [finding] = scenario(secret, 7);
    expect(finding.severity).toBe("high");
    expect(finding.evidence.join(" ")).not.toContain("AKIA");
    const contact = baseline();
    contact.text = "Write to user@example.test";
    expect(scenario(contact, 7)[0].severity).toBe("informational");
    expect(JSON.stringify(scenario(contact, 7))).not.toContain("user@example.test");
  });

  it("8 · accessibility: one grouped finding listing each barrier", () => {
    const page = baseline();
    page.accessibility = { unlabeled: ['button ""'], smallTargets: ['button "x"'], focusSuppressed: true, imageLinksWithoutAlt: 1 };
    const [finding] = scenario(page, 8);
    expect(finding.evidence).toHaveLength(4);
    expect(finding.severity).toBe("medium");
    page.accessibility = { unlabeled: [], smallTargets: [], focusSuppressed: false, imageLinksWithoutAlt: 0 };
    expect(scenario(page, 8)).toEqual([]);
  });

  describe("9 · cross-page conflicts", () => {
    it("compares prices only for the same product", () => {
      const page = baseline();
      page.title = "Acme Running Shoe X2 Blue";
      page.text = "Price $89.99";
      page.previousPage = { url: "https://other.test/p", title: "Acme Running Shoe X2 Blue", text: "$79.99" };
      expect(scenario(page, 9)[0].title).toBe("Same product, different price");
      page.previousPage = { url: "https://other.test/p", title: "Garden hose 20m", text: "$79.99" };
      expect(scenario(page, 9)).toEqual([]);
    });

    it("matches by product code and normalizes currency", () => {
      const page = baseline();
      page.product = { sku: "SKU-1", name: "A" };
      page.text = "₹1,299";
      page.previousPage = { url: "https://other.test/p", title: "B", text: "$15", sku: "SKU-1" };
      expect(scenario(page, 9)[0].title).toBe("Same product, different currencies");
      expect(prices("Rs. 1,299.50 and €10")).toEqual([
        { raw: "Rs. 1,299.50", amount: 1299.5, currency: "INR" },
        { raw: "€10", amount: 10, currency: "EUR" }
      ]);
      expect(similarity("Acme Shoe Blue", "acme shoe blue")).toBe(1);
    });
  });

  it("10 · subscription: only with a subscribe action; flags small, faint or distant terms", () => {
    const none = baseline();
    none.subscription = { terms: [{ text: "automatically renews", fontSize: 9, distance: 0 }] };
    expect(scenario(none, 10)).toEqual([]);
    const clear = baseline();
    clear.subscription = { action: { text: "Start free trial", fontSize: 16 }, terms: [{ text: "Renews monthly until you cancel", fontSize: 15, contrast: 9, distance: 30 }] };
    expect(scenario(clear, 10)[0].severity).toBe("informational");
    const hidden = baseline();
    hidden.subscription = { action: { text: "Start free trial", fontSize: 18 }, terms: [{ text: "Trial converts to paid and automatically renews", fontSize: 9, contrast: 2.5, distance: 900 }] };
    const [finding] = scenario(hidden, 10);
    expect(finding.title).toBe("Subscription terms are easy to miss");
    expect(finding.summary).toContain("900px away");
  });

  it("11 · visual emphasis: flags a muted decline option, not ordinary design differences", () => {
    const page = baseline();
    page.choicePairs = [{
      container: "div cookie banner",
      positive: { text: "Accept all", area: 9000, contrast: 8, opacity: 1, fontSize: 16 },
      negative: { text: "Reject", area: 800, contrast: 1.8, opacity: 1, fontSize: 10 }
    }];
    const [finding] = scenario(page, 11);
    expect(finding.title).toContain("Reject");
    expect(finding.severity).toBe("medium");
    page.choicePairs = [{
      container: "div",
      positive: { text: "Subscribe", area: 6000, contrast: 8, opacity: 1, fontSize: 16 },
      negative: { text: "No thanks", area: 1800, contrast: 7, opacity: 1, fontSize: 14 }
    }];
    expect(scenario(page, 11)).toEqual([]);
  });

  it("redacts URL query parameters and credentials from findings", () => {
    const page = baseline();
    page.claims = [{ text: "Only 2 left", count: 2 }];
    expect(detect(page)[0].page_url).toBe("https://example.test/product");
  });

  it("keeps finding ids stable across rescans so acknowledgements stick", () => {
    const page = baseline();
    page.elements = [text({ contrast: 1.5 }), text({ contrast: 1.6 }), text({ contrast: 1.7 })];
    const first = scenario(page, 1)[0].finding_id;
    page.elements.push(text({ contrast: 1.2, text: "another faint line" }));
    expect(scenario(page, 1)[0].finding_id).toBe(first);
  });
});

describe("scanner: real background behind text", () => {
  it("walks up to the nearest solid background and composites translucent layers", () => {
    document.body.innerHTML = `<div style="background-color: rgb(0, 0, 0)"><div style="background-color: rgba(255, 255, 255, 0.5)"><p id="t">x</p></div></div>`;
    const { color, image } = effectiveBackground(document.getElementById("t")!);
    expect(image).toBe(false);
    expect(color!.slice(0, 3).map(Math.round)).toEqual([128, 128, 128]);
  });

  it("reports text over a background image as unmeasurable", () => {
    document.body.innerHTML = `<div style="background-image: url(hero.png)"><p id="t">x</p></div>`;
    expect(effectiveBackground(document.getElementById("t")!).image).toBe(true);
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 0);
  });
});
