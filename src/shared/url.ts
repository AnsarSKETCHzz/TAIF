/** Two-label public suffixes that need one more label to form a site. Not a full PSL. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.in", "net.in", "org.in", "ac.in", "co.jp", "com.au", "net.au",
  "org.au", "com.br", "com.cn", "com.mx", "co.nz", "co.za", "com.sg", "com.tr", "com.my", "github.io", "pages.dev",
  "vercel.app", "netlify.app", "blogspot.com"
]);

export interface NormalizedUrl {
  origin: string;
  host: string;
  site: string;
  path: string;
  /** origin + path; query, fragment and credentials removed. */
  display: string;
  hadQuery: boolean;
}

export function isSupportedUrl(raw: string | undefined): boolean {
  return Boolean(raw && /^https?:\/\//i.test(raw));
}

export function normalizeUrl(raw: string | undefined): NormalizedUrl | undefined {
  if (!isSupportedUrl(raw)) return;
  try {
    const url = new URL(raw!);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.length > 80 ? `${url.pathname.slice(0, 77)}…` : url.pathname;
    return {
      origin: url.origin,
      host,
      site: siteOf(host),
      path,
      display: `${url.origin}${path}`,
      hadQuery: url.search.length > 1 || url.hash.length > 1
    };
  } catch {
    return;
  }
}

/** Approximate registrable domain ("site") so subdomains of one site are not treated as a redirect. */
export function siteOf(host: string): string {
  const bare = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(bare) || bare.includes(":")) return bare;
  const labels = bare.split(".");
  if (labels.length <= 2) return bare;
  if (labels[labels.length - 1] === "localhost") return labels.slice(-2).join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

export function pageKey(raw: string | undefined): string {
  return normalizeUrl(raw)?.display ?? "unsupported";
}

export function maskText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]")
    .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number masked]")
    .replace(/\b(?:sk|pk|api|key)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[key-like value masked]")
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[number masked]");
}
