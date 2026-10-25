import type { EventDraft } from "./events";

/**
 * Pure analysis for the live monitor (features B and C, live scenario 2). The content script
 * extracts DOM snapshots; these functions decide whether the evidence justifies an event.
 */

export interface TimerSample { t: number; seconds: number }

export interface TimerAnalysis {
  resets: number;
  observedMs: number;
  counting: boolean;
  lowest: number;
  highest: number;
}

/** A reset is the countdown jumping up by 3s+ after it had been counting down. */
export function analyzeTimer(samples: TimerSample[]): TimerAnalysis {
  let resets = 0;
  let decreasing = false;
  for (let i = 1; i < samples.length; i += 1) {
    const delta = samples[i].seconds - samples[i - 1].seconds;
    if (delta < 0) decreasing = true;
    else if (delta >= 3 && decreasing) {
      resets += 1;
      decreasing = false;
    }
  }
  const values = samples.map((sample) => sample.seconds);
  return {
    resets,
    observedMs: samples.length > 1 ? samples[samples.length - 1].t - samples[0].t : 0,
    counting: decreasing || resets > 0,
    lowest: values.length ? Math.min(...values) : 0,
    highest: values.length ? Math.max(...values) : 0
  };
}

export function parseCountdown(text: string): number | undefined {
  const clock = text.match(/(?:^|\D)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:\D|$)/);
  if (clock) {
    return clock[3] ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) : Number(clock[1]) * 60 + Number(clock[2]);
  }
  const words = text.match(/\b(?:in|wait|after)?\s*(\d{1,3})\s*(?:s|sec|secs|seconds?)\b/i);
  return words ? Number(words[1]) : undefined;
}

export function timerDraft(key: string, element: string, analysis: TimerAnalysis, inViewport: boolean): EventDraft | undefined {
  if (analysis.resets === 0) return;
  const repeated = analysis.resets >= 2;
  return {
    scenario_id: 2,
    event_type: "countdown_reset",
    key: `timer|${key}`,
    title: repeated ? `Countdown reset ${analysis.resets} times` : "Countdown reset observed",
    summary: repeated
      ? "This countdown restarted repeatedly while you watched. Repeated resets suggest the deadline may not be real."
      : "This countdown jumped back up after counting down. One reset can have an ordinary explanation.",
    evidence: [
      `Observed for ${Math.round(analysis.observedMs / 1000)}s; values ranged ${analysis.lowest}s – ${analysis.highest}s.`,
      `Resets observed: ${analysis.resets}.`
    ],
    element,
    severity: repeated ? "medium" : "low",
    confidence: repeated ? 0.75 : 0.5,
    verification_status: "observed",
    claims: [
      { claim: "Countdown value increased after decreasing", status: "observed" },
      { claim: "Deadline is fake", status: repeated ? "inferred" : "inconclusive" }
    ],
    classification: repeated ? "Repeated countdown reset" : "Single countdown reset",
    alternatives: ["The offer may legitimately restart per session or per item.", "The page may have reloaded the widget."],
    limitations: "Only the time this page was open is observed; server-side deadlines are not visible.",
    recommended_action: "Don't let the timer rush your decision; check whether the deadline is stated anywhere else.",
    in_viewport: inViewport
  };
}

export type CloseState = "visible" | "obscured" | "disabled" | "hidden" | "not_found" | "inconclusive";

export interface CloseCandidate { disabled: boolean; hidden: boolean; obscured: boolean }

/** Best available state across close-like controls found inside an overlay. */
export function closeState(candidates: CloseCandidate[], hasCrossOriginFrame: boolean): CloseState {
  if (candidates.some((c) => !c.disabled && !c.hidden && !c.obscured)) return "visible";
  if (candidates.some((c) => !c.hidden && c.disabled)) return "disabled";
  if (candidates.some((c) => !c.hidden && c.obscured)) return "obscured";
  if (candidates.length) return "hidden";
  return hasCrossOriginFrame ? "inconclusive" : "not_found";
}

export interface OverlayObservation {
  key: string;
  element: string;
  coverage: number;
  visibleMs: number;
  state: CloseState;
  /** ms after the overlay appeared at which a usable close control was first observed. */
  closeAvailableAfterMs?: number;
  hasCountdown: boolean;
  timerResets: number;
}

const BLOCKING_MS = 8000;

