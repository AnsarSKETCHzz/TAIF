import {
  FEATURE_NAMES,
  SCENARIO_NAMES,
  type ClaimStatus,
  type FeatureId,
  type Finding,
  type PageStatus,
  type ScanRecord,
  type ScenarioId,
  type Severity,
  type TaifEvent,
  type VerificationStatus
} from "./types";
import { isSupportedUrl, maskText } from "./url";

const SEVERITIES: Severity[] = ["informational", "low", "medium", "high", "critical"];
const STATUSES: VerificationStatus[] = ["observed", "inferred", "verified", "inconclusive"];
const STATUS_STRENGTH: Record<VerificationStatus, number> = { verified: 3, observed: 2, inferred: 1, inconclusive: 0 };

export const DISMISS_TTL_MS = 30 * 60 * 1000;
const RECENT_MS = 2 * 60 * 1000;

/** Alternative explanations for the original scan scenarios, shown in the evidence panel. */
const SCAN_ALTERNATIVES: Record<number, string[]> = {
  1: ["Text may sit on an image or gradient the sampler cannot composite.", "Large or bold text has a lower 3:1 threshold."],
  2: ["The timer may restart legitimately for a new session or a new offer period."],
  3: ["Admin links are often public; the server may still enforce authorization."],
  4: ["The stock claim may be accurate."],
  5: ["Custom JavaScript or server-side validation may exist."],
  6: ["Slow network, extensions or device load may explain the timing."],
  7: ["The match may be intentionally public contact information or a false positive."],
  8: ["The control may be operable by keyboard or have an accessible name the heuristic missed."],
  9: ["Pages may refer to different variants, regions, currencies or promotions."],
  10: ["Terms may be disclosed clearly elsewhere in the flow."],
  11: ["Small or faint text may be decorative or non-essential."]
};

export function scenarioName(id: ScenarioId): string {
  return typeof id === "number" ? SCENARIO_NAMES[id - 1] ?? `Scenario ${id}` : FEATURE_NAMES[id as FeatureId];
}

/** Event-level status is the weakest supporting claim, so one verified fact never upgrades an inference. */
export function weakestStatus(claims: ClaimStatus[], fallback: VerificationStatus): VerificationStatus {
  if (!claims.length) return fallback;
  return claims.reduce((weak, item) => STATUS_STRENGTH[item.status] < STATUS_STRENGTH[weak] ? item.status : weak, claims[0].status);
}

export interface EventDraft {
  scenario_id: ScenarioId;
  event_type: string;
  key: string;
  title: string;
  summary: string;
  evidence: string[];
  element?: string;
  severity: Severity;
  confidence: number;
  verification_status: VerificationStatus;
  claims?: ClaimStatus[];
  classification: string;
  alternatives: string[];
  limitations: string;
  recommended_action: string;
  in_viewport?: boolean;
}

/** Validates an untrusted draft (e.g. from a content script) and returns a sanitized copy, or an error. */
export function validateDraft(raw: unknown): { draft?: EventDraft; error?: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Event draft must be an object." };
  const d = raw as Record<string, unknown>;
  const id = d.scenario_id;
  const validId = (typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= 11) ||
    (typeof id === "string" && id in FEATURE_NAMES);
  if (!validId) return { error: "Unknown scenario id." };
  for (const field of ["event_type", "key", "title", "summary", "classification", "limitations", "recommended_action"]) {
    if (typeof d[field] !== "string" || !(d[field] as string).trim()) return { error: `Missing ${field}.` };
  }
  if (!SEVERITIES.includes(d.severity as Severity)) return { error: "Invalid severity." };
  if (!STATUSES.includes(d.verification_status as VerificationStatus)) return { error: "Invalid verification status." };
  if (typeof d.confidence !== "number" || !Number.isFinite(d.confidence)) return { error: "Invalid confidence." };
  const strings = (value: unknown, max: number) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, max).map((item) => maskText(item).slice(0, 240))
    : [];
  const claims = Array.isArray(d.claims) ? d.claims.flatMap((item) => {
    const claim = item as Partial<ClaimStatus>;
    return typeof claim?.claim === "string" && STATUSES.includes(claim.status as VerificationStatus)
      ? [{ claim: maskText(claim.claim).slice(0, 200), status: claim.status as VerificationStatus }]
      : [];
  }).slice(0, 6) : [];
  const text = (field: string, max: number) => maskText(String(d[field])).slice(0, max);
  return {
    draft: {
      scenario_id: id as ScenarioId,
      event_type: text("event_type", 60),
      key: String(d.key).slice(0, 200),
      title: text("title", 140),
      summary: text("summary", 500),
      evidence: strings(d.evidence, 12),
      element: typeof d.element === "string" ? maskText(d.element).slice(0, 200) : undefined,
      severity: d.severity as Severity,
      confidence: Math.max(0, Math.min(1, d.confidence)),
      verification_status: d.verification_status as VerificationStatus,
      claims,
      classification: text("classification", 60),
      alternatives: strings(d.alternatives, 6),
      limitations: text("limitations", 500),
      recommended_action: text("recommended_action", 300),
      in_viewport: typeof d.in_viewport === "boolean" ? d.in_viewport : undefined
    }
  };
}

