import { describe, expect, it } from "vitest";
import { detect } from "../src/shared/detectors";
import { eventFromDraft, findingToEvent, rankEvents, validateDraft } from "../src/shared/events";
import {
  analyzeTimer,
  closeState,
  overlayDraft,
  parseCountdown,
  promptDrafts,
  timerDraft,
  type PromptInput
} from "../src/shared/live";
import { emptyTracker, processNav } from "../src/shared/redirect";
import type { PageEvidence } from "../src/shared/types";

const samples = (values: number[]) => values.map((seconds, i) => ({ t: i * 1000, seconds }));
const prompt = (overrides: Partial<PromptInput>): PromptInput => ({
  key: "k", element: "div", text: "", downloadLinks: [], notificationRequested: false, isOverlay: false, inViewport: true, ...overrides
});

describe("Feature B: timers and close buttons", () => {
  it("parses clock and word countdowns", () => {
    expect(parseCountdown("Offer ends in 09:59")).toBe(599);
    expect(parseCountdown("Skip in 5 seconds")).toBe(5);
    expect(parseCountdown("Chapter 3")).toBeUndefined();
  });

  it("does not flag an ordinary countdown", () => {
    const analysis = analyzeTimer(samples([10, 9, 8, 7, 6, 5]));
    expect(analysis.resets).toBe(0);
    expect(timerDraft("t", "p", analysis, true)).toBeUndefined();
  });

  it("flags repeated resets with more confidence than a single reset", () => {
    const once = timerDraft("t", "p", analyzeTimer(samples([5, 4, 3, 60, 59])), true)!;
    const twice = timerDraft("t", "p", analyzeTimer(samples([5, 4, 3, 60, 59, 58, 3, 2, 60])), true)!;
    expect(once.severity).toBe("low");
    expect(twice.title).toContain("2 times");
    expect(twice.confidence).toBeGreaterThan(once.confidence);
  });

  it("classifies close-control states", () => {
    expect(closeState([{ disabled: false, hidden: false, obscured: false }], false)).toBe("visible");
    expect(closeState([{ disabled: true, hidden: false, obscured: false }], false)).toBe("disabled");
    expect(closeState([{ disabled: false, hidden: false, obscured: true }], false)).toBe("obscured");
    expect(closeState([{ disabled: false, hidden: true, obscured: false }], false)).toBe("hidden");
    expect(closeState([], false)).toBe("not_found");
    expect(closeState([], true)).toBe("inconclusive");
  });

  it("treats a short legitimate ad countdown as normal", () => {
    expect(overlayDraft({ key: "o", element: "div", coverage: 0.9, visibleMs: 6000, state: "visible", closeAvailableAfterMs: 5000, hasCountdown: true, timerResets: 0 })).toBeUndefined();
  });

  it("reports an overlay with no close control after a sustained block", () => {
    const base = { key: "o", element: "div", coverage: 0.85, state: "not_found" as const, hasCountdown: false, timerResets: 0 };
    expect(overlayDraft({ ...base, visibleMs: 3000 })).toBeUndefined();
    const draft = overlayDraft({ ...base, visibleMs: 10000 })!;
    expect(draft.event_type).toBe("blocked_dismissal");
    expect(draft.verification_status).toBe("observed");
    expect(overlayDraft({ ...base, state: "inconclusive", visibleMs: 10000 })!.verification_status).toBe("inconclusive");
  });

  it("reports a close button delayed by a resetting countdown", () => {
    const draft = overlayDraft({ key: "o", element: "div", coverage: 0.9, visibleMs: 30000, state: "visible", closeAvailableAfterMs: 25000, hasCountdown: true, timerResets: 2 })!;
    expect(draft.event_type).toBe("delayed_close_with_resets");
    expect(draft.evidence.join(" ")).toContain("25s");
  });

  it("ignores small overlays such as cookie bars", () => {
    expect(overlayDraft({ key: "o", element: "div", coverage: 0.15, visibleMs: 60000, state: "not_found", hasCountdown: false, timerResets: 0 })).toBeUndefined();
  });
});

