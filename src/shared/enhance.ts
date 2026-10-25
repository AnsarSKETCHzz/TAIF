/**
 * Analyze & Enhance: the rule set, settings and explanation text. Pure, so the popup, the injected
 * enhancer and tests all share one definition.
 */

export type Category =
  | "primary" | "secondary" | "submit" | "auth" | "otp" | "captcha" | "input"
  | "navigation" | "error" | "warning" | "small-text" | "small-target";

export const CATEGORY_LABELS: Record<Category, string> = {
  primary: "Primary action",
  secondary: "Secondary action",
  submit: "Submit / continue",
  auth: "Login / sign-up / verify",
  otp: "OTP / verification code",
  captcha: "CAPTCHA",
  input: "Form field",
  navigation: "Navigation",
  error: "Error / validation message",
  warning: "Warning / disclosure",
  "small-text": "Small text",
  "small-target": "Small control"
};

/** How each category is recognised, shown to the user so the rules are transparent. */
export const CATEGORY_RULES: Record<Category, string> = {
  primary: "Button-like control with a filled background that stands out from its surroundings.",
  secondary: "Button-like control without a filled background.",
  submit: "type=submit, or a control named Submit/Continue/Next/Confirm/Save/Proceed/Pay/Checkout.",
  auth: "Control or link named Log in/Sign in/Sign up/Register/Verify/Create account.",
  otp: "Input with autocomplete=one-time-code, an OTP/verification-code/PIN name or label, or a row of single-character boxes.",
  captcha: "Known CAPTCHA frames (reCAPTCHA, hCaptcha, Turnstile, Arkose, GeeTest, AWS WAF, Friendly Captcha), elements named captcha, and their instructions/inputs.",
  input: "Visible text, email, phone, password, number, select or textarea field, with its label.",
  navigation: "Links and buttons inside nav, header, menus or role=navigation.",
  error: "role=alert, aria-live=assertive, aria-invalid fields' messages, or short text saying error/invalid/required/incorrect.",
  warning: "Text about warnings, fees, renewal, refunds or terms near the page's actions.",
  "small-text": "Readable sentences rendered smaller than 12px.",
  "small-target": "Any other control smaller than your target size."
};

export const CATEGORY_LIMITS: Record<Category, string> = {
  primary: "Visual prominence is estimated from colours only.",
  secondary: "Icon-only controls without an accessible name are listed with their tag.",
  submit: "Names in other languages may not match.",
  auth: "Names in other languages may not match.",
  otp: "Custom OTP widgets drawn on canvas cannot be detected.",
  captcha: "Content inside CAPTCHA frames belongs to the provider; TAIF only enlarges the frame. CAPTCHAs are never solved or bypassed.",
  input: "Fields inside closed shadow DOM or cross-origin frames are not reachable.",
  navigation: "Very large menus are capped at 30 items.",
  error: "Messages shown only as colour or icons are missed.",
  warning: "Keyword-based; context decides whether it matters.",
  "small-text": "Decorative small print (e.g. footers) is included.",
  "small-target": "Inline links inside sentences are exempt, as in WCAG."
};

export type Mode = "quick" | "review";
export type ScreenMode = "auto" | "compact" | "spacious";
export type Strength = "normal" | "large" | "extra";

/** How much bigger enhanced elements become: whole controls are zoomed; text grows by the text factor. */
export const STRENGTH: Record<Strength, { zoom: number; text: number; captchaMax: number; label: string }> = {
  normal: { zoom: 1, text: 1, captchaMax: 1.8, label: "Normal" },
  large: { zoom: 1.4, text: 1.25, captchaMax: 2.4, label: "Large" },
  extra: { zoom: 1.8, text: 1.5, captchaMax: 3, label: "Extra large" }
};

export interface EnhanceSettings {
  mode: Mode;
  strength: Strength;
  targetPx: number;
  minFontPx: number;
  categories: Record<Category, boolean>;
  screen: ScreenMode;
  /** Test input only: simulates a high-risk context. */
  risk: boolean;
  guidance: boolean;
  focusRing: boolean;
}

export const DEFAULT_SETTINGS: EnhanceSettings = {
  mode: "quick",
  strength: "extra",
  targetPx: 44,
  minFontPx: 16,
  categories: {
    primary: true, secondary: true, submit: true, auth: true, otp: true, captcha: true, input: true,
    navigation: true, error: true, warning: true, "small-text": true, "small-target": true
  },
  screen: "auto",
  risk: false,
  guidance: true,
  focusRing: true
};