export function eventFromDraft(draft: EventDraft, tabId: number, page: string, timestamp: number): TaifEvent {
  const claims = draft.claims ?? [];
  return {
    event_id: `${draft.scenario_id}-${tabId}-${hash(`${page}|${draft.key}`)}`,
    scenario_id: draft.scenario_id,
    scenario_name: scenarioName(draft.scenario_id),
    event_type: draft.event_type,
    title: draft.title,
    summary: draft.summary,
    tab_id: tabId,
    timestamp,
    page_key: page,
    evidence: draft.evidence,
    element: draft.element,
    claims,
    severity: draft.severity,
    confidence: draft.confidence,
    verification_status: weakestStatus(claims, draft.verification_status),
    classification: draft.classification,
    alternatives: draft.alternatives,
    limitations: draft.limitations,
    recommended_action: draft.recommended_action,
    in_viewport: draft.in_viewport,
    acknowledged: false,
    occurrences: 1,
    dismiss_key: `${draft.scenario_id}|${page}|${draft.key}`
  };
}

export function findingToEvent(finding: Finding, tabId: number, page: string): TaifEvent {
  return {
    event_id: `scan-${tabId}-${finding.finding_id}`,
    scenario_id: finding.scenario_id,
    scenario_name: finding.scenario_name,
    event_type: "page_scan_finding",
    title: finding.title,
    summary: finding.summary,
    tab_id: tabId,
    timestamp: Date.parse(finding.detected_at) || Date.now(),
    page_key: page,
    evidence: [...finding.evidence, `Confidence rationale: ${finding.confidence_rationale}`],
    element: finding.affected_element_description,
    claims: [],
    severity: finding.severity,
    confidence: finding.confidence,
    verification_status: finding.verification_status,
    classification: finding.category,
    alternatives: SCAN_ALTERNATIVES[finding.scenario_id] ?? [],
    limitations: finding.limitations,
    recommended_action: finding.recommended_action,
    acknowledged: false,
    occurrences: 1,
    dismiss_key: `${finding.scenario_id}|${page}|${finding.finding_id}`
  };
}

/**
 * Inserts or updates an event. The same event_id counts as a repeat observation, not a new alert;
 * acknowledgement survives updates, and a recently dismissed dismiss_key arrives already acknowledged.
 */
export function upsertEvent(events: TaifEvent[], incoming: TaifEvent, dismissed: Record<string, number>, now: number): { events: TaifEvent[]; isNew: boolean } {
  const index = events.findIndex((event) => event.event_id === incoming.event_id);
  const dismissedAt = dismissed[incoming.dismiss_key];
  const wasDismissed = dismissedAt !== undefined && now - dismissedAt < DISMISS_TTL_MS;
  if (index >= 0) {
    const prior = events[index];
    const merged: TaifEvent = {
      ...incoming,
      timestamp: prior.timestamp,
      acknowledged: prior.acknowledged || wasDismissed,
      occurrences: prior.occurrences + (sameObservation(prior, incoming) ? 0 : 1)
    };
    const next = [...events];
    next[index] = merged;
    return { events: next, isNew: false };
  }
  const added = wasDismissed
    ? { ...incoming, acknowledged: true, evidence: [...incoming.evidence, "You dismissed this same alert recently; it is recorded but not raised again."] }
    : incoming;
  return { events: [...events, added], isNew: !wasDismissed };
}

function sameObservation(a: TaifEvent, b: TaifEvent): boolean {
  return a.title === b.title && a.summary === b.summary && a.evidence.join("|") === b.evidence.join("|");
}

const SEVERITY_WEIGHT: Record<Severity, number> = { informational: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** Priority blends severity, confidence, immediacy, relevance to the current page, viewport, and acknowledgement. */
export function priority(event: TaifEvent, currentPage: string, now: number): number {
  let score = SEVERITY_WEIGHT[event.severity] * 20 + event.confidence * 10;
  if (now - event.timestamp < RECENT_MS) score += 15;
  if (event.page_key === currentPage) score += 10;
  if (event.in_viewport) score += 8;
  if (event.scenario_id === "A") score += 12;
  if (event.acknowledged) score -= 200;
  return score;
}

export function canBePrimary(event: TaifEvent): boolean {
  return !event.acknowledged && event.severity !== "informational" && event.confidence >= 0.4;
}

export function rankEvents(events: TaifEvent[], currentPage: string, now: number): { primary?: TaifEvent; others: TaifEvent[] } {
  const ranked = [...events].sort((a, b) => priority(b, currentPage, now) - priority(a, currentPage, now));
  const primary = ranked.find(canBePrimary);
  return { primary, others: ranked.filter((event) => event !== primary) };
}

/** Worth the user's attention now. Informational notes and weak signals stay under "Details". */
export function isProblem(event: TaifEvent): boolean {
  return !event.acknowledged && event.severity !== "informational" && event.confidence >= 0.5;
}

export interface TabView {
  status: PageStatus;
  /** Every open problem on this page: redirect alerts first, then by priority. */
  problems: TaifEvent[];
  details: TaifEvent[];
  scan?: ScanRecord;
}

/** What the popup and the badge show for one tab. Shared so both always agree. */
export function buildTabView(events: TaifEvent[], scan: ScanRecord | undefined, url: string | undefined, monitor: boolean, now: number, page: string): TabView {
  const onPage = events.filter((event) => event.page_key === page);
  const ranked = [...onPage].sort((a, b) =>
    Number(b.scenario_id === "A") - Number(a.scenario_id === "A") || priority(b, page, now) - priority(a, page, now));
  const problems = ranked.filter(isProblem);
  const details = ranked.filter((event) => !isProblem(event));
  const scanForPage = scan?.page === page ? scan : undefined;
  let status: PageStatus;
  if (!isSupportedUrl(url)) status = "unsupported";
  else if (problems.length) status = "issue";
  else if (scanForPage?.status === "failed") status = "inconclusive";
  else if (scanForPage?.status === "done") status = "clean";
  else status = monitor ? "monitoring" : "permission";
  return { status, problems, details, scan: scanForPage };
}

export function hash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