export function overlayDraft(o: OverlayObservation): EventDraft | undefined {
  if (o.coverage < 0.4) return;
  const base = {
    scenario_id: "B" as const,
    key: `overlay|${o.key}`,
    element: o.element,
    in_viewport: true,
    limitations: "Close controls inside cross-origin frames or closed shadow DOM cannot be inspected. Timing covers only what was observed while the page was open."
  };
  const coverage = `Overlay covers about ${Math.round(o.coverage * 100)}% of the visible window.`;

  if (o.closeAvailableAfterMs !== undefined) {
    const wait = Math.round(o.closeAvailableAfterMs / 1000);
    if (o.timerResets >= 1) {
      return {
        ...base, event_type: "delayed_close_with_resets",
        title: "Close button delayed by a resetting countdown",
        summary: `The close control appeared after ${wait}s, and the countdown reset ${o.timerResets} time(s) while waiting.`,
        evidence: [coverage, `Close control usable after ${wait}s (observed).`, `Countdown resets: ${o.timerResets}.`],
        severity: "medium", confidence: 0.72, verification_status: "observed",
        claims: [{ claim: "Close control was delayed", status: "observed" }, { claim: "Waiting was extended deliberately", status: "inferred" }],
        classification: "Obstructive waiting interface",
        alternatives: ["The ad network may restart the countdown when the ad changes."],
        recommended_action: "Use the close control now that it is available, or leave the page."
      };
    }
    if (wait <= 15) return;
    return {
      ...base, event_type: "delayed_close",
      title: `Close button appeared after ${wait}s`,
      summary: `This overlay could not be closed for ${wait}s. Long forced waits keep you on content you did not choose.`,
      evidence: [coverage, `Close control usable after ${wait}s (observed).`, o.hasCountdown ? "A countdown was shown." : "No countdown was shown."],
      severity: "low", confidence: 0.6, verification_status: "observed",
      claims: [{ claim: "Close control was unavailable while waiting", status: "observed" }],
      classification: "Long forced wait",
      alternatives: ["Some video ads legitimately require a fixed viewing time."],
      recommended_action: "The overlay can be closed now."
    };
  }

  if (o.state === "visible" || o.visibleMs < BLOCKING_MS) return;
  const stateText: Record<Exclude<CloseState, "visible">, string> = {
    obscured: "A close control exists but is covered by another element.",
    disabled: "A close control exists but is disabled.",
    hidden: "A close control exists but is hidden or too small to use.",
    not_found: "No close or dismiss control was found in the inspected content.",
    inconclusive: "No close control was found, but part of the overlay is a cross-origin frame TAIF cannot inspect."
  };
  return {
    ...base, event_type: "blocked_dismissal",
    title: o.state === "inconclusive" ? "Overlay may be hard to close" : "Overlay without a usable close button",
    summary: `A large overlay has blocked the page for more than ${BLOCKING_MS / 1000}s. ${stateText[o.state]}`,
    evidence: [coverage, stateText[o.state], o.hasCountdown ? "A countdown is shown; it may unlock the close button later." : "No countdown is shown."],
    severity: "medium",
    confidence: o.state === "inconclusive" ? 0.4 : o.state === "not_found" ? 0.55 : 0.68,
    verification_status: o.state === "inconclusive" ? "inconclusive" : "observed",
    claims: [{ claim: "Overlay blocks the page", status: "observed" }, { claim: "Dismissal is obstructed", status: o.state === "inconclusive" ? "inconclusive" : "inferred" }],
    classification: "Obstructed dismissal",
    alternatives: ["A consent or age gate may require a choice by design.", "Pressing Escape or clicking outside may close it."],
    recommended_action: "Try Escape or the browser Back button. Don't click unknown buttons inside the overlay."
  };
}

/* ---------------- Feature C: suspicious system-alert, download and notification prompts ---------------- */

