import {
  type Finding,
  type PageEvidence,
  type Severity,
  type StoredTimer,
  type TimerObservation,
  SCENARIO_NAMES
} from "./types";

type Detector = (page: PageEvidence) => Finding[];

const LIMITATIONS: Record<number, string> = {
  1: "Contrast is measured on sampled visible text against its nearest solid background. Text on images or gradients is skipped. A missing dark theme is never treated as a problem.",
  2: "Only countdowns shown while TAIF watched the page, or seen on earlier visits, are compared. A restarting timer is a strong signal, not proof that the deadline is fake.",
  3: "A browser extension cannot see server-side access rules. No admin route is probed or opened.",
  4: "Page text cannot reveal real inventory. Restocks and per-variant stock can explain changing numbers.",
  5: "Only the form's markup is inspected. Server-side checks may exist; no form is submitted.",
  6: "Measured on this one visit in this browser. It is not a server load test and does not show server capacity.",
  7: "Pattern matching cannot tell whether a value is real, revoked or intentionally public. Values are masked and never stored.",
  8: "Automated checks do not replace keyboard and screen-reader testing.",
  9: "Only pages you explicitly selected are compared. Different variants, regions, taxes or promotions can explain different prices.",
  10: "This is not a legal assessment. The full terms may be clearer elsewhere in the checkout.",
  11: "Visual weight alone does not prove intent; context matters. Only choices shown together are compared."
};

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}