describe("Feature C: suspicious prompts", () => {
  it("does not treat the words 'virus detected' alone as strong evidence", () => {
    const [draft] = promptDrafts(prompt({ text: "Our blog explains what to do when a virus detected message appears." }));
    expect(draft.severity).toBe("low");
    expect(draft.verification_status).toBe("inconclusive");
  });

  it("flags a fake system alert with an executable download and urgency", () => {
    const [draft] = promptDrafts(prompt({
      text: "WARNING! Your computer is infected with 5 viruses. Download the cleaner immediately.",
      downloadLinks: [{ file: "cleaner-setup.exe", text: "Download" }],
      isOverlay: true
    }));
    expect(draft.event_type).toBe("fake_system_alert");
    expect(draft.severity).toBe("high");
    expect(draft.claims?.find((c) => /infected/.test(c.claim))?.status).toBe("inconclusive");
  });

  it("flags a fake browser update prompt", () => {
    expect(promptDrafts(prompt({ text: "Your browser is out of date. Update Chrome now." }))[0].event_type).toBe("fake_update_prompt");
  });

  it("separates a notification lure from a plain permission request", () => {
    const lure = promptDrafts(prompt({ text: "Click Allow to continue watching", notificationRequested: true }))[0];
    expect(lure.severity).toBe("medium");
    expect(lure.confidence).toBeGreaterThan(0.8);
    const plain = promptDrafts(prompt({ text: "Inbox", notificationRequested: true }))[0];
    expect(plain.severity).toBe("informational");
  });

  it("does not flag a normal software download page", () => {
    expect(promptDrafts(prompt({ text: "Download Firefox for Windows", downloadLinks: [{ file: "Firefox Setup.exe", text: "Download" }] }))).toEqual([]);
  });
});

describe("Event engine and Feature D priority", () => {
  it("rejects malformed drafts and masks sensitive text", () => {
    expect(validateDraft({ scenario_id: 99 }).error).toBeDefined();
    expect(validateDraft({ scenario_id: "C", severity: "extreme" }).error).toBeDefined();
    const { draft } = validateDraft({ ...promptDrafts(prompt({ text: "Your computer is infected" }))[0], evidence: ["call me at bob@example.test"] });
    expect(draft?.evidence[0]).toContain("[email masked]");
  });

  it("shows a redirect as primary over eight contrast issues and a subscription term", () => {
    const page: PageEvidence = {
      url: "https://search.yahoo.com/", title: "", text: "Trial automatically renews monthly", observedAt: new Date().toISOString(),
      elements: Array.from({ length: 8 }, (_, i) => ({ tag: "p", description: `p${i}`, text: `t${i}`, contrast: 2 })),
      timers: [], formCount: 0, formsNoValidate: false
    };
    const scanEvents = detect(page).map((finding) => findingToEvent(finding, 1, "https://search.yahoo.com/"));
    const state = emptyTracker();
    processNav(state, { kind: "committed", tabId: 1, url: "https://moviesda.ski/", timestamp: Date.now() - 10, frameId: 0, transitionType: "typed", qualifiers: [] });
    const redirect = processNav(state, { kind: "committed", tabId: 1, url: "https://search.yahoo.com/", timestamp: Date.now(), frameId: 0, transitionType: "link", qualifiers: ["client_redirect"] }).event!;
    const { primary, others } = rankEvents([...scanEvents, redirect], "https://search.yahoo.com/", Date.now());
    expect(primary?.scenario_id).toBe("A");
    expect(others.length).toBe(scanEvents.length);
  });

  it("prefers a newly visible suspicious element over the same finding out of view", () => {
    const draft = promptDrafts(prompt({ text: "Click Allow to continue" }))[0];
    const hidden = eventFromDraft({ ...draft, key: "a", in_viewport: false }, 1, "p", Date.now());
    const shown = eventFromDraft({ ...draft, key: "b", in_viewport: true }, 1, "p", Date.now());
    expect(rankEvents([hidden, shown], "p", Date.now()).primary?.event_id).toBe(shown.event_id);
  });

  it("keeps severity and confidence separate", () => {
    const draft = overlayDraft({ key: "o", element: "div", coverage: 0.9, visibleMs: 10000, state: "inconclusive", hasCountdown: false, timerResets: 0 })!;
    expect(draft.severity).toBe("medium");
    expect(draft.confidence).toBeLessThan(0.5);
  });
});
