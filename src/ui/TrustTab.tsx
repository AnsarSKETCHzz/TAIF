import { useEffect, useState } from "react";
import { analyzeReviews, PURCHASE_NOTE, siteVerdict, type ReviewData, type SiteVerdict, type TrustReport } from "../shared/trust";
import { siteOf } from "../shared/url";
import { accessError, callEnhancer } from "./EnhanceTab";

interface Lookups { rank?: number | null; rankDate?: string; registered?: string | null; listed: boolean }

/** Tranco popularity rank: number, null when the site is not listed, undefined when unreachable. */
async function trancoRank(domain: string): Promise<{ rank?: number | null; date?: string }> {
  try {
    const response = await fetch(`https://tranco-list.eu/api/ranks/domain/${encodeURIComponent(domain)}`, { credentials: "omit" });
    if (!response.ok) return {};
    const json = await response.json() as { ranks?: { date?: string; rank?: number }[] };
    const latest = (json.ranks ?? []).filter((item) => typeof item.rank === "number").sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    return latest ? { rank: latest.rank!, date: latest.date } : { rank: null };
  } catch {
    return {};
  }
}

/** RDAP registration date: ISO string, null when not published, undefined when unreachable. */
async function registrationDate(domain: string): Promise<string | null | undefined> {
  try {
    const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { credentials: "omit" });
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    const json = await response.json() as { events?: { eventAction?: string; eventDate?: string }[] };
    return json.events?.find((event) => event.eventAction === "registration")?.eventDate ?? null;
  } catch {
    return undefined;
  }
}

export function TrustTab({ tab }: { tab?: chrome.tabs.Tab }) {
  const [data, setData] = useState<ReviewData>();
  const [report, setReport] = useState<TrustReport>();
  const [lookups, setLookups] = useState<Lookups>();
  const [verdict, setVerdict] = useState<SiteVerdict>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [analyzedAt, setAnalyzedAt] = useState("");

  const url = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url) : undefined;
  const domain = url ? siteOf(url.hostname.replace(/^www\./, "")) : "";

  const check = async () => {
    if (!tab?.id || !url) {
      setError("Open a normal website to check it.");
      return;
    }
    setBusy(true);
    setError("");
    // The site checks and the review reading run together; a page that can't be read still gets a verdict.
    const [extracted, tranco, registered, listed] = await Promise.all([
      callEnhancer<ReviewData>(tab.id, "reviews").catch((cause: unknown) => {
        setError(accessError(cause));
        return undefined;
      }),
      trancoRank(domain),
      registrationDate(domain),
      chrome.runtime.sendMessage({ type: "TAIF_SITE_LISTED", host: url.hostname }).then((response: { listed?: boolean }) => Boolean(response?.listed), () => false)
    ]);
    const reviews = extracted && extracted.reviews.length ? analyzeReviews(extracted) : undefined;
    setData(extracted);
    setReport(reviews);
    setLookups({ rank: tranco.rank, rankDate: tranco.date, registered, listed });
    setVerdict(siteVerdict({ domain, https: url.protocol === "https:", rank: tranco.rank, registered, adListed: listed, reviews }));
    setAnalyzedAt(new Date().toLocaleString());
    setBusy(false);
  };

  useEffect(() => {
    void check();
  }, [tab?.id]);

  return (
    <section className="tp-body">
      {busy && !verdict && <article className="tp-status" aria-busy="true"><h2>Checking {domain || "this website"}…</h2><p>Popularity, domain age, ad-network lists and reviews.</p></article>}

      {verdict && (
        <article className={`tp-verdict tp-verdict-${verdict.tone}`}>
          <div className="tp-score" aria-label={`Trust score ${verdict.score} out of 100`}><b>{verdict.score}</b><small>/100</small></div>
          <div>
            <p className="tp-eyebrow">{verdict.label.toUpperCase()}</p>
            <h2>{verdict.headline}</h2>
          </div>
        </article>
      )}
      {verdict && (
        <div className="tp-why-list">
          <h3>Why this score</h3>
          <ul className="tp-reasons">
            {verdict.reasons.map((reason) => (
              <li key={reason.text} className={reason.effect > 0 ? "tp-plus" : reason.effect < 0 ? "tp-minus" : ""}>
                <span>{reason.effect > 0 ? `+${reason.effect}` : reason.effect < 0 ? reason.effect : "±0"}</span> {reason.text}
              </li>
            ))}
          </ul>
          <p className="tp-muted">Score starts at 50. "Legit" means well-known and long-established; no score can guarantee a site is safe. Checked {analyzedAt}{lookups?.rankDate ? ` · Tranco list of ${lookups.rankDate}` : ""}.</p>
        </div>
      )}
      {error && <p className="tp-muted">{error}</p>}

      {verdict && (
        <div className="tp-why-list">
          <h3>Customer reviews on this page</h3>
          {!report ? <p className="tp-muted">No customer reviews on this page, so the verdict above is based on the website itself.</p> : (
            <>
              <p><b>{report.category}</b> · {report.sample} review(s) read{data?.displayed.count !== undefined ? ` · page shows ${data.displayed.count.toLocaleString()} ratings` : ""}{data?.displayed.average !== undefined ? ` · ${data.displayed.average.toFixed(1)}/5` : ""}</p>
              {report.findings.map((finding) => (
                <details className="tp-evidence" key={finding.id}>
                  <summary><span className={`tp-sev tp-sig-${finding.significance}`}>{finding.significance}</span> {finding.title}</summary>
                  <p>{finding.observation}</p>
                  <p className="tp-muted">Rule: {finding.rule} · Limits: {finding.limitations}</p>
                  {finding.examples.length > 0 && <ul>{finding.examples.map((example) => <li key={example}>{example}</li>)}</ul>}
                </details>
              ))}
              {report.notes.map((note) => <p className="tp-muted" key={note}>{note}</p>)}
            </>
          )}
          <p className="tp-muted"><b>Purchases:</b> {PURCHASE_NOTE}</p>
        </div>
      )}

      <button className="tp-btn tp-ghost" disabled={busy || !tab?.id} onClick={() => void check()}>{busy ? "Checking…" : "Check again"}</button>
      <p className="tp-muted">Sends only the domain name ({domain || "—"}) to Tranco (popularity) and RDAP (domain registration). Reviews are read on your computer.</p>
    </section>
  );
}