function makeFinding(
  page: PageEvidence,
  scenario: number,
  input: {
    /** Stable identity, so acknowledging a finding survives a rescan. */
    key: string;
    title: string;
    summary: string;
    evidence: string[];
    element?: string;
    severity: Severity;
    confidence: number;
    verification?: Finding["verification_status"];
    action: string;
  }
): Finding {
  return {
    finding_id: `s${scenario}-${slug(input.key)}`,
    scenario_id: scenario,
    scenario_name: SCENARIO_NAMES[scenario - 1],
    category: SCENARIO_NAMES[scenario - 1],
    severity: input.severity,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    confidence_rationale: input.verification === "inconclusive"
      ? "Confidence is intentionally conservative because the page alone cannot verify the underlying claim."
      : input.verification === "inferred"
        ? "Several observed signals point the same way, but they cannot establish intent."
        : "The measured page state was directly observed; confidence is limited by sampling and plausible alternative explanations.",
    title: input.title,
    summary: input.summary,
    evidence: input.evidence.map(masked),
    affected_element_description: input.element ?? "Page-level observation",
    page_url: redactUrl(page.url),
    detected_at: page.observedAt,
    recommended_action: input.action,
    limitations: LIMITATIONS[scenario],
    verification_status: input.verification ?? "observed"
  };
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function masked(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number masked]")
    .replace(/\b(?:sk|pk|api|key)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[key-like value masked]");
}

function quote(text: string, max = 48): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `"${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}"`;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function minutesAgo(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "moments";
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/**
 * True when a countdown seen earlier shows more time now than it could have left, i.e. it was
 * restarted between the two observations. Shared with the service worker, which keeps the history.
 */
export function timerRestarted(previous: StoredTimer, current: TimerObservation, nowMs: number): boolean {
  if (current.seconds === undefined) return false;
  const elapsed = (nowMs - previous.at) / 1000;
  if (elapsed < 3) return false;
  const expected = previous.seconds - elapsed;
  return current.seconds > expected + Math.max(10, previous.seconds * 0.1);
}

const URGENCY = /\b(?:hurry|ends? (?:soon|in|today)|last chance|limited time|don'?t miss|only today|expires?|offer ends|deal ends|sale ends|before it'?s gone)\b/i;

const detectors: Detector[] = [
  // 1 · Readability, including dark mode
  (page) => {
    const failing = page.elements
      .filter((element) => element.contrast !== undefined && !element.backgroundImage && element.text.trim().length >= 3)
      .filter((element) => element.contrast! < (element.large ? 3 : 4.5))
      .sort((a, b) => a.contrast! - b.contrast!);
    if (!failing.length) return [];
    const controls = failing.filter((element) => element.interactive);
    const severe = failing.filter((element) => element.contrast! < 3);
    const dark = page.darkMode?.preferred && page.darkMode.pageIsDark;
    // A single slightly-low paragraph is not worth an alert.
    if (!controls.length && !severe.length && failing.length < 3) return [];
    return [makeFinding(page, 1, {
      key: "readability",
      title: dark ? "Text is hard to read in dark mode" : controls.length ? "Buttons or links are hard to read" : "Some text is hard to read",
      summary: `${failing.length} visible text element${failing.length === 1 ? " falls" : "s fall"} below the WCAG contrast minimum` +
        (controls.length ? `, including ${controls.length} button/link/label${controls.length === 1 ? "" : "s"}.` : ".") +
        (page.darkMode ? page.darkMode.supported ? " The site does offer a dark theme." : " The site has no dark theme; that alone is not a problem." : ""),
      evidence: failing.slice(0, 4).map((element) =>
        `${quote(element.text)} (${element.tag}${element.interactive ? ", control" : ""}): ${element.contrast!.toFixed(2)}:1, needs ${element.large ? 3 : 4.5}:1 — ${element.foreground} on ${element.background}`),
      element: failing[0].description,
      severity: controls.length || severe.length >= 3 ? "medium" : "low",
      confidence: 0.8,
      action: "Zoom in, use your browser's reader mode, or turn on TAIF's readability adaptation."
    })];
  },

  // 2 · Fake versus genuine urgency
  (page) => {
    const previous = new Map((page.previousTimers ?? []).map((timer) => [timer.key, timer]));
    const now = Date.parse(page.observedAt);
    const findings: Finding[] = [];
    for (const timer of page.timers) {
      const prior = previous.get(timer.key);
      if (!prior || !timerRestarted(prior, timer, now)) continue;
      const total = prior.restarts + 1;
      const elapsed = now - prior.at;
      const shouldHaveEnded = prior.seconds - elapsed / 1000 <= 0;
      const urgent = timer.context ? URGENCY.exec(timer.context)?.[0] : undefined;
      findings.push(makeFinding(page, 2, {
        key: `timer-${timer.key}`,
        title: total >= 2 ? `Countdown restarts every visit (${total} times)` : "Countdown restarted when you came back",
        summary: `${minutesAgo(elapsed)} ago this countdown showed ${clock(prior.seconds)}. ` +
          (shouldHaveEnded ? "It should have ended by now" : `It should now show at most ${clock(prior.seconds - elapsed / 1000)}`) +
          `, but it shows ${clock(timer.seconds!)}. The deadline is probably not real.`,
        evidence: [
          `Earlier: ${clock(prior.seconds)} · now: ${clock(timer.seconds!)} · time between: ${minutesAgo(elapsed)}`,
          `Restarts seen so far: ${total}`,
          ...(urgent ? [`Urgency wording next to it: ${quote(urgent)}`] : [])
        ],
        element: timer.text ? `countdown ${quote(timer.text, 24)}` : "countdown",
        severity: total >= 2 || shouldHaveEnded ? "medium" : "low",
        confidence: total >= 2 ? 0.8 : 0.65,
        verification: total >= 2 ? "observed" : "inferred",
        action: "Ignore the timer. Compare the price elsewhere or come back later; the offer will very likely still be there."
      }));
    }
    return findings;
  },

  // 3 · Exposed admin areas (indicator only)
  (page) => {
    const adminPath = /\/(?:admin|administrator|wp-admin|manage|dashboard)(?:\/|$)/i.test(safePath(page.url));
    const controls = page.adminControls ?? 0;
    if (!adminPath || !controls) {
      if (!controls) return [];
      return [makeFinding(page, 3, {
        key: "admin-links",
        title: "Admin links are visible",
        summary: "The page shows links to an admin area. That is common and does not mean the area is unprotected.",
        evidence: [`${controls} visible admin-related control(s).`],
        severity: "informational",
        confidence: 0.4,
        verification: "inconclusive",
        action: "No action needed as a visitor."
      })];
    }
    return [makeFinding(page, 3, {
      key: "admin-page",
      title: "Admin controls are showing on this page",
      summary: "You are on an admin-style address and admin controls are visible. If you are not signed in as an admin, this site may not be protecting its admin area. TAIF cannot verify this.",
      evidence: [`Path looks like an admin route: ${safePath(page.url)}`, `${controls} visible admin-related control(s).`],
      severity: "low",
      confidence: 0.45,
      verification: "inconclusive",
      action: "Don't change anything here. If this is your site, check server-side authorization for every admin endpoint."
    })];
  },

  // 4 · Misleading scarcity
  (page) => {
    const claims = page.claims ?? [];
    if (!claims.length) return [];
    const history = page.previousClaims ?? [];
    const now = Date.parse(page.observedAt);
    const current = claims.find((claim) => claim.count !== undefined) ?? claims[0];
    const earlier = history.filter((item) => now - item.at > 60_000);
    const increased = earlier.find((item) => item.count !== undefined && current.count !== undefined && current.count > item.count);
    const sameClaims = earlier.filter((item) => item.text.toLowerCase() === current.text.toLowerCase());
    const span = sameClaims.length ? now - Math.min(...sameClaims.map((item) => item.at)) : 0;

    if (increased) {
      return [makeFinding(page, 4, {
        key: "scarcity-increase",
        title: "\"Only a few left\" count went up",
        summary: `Earlier this page said ${quote(increased.text)}; now it says ${quote(current.text)}. Stock rising while the page still pushes scarcity suggests the claim may not reflect real inventory.`,
        evidence: [`Earlier (${minutesAgo(now - increased.at)} ago): ${quote(increased.text)}`, `Now: ${quote(current.text)}`],
        severity: "low",
        confidence: 0.6,
        verification: "inferred",
        action: "Don't rush. A restock is possible, so treat the stock message as marketing."
      })];
    }
    if (sameClaims.length >= 2 && span >= 6 * 3600_000) {
      return [makeFinding(page, 4, {
        key: "scarcity-constant",
        title: "Same \"only a few left\" message on every visit",
        summary: `${quote(current.text)} has been shown on ${sameClaims.length + 1} visits over ${minutesAgo(span)}. Real low stock usually changes or sells out.`,
        evidence: [`Seen ${sameClaims.length + 1} times`, `First seen ${minutesAgo(span)} ago`],
        severity: "medium",
        confidence: 0.65,
        verification: "inferred",
        action: "Treat the stock message as marketing, not as a reason to buy now."
      })];
    }
    return [makeFinding(page, 4, {
      key: "scarcity-claim",
      title: "Stock message shown",
      summary: `The page says ${quote(current.text)}. TAIF cannot check real inventory; it will flag it if the message behaves suspiciously on later visits.`,
      evidence: claims.slice(0, 3).map((claim) => quote(claim.text)),
      severity: "informational",
      confidence: 0.4,
      verification: "inconclusive",
      action: "No action needed."
    })];
  },

  // 5 · Insufficient verification on forms that collect personal data
  (page) => {
    const weak = (page.forms ?? []).filter((form) => form.sensitive.length && (form.novalidate || !form.validated));
    if (!weak.length) return [];
    const form = weak[0];
    return [makeFinding(page, 5, {
      key: `form-${form.description}`,
      title: "Form asks for personal data without input checks",
      summary: `A form collecting ${form.sensitive.join(", ")} ${form.novalidate ? "turns off the browser's built-in checks" : "has no required/format checks"}. Mistyped details may be accepted silently. Server-side checks may still exist.`,
      evidence: weak.slice(0, 3).map((item) => `${item.description}: collects ${item.sensitive.join(", ")}${item.novalidate ? " · novalidate" : ""}${item.validated ? "" : " · no required/pattern/type checks"}`),
      element: form.description,
      severity: form.sensitive.includes("payment") || form.sensitive.includes("password") ? "medium" : "low",
      confidence: 0.5,
      verification: "inconclusive",
      action: "Double-check what you type before submitting. No form was submitted by TAIF."
    })];
  },

  // 6 · Page performance (never a load test)
  (page) => {
    const nav = page.navigation;
    if (!nav) return [];
    const slow = nav.loadMs !== undefined && nav.loadMs >= 5000;
    const janky = (nav.longTasks ?? 0) >= 5;
    const broken = (nav.failedResources ?? 0) >= 3;
    if (!slow && !janky && !broken) return [];
    return [makeFinding(page, 6, {
      key: "performance",
      title: slow ? "Page was slow to load" : janky ? "Page is freezing up" : "Parts of the page failed to load",
      summary: [
        slow ? `It took ${(nav.loadMs! / 1000).toFixed(1)} s to finish loading.` : "",
        janky ? `The page blocked the browser ${nav.longTasks} times for over 50 ms.` : "",
        broken ? `${nav.failedResources} files failed to load.` : ""
      ].filter(Boolean).join(" ") + " This describes your visit, not the server's capacity.",
      evidence: [
        nav.loadMs !== undefined ? `Load time: ${Math.round(nav.loadMs)} ms` : "",
        nav.longTasks !== undefined ? `Long tasks: ${nav.longTasks}` : "",
        nav.failedResources !== undefined ? `Failed resources: ${nav.failedResources}` : "",
        `Resources loaded: ${nav.resourceCount ?? 0}`
      ].filter(Boolean),
      severity: "low",
      confidence: 0.85,
      action: "If the page misbehaves, reload it or try again later."
    })];
  },

  // 7 · Sensitive information: only secret-like values are a problem
  (page) => {
    const secrets: [string, RegExp][] = [
      ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
      ["Stripe live key", /\b[sr]k_live_[0-9a-zA-Z]{20,}\b/],
      ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
      ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
      ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
      ["Private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
      ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/]
    ];
    const found = secrets.filter(([, pattern]) => pattern.test(page.text)).map(([name]) => name);
    if (found.length) {
      return [makeFinding(page, 7, {
        key: "secrets",
        title: "Possible secret key visible on the page",
        summary: `The visible page text contains something shaped like ${found.join(", ")}. If real, anyone visiting can copy it.`,
        evidence: found.map((name) => `${name}: [value masked]`),
        severity: "high",
        confidence: 0.7,
        verification: "inferred",
        action: "Don't copy or use it. If this is your site, revoke the key and remove it from the page."
      })];
    }
    const emails = page.text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    if (!emails.length) return [];
    return [makeFinding(page, 7, {
      key: "contact-details",
      title: "Contact details are shown",
      summary: "Email addresses appear on the page. This is normal for contact pages and is not treated as a problem.",
      evidence: [`${emails.length} email address(es), masked`],
      severity: "informational",
      confidence: 0.4,
      verification: "inferred",
      action: "No action needed."
    })];
  },

  // 8 · Accessibility barriers for motor disabilities
  (page) => {
    const a11y = page.accessibility ?? {
      unlabeled: page.elements.filter((element) => element.interactive && element.hasLabel === false).map((element) => element.description),
      smallTargets: page.elements
        .filter((element) => element.interactive && element.tag !== "a" && (element.width ?? 99) < 24 && (element.height ?? 99) < 24)
        .map((element) => element.description),
      focusSuppressed: false,
      imageLinksWithoutAlt: 0
    };
    const problems = [
      a11y.unlabeled.length ? `${a11y.unlabeled.length} control(s) have no accessible name (e.g. ${a11y.unlabeled.slice(0, 2).join(", ")})` : "",
      a11y.smallTargets.length ? `${a11y.smallTargets.length} control(s) are smaller than 24×24 px (e.g. ${a11y.smallTargets.slice(0, 2).join(", ")})` : "",
      a11y.focusSuppressed ? "The site's CSS removes the keyboard focus outline without a replacement" : "",
      a11y.imageLinksWithoutAlt ? `${a11y.imageLinksWithoutAlt} image link(s) have no text alternative` : ""
    ].filter(Boolean);
    if (!problems.length) return [];
    return [makeFinding(page, 8, {
      key: "accessibility",
      title: "Hard to use without a precise mouse",
      summary: `${problems.length} kind${problems.length === 1 ? "" : "s"} of accessibility barrier found. They make the page harder to use with a keyboard, switch device or unsteady hands.`,
      evidence: problems,
      severity: problems.length >= 3 || a11y.focusSuppressed ? "medium" : "low",
      confidence: 0.75,
      action: "Turn on TAIF's larger targets and focus outline adaptations (Dashboard & settings), or run the full accessibility audit."
    })];
  },

  // 9 · Conflicting information across pages (user-selected)
  (page) => {
    const previous = page.previousPage;
    if (!previous) return [];
    const sameProduct = (page.product?.sku && previous.sku && page.product.sku === previous.sku) ||
      similarity(page.product?.name ?? page.title, previous.name ?? previous.title) >= 0.8;
    if (!sameProduct) return [];
    const current = prices(page.text);
    const prior = prices(previous.text);
    if (!current.length || !prior.length) return [];
    const currencies = new Set([...current, ...prior].map((price) => price.currency));
    if (currencies.size > 1) {
      return [makeFinding(page, 9, {
        key: "price-currency",
        title: "Same product, different currencies",
        summary: "The two pages show prices in different currencies, so they can't be compared directly.",
        evidence: [`This page: ${current.slice(0, 3).map((price) => price.raw).join(", ")}`, `Selected page: ${prior.slice(0, 3).map((price) => price.raw).join(", ")}`],
        severity: "informational",
        confidence: 0.5,
        verification: "inferred",
        action: "Convert the prices or check the region settings."
      })];
    }
    const low = Math.min(...current.map((price) => price.amount));
    const priorLow = Math.min(...prior.map((price) => price.amount));
    if (Math.abs(low - priorLow) < 0.01) return [];
    return [makeFinding(page, 9, {
      key: "price-conflict",
      title: "Same product, different price",
      summary: `This page's lowest price is ${current.find((price) => price.amount === low)!.raw}, but the page you selected shows ${prior.find((price) => price.amount === priorLow)!.raw} for what looks like the same product.`,
      evidence: [
        `This page: ${current.slice(0, 3).map((price) => price.raw).join(", ")}`,
        `Selected page (${previous.title || previous.url}): ${prior.slice(0, 3).map((price) => price.raw).join(", ")}`,
        page.product?.sku && previous.sku ? `Matched by product code ${page.product.sku}` : "Matched by product name"
      ],
      severity: "low",
      confidence: page.product?.sku && previous.sku ? 0.75 : 0.55,
      verification: "inferred",
      action: "Check variant, size, region and promotions; then buy where the price is lower."
    })];
  },

  // 10 · Hidden subscription consequences
  (page) => {
    const sub = page.subscription;
    if (!sub?.action || !sub.terms.length) return [];
    const action = sub.action;
    const hidden = sub.terms.filter((term) =>
      term.fontSize < action.fontSize * 0.75 || (term.contrast !== undefined && term.contrast < 4.5) || term.distance > 600);
    if (!hidden.length) {
      return [makeFinding(page, 10, {
        key: "subscription-terms",
        title: "Subscription terms are shown",
        summary: `Recurring-billing terms appear near ${quote(action.text, 30)} and are readable.`,
        evidence: sub.terms.slice(0, 2).map((term) => quote(term.text, 90)),
        severity: "informational",
        confidence: 0.6,
        action: "Read the terms before continuing."
      })];
    }
    const term = hidden[0];
    const reasons = [
      term.fontSize < action.fontSize * 0.75 ? `smaller text (${Math.round(term.fontSize)}px vs ${Math.round(action.fontSize)}px on the button)` : "",
      term.contrast !== undefined && term.contrast < 4.5 ? `faint (${term.contrast.toFixed(1)}:1 contrast)` : "",
      term.distance > 600 ? `${Math.round(term.distance)}px away from the button` : ""
    ].filter(Boolean);
    return [makeFinding(page, 10, {
      key: "subscription-hidden",
      title: "Subscription terms are easy to miss",
      summary: `Next to ${quote(action.text, 30)}, the page says ${quote(term.text, 90)} — but it is ${reasons.join(", ")}.`,
      evidence: hidden.slice(0, 3).map((item) => `${quote(item.text, 90)} · ${Math.round(item.fontSize)}px · ${Math.round(item.distance)}px from the button`),
      element: `near ${quote(action.text, 30)}`,
      severity: hidden.length > 1 || term.distance > 600 ? "medium" : "low",
      confidence: 0.7,
      action: "Read these terms before you continue; note the renewal date and how to cancel."
    })];
  },

  // 11 · Misleading visual emphasis between choices shown together
  (page) => {
    const findings: Finding[] = [];
    for (const pair of page.choicePairs ?? []) {
      const { positive, negative } = pair;
      const sizeRatio = negative.area > 0 ? positive.area / negative.area : 99;
      const reasons = [
        sizeRatio >= 3 ? `${quote(positive.text, 24)} is ${sizeRatio.toFixed(1)}× bigger` : "",
        negative.contrast !== undefined && negative.contrast < 3 ? `${quote(negative.text, 24)} is faint (${negative.contrast.toFixed(1)}:1)` : "",
        negative.opacity < 0.5 ? `${quote(negative.text, 24)} is see-through (opacity ${negative.opacity.toFixed(2)})` : "",
        negative.fontSize < 11 ? `${quote(negative.text, 24)} uses ${Math.round(negative.fontSize)}px text` : ""
      ].filter(Boolean);
      // One difference is normal design; several together steer the choice.
      if (reasons.length < 2) continue;
      findings.push(makeFinding(page, 11, {
        key: `choice-${positive.text}-${negative.text}`,
        title: `"${negative.text.trim().slice(0, 24)}" option is made hard to see`,
        summary: `${quote(positive.text, 24)} and ${quote(negative.text, 24)} are offered together, but ${reasons.join("; ")}. This nudges you toward one choice.`,
        evidence: [
          `${quote(positive.text, 24)}: ${Math.round(positive.area)}px², ${positive.contrast?.toFixed(1) ?? "?"}:1, opacity ${positive.opacity.toFixed(2)}`,
          `${quote(negative.text, 24)}: ${Math.round(negative.area)}px², ${negative.contrast?.toFixed(1) ?? "?"}:1, opacity ${negative.opacity.toFixed(2)}`
        ],
        element: pair.container,
        severity: reasons.length >= 3 ? "medium" : "low",
        confidence: 0.65,
        verification: "inferred",
        action: `${quote(negative.text, 24)} is a real option — choose it if that's what you want.`
      }));
    }
    return findings;
  }
];

function safePath(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return "";
  }
}

const CURRENCY: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

export function prices(text: string): { raw: string; amount: number; currency: string }[] {
  const pattern = /(?:([$€£₹¥]|USD|EUR|GBP|INR|Rs\.?)\s?(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?))|(?:(\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(USD|EUR|GBP|INR))/gi;
  return [...text.matchAll(pattern)].slice(0, 30).map((match) => {
    const symbol = (match[1] ?? match[4] ?? "").replace(/\.$/, "");
    const number = (match[2] ?? match[3] ?? "").replace(/\s/g, "");
    const decimal = /[.,]\d{1,2}$/.test(number) ? number.slice(number.search(/[.,]\d{1,2}$/) + 1) : "";
    const whole = (decimal ? number.slice(0, number.length - decimal.length - 1) : number).replace(/[.,]/g, "");
    const currency = CURRENCY[symbol] ?? (/^rs$/i.test(symbol) ? "INR" : symbol.toUpperCase());
    return { raw: match[0].trim(), amount: Number(`${whole}.${decimal || "0"}`), currency };
  }).filter((price) => Number.isFinite(price.amount) && price.amount > 0);
}

/** Word-overlap similarity of two product names (0–1). */
export function similarity(a: string, b: string): number {
  const words = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1));
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return 0;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(left.size, right.size);
}

export function detect(page: PageEvidence): Finding[] {
  return detectors.flatMap((detector) => detector(page));
}

export const detectorCount = detectors.length;
