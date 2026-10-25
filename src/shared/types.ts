export type Severity = "informational" | "low" | "medium" | "high" | "critical";
export type VerificationStatus = "observed" | "inferred" | "verified" | "inconclusive";

export interface Finding {
  finding_id: string;
  scenario_id: number;
  scenario_name: string;
  category: string;
  severity: Severity;
  confidence: number;
  confidence_rationale: string;
  title: string;
  summary: string;
  evidence: string[];
  affected_element_description: string;
  page_url: string;
  detected_at: string;
  recommended_action: string;
  limitations: string;
  verification_status: VerificationStatus;
}

export interface ElementEvidence {
  description: string;
  text: string;
  tag: string;
  foreground?: string;
  background?: string;
  /** Undefined when the real background could not be determined (image, gradient). */
  contrast?: number;
  /** Text sits on a background image or gradient, so contrast is not measurable. */
  backgroundImage?: boolean;
  /** WCAG "large text": at least 24px, or 18.66px bold; needs only 3:1. */
  large?: boolean;
  interactive?: boolean;
  width?: number;
  height?: number;
  opacity?: number;
  fontSize?: number;
  required?: boolean;
  hasLabel?: boolean;
  disabled?: boolean;
}

export interface TimerObservation {
  key: string;
  text: string;
  seconds?: number;
  /** Nearby text, used to show urgency wording next to the timer. */
  context?: string;
}

/** A countdown value remembered from an earlier visit to the same page. */
export interface StoredTimer {
  key: string;
  seconds: number;
  at: number;
  restarts: number;
}

export interface ScarcityClaim { text: string; count?: number }
export interface StoredClaim extends ScarcityClaim { at: number }

export interface FormEvidence {
  description: string;
  /** Kinds of personal data the form asks for: email, password, phone, payment. */
  sensitive: string[];
  validated: boolean;
  novalidate: boolean;
}

export interface ChoiceControl {
  text: string;
  area: number;
  contrast?: number;
  opacity: number;
  fontSize: number;
}

/** Two competing choices shown together, e.g. "Accept all" next to "Reject". */
export interface ChoicePair {
  container: string;
  positive: ChoiceControl;
  negative: ChoiceControl;
}

export interface SubscriptionTerm {
  text: string;
  fontSize: number;
  contrast?: number;
  /** Vertical distance in px from the subscribe/checkout action. */
  distance: number;
}

export interface PageEvidence {
  url: string;
  title: string;
  text: string;
  observedAt: string;
  elements: ElementEvidence[];
  timers: TimerObservation[];
  previousTimers?: StoredTimer[];
  claims?: ScarcityClaim[];
  previousClaims?: StoredClaim[];
  previousPage?: { url: string; title: string; text: string; sku?: string; name?: string };
  navigation?: { loadMs?: number; domInteractiveMs?: number; resourceCount?: number; longTasks?: number; failedResources?: number };
  formCount: number;
  formsNoValidate: boolean;
  forms?: FormEvidence[];
  darkMode?: { supported: boolean; preferred: boolean; pageIsDark: boolean };
  adminControls?: number;
  accessibility?: { unlabeled: string[]; smallTargets: string[]; focusSuppressed: boolean; imageLinksWithoutAlt: number };
  choicePairs?: ChoicePair[];
  subscription?: { action?: { text: string; fontSize: number; contrast?: number }; terms: SubscriptionTerm[] };
  product?: { name?: string; sku?: string };
}

export interface ScanResult {
  url: string;
  title: string;
  scannedAt: string;
  findings: Finding[];
  detectorCount: number;
  caveat: string;
  demoMode?: boolean;
}

export const SCENARIO_NAMES = [
  "Dark-mode readability",
  "Urgency claims",
  "Exposed admin indicators",
  "Scarcity claims",
  "Form verification",
  "Page performance",
  "Sensitive information",
  "Accessibility barriers",
  "Cross-page consistency",
  "Subscription terms",
  "Visual emphasis"
] as const;

/** Ids for the five live features; numeric ids are the original eleven scenarios. */
export type FeatureId = "A" | "B" | "C" | "D" | "E";
export type ScenarioId = number | FeatureId;

export const FEATURE_NAMES: Record<FeatureId, string> = {
  A: "Redirect and new-tab tracking",
  B: "Hidden timer and close-button detection",
  C: "Suspicious download and notification prompts",
  D: "Visible-area priority",
  E: "Evidence panel"
};

export interface ClaimStatus {
  claim: string;
  status: VerificationStatus;
}

export interface ChainHop {
  host: string;
  path: string;
  timestamp: number;
  via: string;
}

export interface RedirectChain {
  source_host: string;
  hops: ChainHop[];
  complete: boolean;
  incomplete_reasons: string[];
  opened_new_tab: boolean;
  opener_tab_id?: number;
  user_interaction: "observed_matching" | "observed_nonmatching" | "not_observed" | "unknown";
}

/** Standardized object every detector emits; the popup only renders these. */
export interface TaifEvent {
  event_id: string;
  scenario_id: ScenarioId;
  scenario_name: string;
  event_type: string;
  title: string;
  summary: string;
  source_url?: string;
  destination_url?: string;
  tab_id: number;
  timestamp: number;
  page_key: string;
  evidence: string[];
  element?: string;
  chain?: RedirectChain;
  claims: ClaimStatus[];
  severity: Severity;
  confidence: number;
  verification_status: VerificationStatus;
  classification: string;
  alternatives: string[];
  limitations: string;
  recommended_action: string;
  in_viewport?: boolean;
  acknowledged: boolean;
  occurrences: number;
  dismiss_key: string;
  /** Kept in memory-only session storage for the "return" action; never rendered. */
  return_url?: string;
}

export interface ScanRecord { page: string; status: "done" | "failed"; error?: string; at: number }

export type PageStatus =
  | "monitoring"
  | "scanning"
  | "issue"
  | "clean"
  | "inconclusive"
  | "permission"
  | "unsupported";
