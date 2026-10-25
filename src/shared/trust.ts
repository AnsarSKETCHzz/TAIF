/**
 * Review & Website Trust Check: explainable, rule-based checks over reviews visible on the current
 * page. Every finding describes an observation; none claims who wrote a review or that a seller
 * committed fraud, and no trust percentage is produced.
 */

export interface ReviewEntry {
  text: string;
  rating?: number;
  date?: string;
  /** Masked pseudonym (first letter only); never looked up. */
  author?: string;
  verifiedLabel: boolean;
  source: "json-ld" | "microdata" | "page";
}

export interface ReviewData {
  domain: string;
  url: string;
  productName?: string;
  isProductPage: boolean;
  displayed: { count?: number; average?: number };
  structured: { count?: number; average?: number; reviews: number };
  reviews: ReviewEntry[];
}

export type Significance = "weak" | "moderate" | "strong";

export interface TrustFinding {
  id: string;
  title: string;
  observation: string;
  rule: string;
  affected?: number;
  significance: Significance;
  /** Confidence that the observation itself is correct, not that fraud occurred. */
  confidence: number;
  limitations: string;
  examples: string[];
}

export type TrustCategory =
  | "No significant issues detected in the available evidence"
  | "Some review reliability concerns detected"
  | "Multiple suspicious review patterns detected"
  | "Insufficient evidence to assess";