export function withDefaults(saved: unknown): EnhanceSettings {
  const value = (saved && typeof saved === "object" ? saved : {}) as Partial<EnhanceSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    targetPx: clampNumber(value.targetPx, 24, 72, DEFAULT_SETTINGS.targetPx),
    minFontPx: clampNumber(value.minFontPx, 12, 28, DEFAULT_SETTINGS.minFontPx),
    strength: value.strength && value.strength in STRENGTH ? value.strength : DEFAULT_SETTINGS.strength,
    categories: { ...DEFAULT_SETTINGS.categories, ...(value.categories ?? {}) }
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export type Status = "detected" | "suggested" | "applied" | "verified" | "skipped" | "unsupported" | "unverified" | "undone";

export interface Size { w: number; h: number; font: number }

export interface Candidate {
  id: string;
  category: Category;
  name: string;
  tag: string;
  before: Size;
  after?: Size;
  issues: string[];
  reason: string;
  suggestion: string;
  eligible: boolean;
  status: Status;
  /** Context signal that shaped the change, if any. */
  context?: string;
  /** "Why did the interface change?" sentence, from measured values only. */
  explanation?: string;
}

export interface ContextChange {
  id: string;
  signal: string;
  element: string;
  rule: string;
  change: string;
}

export interface EnhanceReport {
  url: string;
  host: string;
  candidates: Candidate[];
  context: ContextChange[];
  screen: { width: number; height: number; mode: "compact" | "spacious" };
  visitor: "first-time" | "returning";
  pageZoomed?: boolean;
  analyzedAt: string;
}

const EXACT = (n: number) => `${Math.round(n)}`;

/** Sentence for "Why did the interface change?", built only from measured values. */
export function explain(candidate: Candidate, settings: EnhanceSettings): string {
  const label = `${CATEGORY_LABELS[candidate.category]}${candidate.name ? ` "${candidate.name}"` : ""}`;
  const { before, after } = candidate;
  const why = settings.mode === "quick" ? "Quick Enhance is on" : "you approved it in Review First";
  if (candidate.status === "skipped") return `${label} was left unchanged: ${candidate.reason}`;
  if (candidate.status === "unsupported") return `${label} could not be changed: ${candidate.reason}`;
  if (candidate.status === "undone") return `${label} was restored to its original presentation.`;
  if (!after) return `${label}: ${candidate.suggestion} (${candidate.reason}).`;
  const sizeChanged = Math.abs(after.w - before.w) >= 1 || Math.abs(after.h - before.h) >= 1;
  const fontChanged = Math.abs(after.font - before.font) >= 0.5;
  const parts = [
    sizeChanged ? `enlarged from ${EXACT(before.w)} × ${EXACT(before.h)} px to ${EXACT(after.w)} × ${EXACT(after.h)} px` : "",
    fontChanged ? `text from ${EXACT(before.font)}px to ${EXACT(after.font)}px` : ""
  ].filter(Boolean);
  if (!parts.length) return `${label}: the change was applied but no size difference could be measured.`;
  return `${label} ${parts.join(", ")} because ${why} and ${candidate.reason}${candidate.context ? ` (${candidate.context})` : ""}.`;
}

/** Was the measured result what the rule intended? */
export function verify(candidate: Candidate, after: Size, target: number, minFont: number): Status {
  const grew = after.w > candidate.before.w + 0.5 || after.h > candidate.before.h + 0.5 || after.font > candidate.before.font + 0.25;
  if (candidate.category === "captcha") return grew ? "verified" : "unverified";
  const meetsSize = Math.min(after.w, after.h) >= target - 1 || after.h >= target - 1;
  const meetsFont = after.font >= minFont - 0.5;
  return grew && (meetsSize || meetsFont) ? "verified" : grew ? "applied" : "unverified";
}

/* ---------------- Text rules ---------------- */

export const TEXT = {
  submit: /\b(?:submit|continue|next|confirm|save|proceed|place order|pay(?: now)?|checkout|check out|done|send|apply|book now|buy now|add to cart)\b/i,
  auth: /\b(?:log ?in|sign ?in|sign ?up|register|verify|create (?:an )?account|get otp|send otp|resend (?:otp|code))\b/i,
  otp: /\b(?:otp|one[- ]?time|verification code|security code|passcode|2fa|two[- ]factor|authenticat(?:ion|or) code|enter (?:the )?code|pin)\b/i,
  captcha: /captcha|i'?m not a robot|verify (?:you are|you're) (?:a )?human|select all (?:images|squares)|type the (?:characters|text)|characters (?:you see|shown)|security check|challenge/i,
  error: /\b(?:error|invalid|required|incorrect|failed|wrong|not valid|must be|please (?:enter|fill|select|check))\b/i,
  warning: /\b(?:warning|caution|important|note:|fees?|charges?|auto(?:matically)?[- ]renew|non[- ]refundable|no refunds?|terms (?:and|&) conditions|by (?:clicking|continuing|placing)|cancel(?:lation)?|penalt(?:y|ies))\b/i,
  risky: /\b(?:pay|buy|purchase|place order|checkout|check out|delete|remove|transfer|send money|withdraw|confirm (?:payment|order|transfer)|subscribe|close account|deactivate)\b/i
};

export const CAPTCHA_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|geetest|captcha|awswaf|friendlycaptcha|mtcaptcha|perimeterx|px-captcha|datadome/i;