const SYSTEM_ALERT = /\b(?:your (?:computer|device|pc|phone|mac|system|iphone|android) (?:is|has been|may be) (?:infected|compromised|hacked|at risk|damaged)|\d+\s+(?:viruses|virus|threats|trojans?) (?:found|detected)|virus(?:es)? (?:detected|found)|(?:windows|microsoft|apple|mac|google|chrome) (?:defender |security )?(?:alert|warning)|security (?:alert|warning)!|call (?:microsoft|apple|windows|technical) support)\b/i;
const FAKE_UPDATE = /\b(?:your (?:browser|chrome|firefox|flash player|video player|software) (?:is|may be) (?:out of date|outdated)|update (?:your )?(?:chrome|browser|flash|video player) (?:now|immediately)|critical (?:security )?update required)\b/i;
const NOTIFY_LURE = /\b(?:(?:click|tap|press)\s+["“']?allow["”']?\s+to\s+(?:continue|watch|play|verify|confirm|download|access|prove|see)|(?:click|tap)\s+["“']?allow["”']?\s+(?:if|to confirm)\s+you\s+are\s+not\s+a\s+robot|allow notifications to (?:continue|watch|proceed))\b/i;
const URGENCY = /\b(?:immediately|right now|urgent|within \d+ (?:minutes?|seconds?)|do not (?:close|restart|ignore))\b/i;
const RISKY_EXT = /\.(?:exe|msi|scr|bat|cmd|vbs|ps1|apk|dmg|pkg|jar|hta)$/i;

export interface PromptInput {
  key: string;
  element: string;
  text: string;
  downloadLinks: { file: string; text: string }[];
  notificationRequested: boolean;
  isOverlay: boolean;
  inViewport: boolean;
}

export function isRiskyDownload(file: string): boolean {
  return RISKY_EXT.test(file.split(/[?#]/)[0]);
}

export function promptDrafts(input: PromptInput): EventDraft[] {
  const drafts: EventDraft[] = [];
  const text = input.text.slice(0, 4000);
  const systemAlert = text.match(SYSTEM_ALERT)?.[0];
  const fakeUpdate = text.match(FAKE_UPDATE)?.[0];
  const lure = text.match(NOTIFY_LURE)?.[0];
  const urgent = URGENCY.test(text);
  const risky = input.downloadLinks.filter((link) => isRiskyDownload(link.file));
  const common = {
    scenario_id: "C" as const,
    element: input.element,
    in_viewport: input.inViewport,
    limitations: "Text patterns cannot prove intent, and TAIF does not scan downloaded files. Genuine browser and security-software warnings appear outside the web page."
  };

  if (systemAlert || fakeUpdate) {
    const phrase = (systemAlert ?? fakeUpdate)!;
    const supports = [
      risky.length ? `Download link for ${risky[0].file} nearby.` : "",
      urgent ? "Urgent wording is present." : "",
      input.isOverlay ? "Shown in a page overlay, not a browser dialog." : ""
    ].filter(Boolean);
    const strong = supports.length >= 2 || (risky.length > 0 && (urgent || input.isOverlay));
    drafts.push({
      ...common,
      event_type: systemAlert ? "fake_system_alert" : "fake_update_prompt",
      key: `prompt|${input.key}|${systemAlert ? "alert" : "update"}`,
      title: strong ? "Web page imitating a system warning" : "Unverified security warning on this page",
      summary: strong
        ? `This page shows "${phrase}" with ${supports.length} pressure signals. Real device and browser warnings do not appear inside web pages.`
        : `This page shows "${phrase}". This is page content, not a warning from your browser or device, and was not verified.`,
      evidence: [`Matched text: "${phrase}"`, ...supports],
      severity: strong ? "high" : "low",
      confidence: strong ? 0.78 : 0.4,
      verification_status: strong ? "inferred" : "inconclusive",
      claims: [
        { claim: "Warning text is web page content", status: "observed" },
        { claim: "Your device is infected or outdated", status: "inconclusive" }
      ],
      classification: strong ? "Webpage imitation of a system warning" : "Unverified suspicious message",
      alternatives: ["A security-news or support article may quote such warnings.", "A genuine security product shows warnings in its own window."],
      recommended_action: "Don't download, call numbers, or allow permissions from this page. Close the tab if you can't leave it normally."
    });
  } else if (risky.length && urgent) {
    drafts.push({
      ...common,
      event_type: "urgent_download",
      key: `prompt|${input.key}|download`,
      title: "Urgent prompt to download software",
      summary: `The page urges you to download ${risky[0].file}. Program files from unexpected prompts are a common malware route.`,
      evidence: risky.slice(0, 3).map((link) => `Download link: ${link.file}${link.text ? ` ("${link.text.slice(0, 60)}")` : ""}`),
      severity: "medium", confidence: 0.6, verification_status: "inferred",
      claims: [{ claim: "Executable download link with urgent wording", status: "observed" }, { claim: "File is harmful", status: "inconclusive" }],
      classification: "Unexpected download prompt",
      alternatives: ["This may be a legitimate software download page."],
      recommended_action: "Only download software from the publisher's official site."
    });
  }

  if (lure || input.notificationRequested) {
    drafts.push({
      ...common,
      event_type: "notification_lure",
      key: `prompt|${input.key}|notify`,
      title: lure ? "Page pressures you to allow notifications" : "Page asked for notification permission",
      summary: lure
        ? `The page says "${lure}". Sites use this trick to get permission to send spam or scam notifications.`
        : "The page called the notification permission API. This can be legitimate (e.g. chat or email sites).",
      evidence: [lure ? `Matched text: "${lure}"` : "", input.notificationRequested ? "Notification permission request observed." : ""].filter(Boolean),
      severity: lure ? "medium" : "informational",
      confidence: lure && input.notificationRequested ? 0.85 : lure ? 0.65 : 0.9,
      verification_status: input.notificationRequested ? "observed" : "inferred",
      claims: [
        ...(input.notificationRequested ? [{ claim: "Permission request made", status: "observed" as const }] : []),
        ...(lure ? [{ claim: "Allow is presented as required to continue", status: "observed" as const }] : [])
      ],
      classification: lure ? "Notification permission lure" : "Notification permission request",
      alternatives: ["Messaging, email and calendar sites legitimately ask for notifications."],
      recommended_action: lure ? "Choose Block. You never need to allow notifications to watch or download something." : "Allow only if you want alerts from this site."
    });
  }
  return drafts;
}