export interface TrustReport {
  category: TrustCategory;
  sample: number;
  findings: TrustFinding[];
  notes: string[];
  missing: string[];
  nextSteps: string[];
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

function shingles(text: string): Set<string> {
  const words = normalize(text).split(" ");
  const set = new Set<string>();
  for (let i = 0; i + 2 < words.length; i += 1) set.add(words.slice(i, i + 3).join(" "));
  return set;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const excerpt = (text: string) => `"${text.replace(/\s+/g, " ").trim().slice(0, 80)}${text.length > 80 ? "…" : ""}"`;

function duplicates(reviews: ReviewEntry[]): TrustFinding[] {
  const usable = reviews.filter((review) => normalize(review.text).length >= 20);
  const groups = new Map<string, ReviewEntry[]>();
  for (const review of usable) {
    const key = normalize(review.text);
    groups.set(key, [...(groups.get(key) ?? []), review]);
  }
  const exact = [...groups.values()].filter((group) => group.length > 1);
  const findings: TrustFinding[] = [];
  const exactCount = exact.reduce((sum, group) => sum + group.length, 0);
  if (exact.length) {
    findings.push({
      id: "duplicate-exact",
      title: "Identical review text",
      observation: `${exactCount} of ${usable.length} reviews share identical text (${exact.length} group${exact.length === 1 ? "" : "s"}). This may indicate duplicated or templated reviews, but it does not show who wrote them or that the seller committed fraud.`,
      rule: "Same text after lower-casing and removing punctuation, for reviews of 20+ characters.",
      affected: exactCount,
      significance: exactCount >= 3 || exactCount / usable.length >= 0.2 ? "strong" : "moderate",
      confidence: 0.95,
      limitations: "Sites sometimes show the same review for several product variants, or repeat a review across pages.",
      examples: exact.slice(0, 3).map((group) => `${group.length}× ${excerpt(group[0].text)}`)
    });
  }
  // Near-duplicates: different text, very similar wording.
  const distinct = [...groups.values()].map((group) => group[0]).slice(0, 200);
  const sets = distinct.map((review) => shingles(review.text));
  const near: [number, number][] = [];
  for (let i = 0; i < distinct.length; i += 1) {
    for (let j = i + 1; j < distinct.length; j += 1) {
      if (sets[i].size >= 4 && jaccard(sets[i], sets[j]) >= 0.6) near.push([i, j]);
    }
  }
  if (near.length) {
    const involved = new Set(near.flat());
    findings.push({
      id: "duplicate-near",
      title: "Unusually similar review wording",
      observation: `${involved.size} reviews share most of their wording with another review (${near.length} pair${near.length === 1 ? "" : "s"}).`,
      rule: "Three-word phrase overlap (Jaccard) of at least 0.6 between two different reviews.",
      affected: involved.size,
      significance: involved.size >= 4 ? "moderate" : "weak",
      confidence: 0.85,
      limitations: "Short reviews and common phrases can overlap by coincidence; translated reviews may also look alike.",
      examples: near.slice(0, 2).map(([a, b]) => `${excerpt(distinct[a].text)} ≈ ${excerpt(distinct[b].text)}`)
    });
  }
  return findings;
}

export function parseDate(value: string | undefined): number | undefined {
  if (!value) return;
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  const months = "january|february|march|april|may|june|july|august|september|october|november|december";
  const dmy = value.match(new RegExp(`(\\d{1,2})\\s+(${months})\\s+(\\d{4})`, "i"));
  if (dmy) return Date.parse(`${dmy[2]} ${dmy[1]}, ${dmy[3]}`);
  const numeric = value.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (numeric) return Date.UTC(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));
  return;
}

function timing(reviews: ReviewEntry[]): TrustFinding[] {
  const dates = reviews.map((review) => parseDate(review.date)).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  if (dates.length < 8) return [];
  const window = 2 * 86_400_000;
  let best = 0;
  let bestStart = dates[0];
  for (let i = 0, j = 0; i < dates.length; i += 1) {
    while (dates[i] - dates[j] > window) j += 1;
    if (i - j + 1 > best) {
      best = i - j + 1;
      bestStart = dates[j];
    }
  }
  if (best < Math.max(5, dates.length * 0.4)) return [];
  return [{
    id: "timing-burst",
    title: "Many reviews posted within two days",
    observation: `${best} of ${dates.length} dated reviews were posted within a 2-day window starting ${new Date(bestStart).toISOString().slice(0, 10)}.`,
    rule: "At least 5 reviews and 40% of all dated reviews inside any 2-day window.",
    affected: best,
    significance: best / dates.length >= 0.6 ? "moderate" : "weak",
    confidence: 0.8,
    limitations: "Product launches, sales and review-request emails also cause bursts. Only reviews visible on this page are counted.",
    examples: []
  }];
}

function aggregates(data: ReviewData): { findings: TrustFinding[]; missing: string[] } {
  const findings: TrustFinding[] = [];
  const missing: string[] = [];
  const { displayed, structured, reviews } = data;
  if (displayed.count === undefined) missing.push("No review count is displayed on the page.");
  if (structured.count === undefined && structured.average === undefined) missing.push("No structured rating data (JSON-LD/microdata) on the page.");
  if (displayed.count !== undefined && structured.count !== undefined) {
    const diff = Math.abs(displayed.count - structured.count);
    if (diff > 5 && diff / Math.max(displayed.count, structured.count) > 0.1) {
      findings.push({
        id: "count-mismatch",
        title: "Review counts disagree",
        observation: `The page shows ${displayed.count.toLocaleString()} reviews/ratings, but its structured data says ${structured.count.toLocaleString()}.`,
        rule: "Displayed count and structured-data count differ by more than 10% and 5 reviews.",
        significance: "moderate",
        confidence: 0.7,
        limitations: "Sites may count ratings and written reviews differently, or update one source later.",
        examples: []
      });
    }
  }
  if (displayed.average !== undefined && structured.average !== undefined && Math.abs(displayed.average - structured.average) >= 0.3) {
    findings.push({
      id: "average-mismatch",
      title: "Average ratings disagree",
      observation: `Displayed average ${displayed.average.toFixed(1)} vs structured-data average ${structured.average.toFixed(1)}.`,
      rule: "Displayed and structured averages differ by 0.3 stars or more.",
      significance: "moderate",
      confidence: 0.7,
      limitations: "Rounding, caching and different rating pools can explain small gaps.",
      examples: []
    });
  }
  const rated = reviews.filter((review) => review.rating !== undefined);
  if (rated.length >= 10 && displayed.average !== undefined) {
    const average = rated.reduce((sum, review) => sum + review.rating!, 0) / rated.length;
    if (Math.abs(average - displayed.average) >= 1) {
      findings.push({
        id: "sample-vs-average",
        title: "Visible reviews don't match the average",
        observation: `The ${rated.length} visible reviews average ${average.toFixed(1)} stars, while the page shows ${displayed.average.toFixed(1)}.`,
        rule: "At least 10 rated reviews whose average differs by 1 star or more from the displayed average.",
        significance: "weak",
        confidence: 0.6,
        limitations: "Pages often show only top or most-helpful reviews first, so the visible sample is rarely representative.",
        examples: []
      });
    }
  }
  return { findings, missing };
}

const GENERIC = ["great product", "good product", "nice product", "best product", "excellent product", "highly recommend", "value for money", "very good", "awesome", "love it", "good quality", "must buy", "five stars", "5 stars", "superb", "amazing product", "worth it"];

function generic(reviews: ReviewEntry[]): TrustFinding[] {
  if (reviews.length < 10) return [];
  const genericOnes = reviews.filter((review) => {
    const text = normalize(review.text);
    return text.length < 60 && GENERIC.some((phrase) => text.includes(phrase));
  });
  if (genericOnes.length / reviews.length < 0.5) return [];
  return [{
    id: "generic-language",
    title: "Mostly short, generic praise",
    observation: `${genericOnes.length} of ${reviews.length} reviews are short and use generic phrases like "great product" or "value for money".`,
    rule: "Half or more of the reviews are under 60 characters and contain a generic phrase.",
    affected: genericOnes.length,
    significance: "weak",
    confidence: 0.75,
    limitations: "Many genuine buyers write short reviews. This is a weak signal on its own.",
    examples: genericOnes.slice(0, 3).map((review) => excerpt(review.text))
  }];
}

const KINDS = ["phone", "laptop", "shoe", "shoes", "shirt", "dress", "book", "watch", "headphone", "headphones", "earbuds", "bag", "charger", "cable", "camera", "tv", "television", "mattress", "chair", "table", "lamp", "bottle", "cream", "shampoo", "perfume", "toy", "game", "jacket", "jeans", "tablet", "speaker", "mouse", "keyboard"];

function mismatch(data: ReviewData): TrustFinding[] {
  const name = normalize(data.productName ?? "");
  if (!name || data.reviews.length < 5) return [];
  const productKinds = KINDS.filter((kind) => new RegExp(`\\b${kind}\\b`).test(name));
  if (!productKinds.length) return [];
  const off = data.reviews.filter((review) => {
    const text = normalize(review.text);
    const mentioned = KINDS.filter((kind) => new RegExp(`\\bthis ${kind}\\b`).test(text));
    return mentioned.length > 0 && !mentioned.some((kind) => productKinds.includes(kind) || productKinds.some((own) => own.startsWith(kind) || kind.startsWith(own)));
  });
  if (off.length < 3) return [];
  return [{
    id: "product-mismatch",
    title: "Some reviews seem to describe a different product",
    observation: `${off.length} reviews talk about "this ${KINDS.find((kind) => off.some((review) => normalize(review.text).includes(`this ${kind}`)))}" while the product is a ${productKinds.join("/")}.`,
    rule: "Reviews that refer to “this <product type>” with a type different from the product title.",
    affected: off.length,
    significance: "weak",
    confidence: 0.55,
    limitations: "Bundles, accessories, variants and shared review pools can explain this.",
    examples: off.slice(0, 2).map((review) => excerpt(review.text))
  }];
}

function consistency(data: ReviewData): TrustFinding[] {
  const structured = data.reviews.filter((review) => review.source === "json-ld");
  const visible = data.reviews.filter((review) => review.source !== "json-ld");
  if (structured.length < 3 || visible.length < 3) return [];
  const visibleSets = visible.map((review) => shingles(review.text));
  const unmatched = structured.filter((review) => {
    const set = shingles(review.text);
    return !visibleSets.some((other) => jaccard(set, other) >= 0.5);
  });
  if (unmatched.length / structured.length < 0.8) return [];
  return [{
    id: "structured-not-visible",
    title: "Structured reviews don't appear on the page",
    observation: `${unmatched.length} of ${structured.length} reviews in the page's structured data were not found among the visible reviews.`,
    rule: "80% or more of structured-data reviews have no visibly matching review.",
    affected: unmatched.length,
    significance: "weak",
    confidence: 0.6,
    limitations: "Visible reviews may be paginated or lazy-loaded. Client-side rendering itself is normal and is not treated as a signal.",
    examples: []
  }];
}

export function analyzeReviews(data: ReviewData): TrustReport {
  const { findings: aggregateFindings, missing } = aggregates(data);
  const findings = [...duplicates(data.reviews), ...timing(data.reviews), ...aggregateFindings, ...generic(data.reviews), ...mismatch(data), ...consistency(data)];
  const verified = data.reviews.filter((review) => review.verifiedLabel).length;
  const notes = [
    data.reviews.length ? `${verified} of ${data.reviews.length} visible reviews carry a "verified purchase" label. These labels are displayed by the site and were not independently verified.` : "",
    "Dynamic (JavaScript/React) rendering of reviews is normal website behaviour and is not treated as evidence either way."
  ].filter(Boolean);
  if (!data.isProductPage) missing.push("This does not look like a product or review page.");
  if (data.reviews.length < 5) missing.push(`Only ${data.reviews.length} review(s) could be read on this page; patterns can't be assessed reliably.`);
  if (data.reviews.filter((review) => parseDate(review.date) !== undefined).length < 8) missing.push("Too few dated reviews to check timing.");

  const strong = findings.filter((finding) => finding.significance === "strong").length;
  const moderate = findings.filter((finding) => finding.significance === "moderate").length;
  let category: TrustCategory;
  if (!data.reviews.length && data.displayed.count === undefined && data.structured.count === undefined) category = "Insufficient evidence to assess";
  else if (strong >= 1 && strong + moderate >= 2) category = "Multiple suspicious review patterns detected";
  else if (strong || moderate || findings.length >= 2) category = "Some review reliability concerns detected";
  else if (data.reviews.length < 5) category = "Insufficient evidence to assess";
  else category = "No significant issues detected in the available evidence";

  return {
    category,
    sample: data.reviews.length,
    findings,
    notes,
    missing,
    nextSteps: [
      "Read the most recent and the lowest-rated reviews, not just the top ones.",
      "Search the site's name plus “reviews” or “complaints” on an independent site.",
      "Prefer payment methods with buyer protection on unfamiliar shops.",
      ...(findings.length ? ["Treat the star rating with caution given the patterns above."] : [])
    ]
  };
}

/* ---------------- Independent sources (domain only, on request) ---------------- */

export interface SourceResult {
  source: string;
  status: "ok" | "unavailable";
  summary: string;
  detail?: string;
  checkedAt: string;
}

export function rdapSummary(json: unknown, now = Date.now()): Omit<SourceResult, "checkedAt"> {
  const events = (json as { events?: { eventAction?: string; eventDate?: string }[] })?.events ?? [];
  const registered = events.find((event) => event.eventAction === "registration")?.eventDate;
  const at = registered ? Date.parse(registered) : NaN;
  if (!Number.isFinite(at)) return { source: "RDAP domain registration", status: "unavailable", summary: "Registration date not published for this domain." };
  const days = Math.floor((now - at) / 86_400_000);
  const age = days < 60 ? `${days} days` : days < 730 ? `${Math.round(days / 30)} months` : `${Math.round(days / 365)} years`;
  return {
    source: "RDAP domain registration",
    status: "ok",
    summary: `Domain registered ${registered!.slice(0, 10)} (${age} ago).`,
    detail: days < 180 ? "Very new domains are common among short-lived shops; this alone does not make a site untrustworthy." : "Domain age says nothing about product quality or delivery."
  };
}

export function trancoSummary(json: unknown): Omit<SourceResult, "checkedAt"> {
  const ranks = (json as { ranks?: { date?: string; rank?: number }[] })?.ranks ?? [];
  const latest = ranks.filter((item) => typeof item.rank === "number").sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  if (!latest) {
    return {
      source: "Tranco popularity ranking",
      status: "ok",
      summary: "Not in the Tranco top-sites list.",
      detail: "The list covers roughly the most-visited 1 million sites; smaller legitimate shops are often absent."
    };
  }
  return {
    source: "Tranco popularity ranking",
    status: "ok",
    summary: `Ranked #${latest.rank!.toLocaleString()} in the Tranco list (${latest.date}).`,
    detail: "An estimate of traffic popularity aggregated from several providers. It does not measure purchases."
  };
}

export const PURCHASE_NOTE = "Independent purchasing activity could not be verified.";

/* ---------------- Website verdict: legit / some doubt / doubtful, with a score and reasons ---------------- */

export interface SiteSignals {
  domain: string;
  https: boolean;
  /** Tranco rank; null = not in the list; undefined = source unavailable. */
  rank?: number | null;
  /** RDAP registration date (ISO); null = not published; undefined = source unavailable. */
  registered?: string | null;
  /** Listed by EasyList / uBlock as an ad, tracker or ad-popup domain. */
  adListed: boolean;
  reviews?: TrustReport;
  now?: number;
}

export interface SiteVerdict {
  score: number;
  label: "Legit" | "Likely legit" | "Some doubt" | "Doubtful";
  headline: string;
  tone: "good" | "ok" | "warn" | "bad";
  reasons: { text: string; effect: number }[];
}

const RISKY_TLDS = new Set(["xyz", "top", "click", "loan", "work", "icu", "cyou", "rest", "zip", "mov", "sbs", "cfd", "buzz", "monster", "quest", "lol", "bar", "surf", "tk", "ml", "ga", "cf", "gq", "ski", "fun", "site", "online", "shop", "store", "live", "today", "win", "bid", "vip"]);
const BRANDS = ["google", "paypal", "amazon", "apple", "microsoft", "facebook", "instagram", "netflix", "flipkart", "paytm", "whatsapp", "sbi", "hdfc", "icici", "axisbank", "phonepe", "youtube", "binance", "coinbase"];

/**
 * Combines independent signals into one 0–100 score. "Legit" means well-known and long-established;
 * no score can guarantee a site is safe.
 */
export function siteVerdict(signals: SiteSignals): SiteVerdict {
  const now = signals.now ?? Date.now();
  const reasons: SiteVerdict["reasons"] = [];
  const add = (text: string, effect: number) => reasons.push({ text, effect });
  const domain = signals.domain.toLowerCase().replace(/^www\./, "");
  const label = domain.split(".")[0];
  const tld = domain.split(".").pop() ?? "";

  if (signals.rank === undefined) add("Popularity ranking (Tranco) could not be checked", 0);
  else if (signals.rank === null) add("Not in the Tranco list of popular websites", -12);
  else if (signals.rank <= 10_000) add(`Very popular: #${signals.rank.toLocaleString()} worldwide (Tranco)`, 40);
  else if (signals.rank <= 100_000) add(`Popular: #${signals.rank.toLocaleString()} worldwide (Tranco)`, 28);
  else if (signals.rank <= 1_000_000) add(`Moderately known: #${signals.rank.toLocaleString()} worldwide (Tranco)`, 12);
  else add(`Little known: #${signals.rank.toLocaleString()} worldwide (Tranco)`, -6);

  let ageDays: number | undefined;
  if (signals.registered === undefined) add("Domain age (RDAP) could not be checked", 0);
  else if (signals.registered === null) add("Domain registration date is not published", -3);
  else {
    ageDays = Math.floor((now - Date.parse(signals.registered)) / 86_400_000);
    const years = ageDays / 365;
    if (years >= 10) add(`Domain registered ${Math.floor(years)} years ago`, 15);
    else if (years >= 3) add(`Domain registered ${Math.floor(years)} years ago`, 10);
    else if (years >= 1) add(`Domain registered ${Math.floor(years)} year(s) ago`, 3);
    else if (ageDays >= 180) add(`Domain registered only ${Math.round(ageDays / 30)} months ago`, -8);
    else if (ageDays >= 30) add(`Very new domain: registered ${Math.round(ageDays / 30)} month(s) ago`, -22);
    else add(`Brand-new domain: registered ${ageDays} day(s) ago`, -32);
  }

  if (!signals.https) add("Page is not served over HTTPS (connection not encrypted)", -15);
  if (signals.adListed) add("Listed as an advertising/ad-popup domain by EasyList or uBlock filters", -35);
  if (RISKY_TLDS.has(tld)) add(`Uses the .${tld} ending, common among short-lived sites`, -8);
  const brand = BRANDS.find((name) => label.includes(name) && label !== name);
  if (brand && !(signals.rank !== null && signals.rank !== undefined && signals.rank <= 100_000)) add(`Name contains "${brand}" but this is not ${brand}'s own site`, -30);

  if (signals.reviews) {
    const strong = signals.reviews.findings.filter((finding) => finding.significance === "strong").length;
    const moderate = signals.reviews.findings.filter((finding) => finding.significance === "moderate").length;
    if (strong || moderate) add(`Reviews on this page show ${strong + moderate} suspicious pattern(s)`, -Math.min(20, strong * 12 + moderate * 6));
  }

  const score = Math.max(0, Math.min(100, 50 + reasons.reduce((sum, reason) => sum + reason.effect, 0)));
  const famous = typeof signals.rank === "number" && signals.rank <= 10_000 && !signals.adListed && (ageDays === undefined || ageDays >= 3 * 365);
  if (famous || score >= 85) return { score, label: "Legit", tone: "good", headline: `${domain} is a well-known, established website.`, reasons };
  if (score >= 65) return { score, label: "Likely legit", tone: "ok", headline: `${domain} looks legitimate, with a few things to keep in mind.`, reasons };
  if (score >= 40) return { score, label: "Some doubt", tone: "warn", headline: `Be careful on ${domain}: it is not well established.`, reasons };
  return { score, label: "Doubtful", tone: "bad", headline: `${domain} shows several risk signs. Avoid payments, downloads and sign-ins here.`, reasons };
}
