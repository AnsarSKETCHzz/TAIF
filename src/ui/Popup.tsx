import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { buildTabView, type TabView } from "../shared/events";
import type { PageStatus, ScanRecord, TaifEvent } from "../shared/types";
import { pageKey } from "../shared/url";
// The other tabs load only when opened, so the popup shows the protection view as fast as possible.
const AdBlockTab = lazy(() => import("./AdBlockTab").then((module) => ({ default: module.AdBlockTab })));
const EnhanceTab = lazy(() => import("./EnhanceTab").then((module) => ({ default: module.EnhanceTab })));
const TrustTab = lazy(() => import("./TrustTab").then((module) => ({ default: module.TrustTab })));

const HOSTS = ["http://*/*", "https://*/*"];

const STATUS_TEXT: Record<PageStatus, string> = {
  monitoring: "Monitoring",
  scanning: "Checking…",
  issue: "Problems found",
  clean: "No problems found",
  inconclusive: "Inconclusive",
  permission: "Permission required",
  unsupported: "Unsupported page"
};

const EYEBROW: Record<string, string> = {
  unexpected_redirect: "UNEXPECTED REDIRECT DETECTED",
  multi_hop_redirect: "REDIRECT CHAIN DETECTED",
  ad_new_tab: "UNEXPECTED NEW TAB",
  popup_without_click: "UNEXPECTED NEW TAB",
  new_tab_unclassified: "NEW TAB FROM ANOTHER SITE",
  redirect_after_click: "LINK REDIRECTED ELSEWHERE",
  cross_site_unclassified: "SITE CHANGED"
};

/** Reads what the background worker already saved, so the popup never waits on the worker. */
async function readView(tab: chrome.tabs.Tab, monitor: boolean): Promise<TabView> {
  const stored = await chrome.storage.session.get(["taif_events", "taif_scans"]);
  const events = ((stored.taif_events ?? {}) as Record<string, TaifEvent[]>)[String(tab.id)] ?? [];
  const scan = ((stored.taif_scans ?? {}) as Record<string, ScanRecord>)[String(tab.id)];
  return buildTabView(events, scan, tab.url, monitor, Date.now(), pageKey(tab.url));
}

export function Popup() {
  const [tab, setTab] = useState<chrome.tabs.Tab>();
  const [monitor, setMonitor] = useState<boolean>();
  const [view, setView] = useState<TabView>();
  const [scanning, setScanning] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [section, setSection] = useState<"protection" | "adblock" | "enhance" | "trust">("protection");
  const scanStarted = useRef(false);

  const refresh = useCallback(async (current: chrome.tabs.Tab, granted: boolean) => {
    setView(await readView(current, granted));
  }, []);

  const scan = useCallback(async (current: chrome.tabs.Tab) => {
    setScanning(true);
    setError("");
    try {
      const response = await chrome.runtime.sendMessage({ type: "TAIF_SCAN", tabId: current.id });
      if (response?.error) setError(`Page checks did not complete: ${response.error}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    let current: chrome.tabs.Tab | undefined;
    let granted = false;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onChange = (_changes: unknown, area: string) => {
      // Coalesce bursts of updates into one refresh every 300 ms.
      if (area !== "session" || !current || pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        if (current) void refresh(current, granted);
      }, 300);
    };
    void (async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!active?.id) throw new Error("No active tab was found.");
      current = active;
      granted = await chrome.permissions.contains({ origins: HOSTS });
      setTab(active);
      setMonitor(granted);
      const initial = await readView(active, granted);
      setView(initial);
      chrome.storage.onChanged.addListener(onChange);
      // Opening the popup counts as asking for a check if automatic checks haven't run here yet.
      if (initial.status !== "unsupported" && !initial.scan && !scanStarted.current) {
        scanStarted.current = true;
        void scan(active);
      }
    })().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "TAIF could not load."));
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [refresh, scan]);

  const act = async (event: TaifEvent, action: "acknowledge" | "dismiss" | "return") => {
    if (!tab) return;
    setError("");
    // Hide immediately; the worker confirms in the background.
    setHidden((previous) => new Set(previous).add(event.event_id));
    const response = await chrome.runtime.sendMessage({ type: "TAIF_ACTION", action, eventId: event.event_id, tabId: tab.id });
    if (response?.error) setError(response.error);
    else if (response?.note) setNote(response.note);
  };

  const enableMonitoring = async () => {
    setError("");
    const granted = await chrome.permissions.request({ origins: HOSTS });
    if (!granted) {
      setError("Permission was not granted. Redirect detection still works; automatic page checks stay off.");
      return;
    }
    await chrome.runtime.sendMessage({ type: "TAIF_SYNC_MONITOR" });
    setMonitor(true);
    setNote("Live monitoring is on. Reload open pages to start monitoring them.");
  };

  const problems = (view?.problems ?? []).filter((event) => !hidden.has(event.event_id));
  const details = view?.details ?? [];
  const status: PageStatus = scanning && !problems.length ? "scanning" : !view ? "monitoring" : problems.length ? "issue" : view.status === "issue" ? "clean" : view.status;
  const host = hostOf(tab?.url);
  const redirects = problems.filter((event) => event.chain);
  const others = problems.filter((event) => !event.chain);

  return (
    <main className="taif-popup">
      <header className="tp-header">
        <div className="tp-shield" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z" /><path d="M9 12l2 2 4-4" /></svg>
        </div>
        <div className="tp-brand"><h1>TAIF Protection</h1><p>REAL-TIME PAGE MONITORING</p></div>
        {view && <span className={`tp-pill tp-${status}`}>{problems.length ? `${problems.length} problem${problems.length === 1 ? "" : "s"}` : STATUS_TEXT[status]}</span>}
      </header>

      <nav className="tp-tabs" role="tablist" aria-label="TAIF sections">
        {([["protection", "Protection"], ["adblock", "Ad block"], ["enhance", "Enhance"], ["trust", "Trust"]] as const).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={section === key} className={section === key ? "tp-tab tp-tab-on" : "tp-tab"} onClick={() => setSection(key)}>{label}</button>
        ))}
      </nav>

      <Suspense fallback={<section className="tp-body"><p className="tp-muted">Loading…</p></section>}>
        {section === "adblock" && <AdBlockTab tab={tab} />}
        {section === "enhance" && <EnhanceTab tab={tab} />}
        {section === "trust" && <TrustTab tab={tab} />}
      </Suspense>
      {section === "protection" && <section className="tp-body">
        <p className="tp-site"><span>Current website</span><strong>{host || "This page"}</strong></p>
        {error && <p className="tp-error" role="alert">{error}</p>}
        {note && <p className="tp-note" role="status">{note}</p>}

        {!view ? (
          !error && <article className="tp-status" aria-busy="true"><h2>Loading…</h2><p>Reading this tab's results.</p></article>
        ) : (
          <>
            {redirects.map((event) => <RedirectAlert key={event.event_id} event={event} onAct={act} />)}
            {others.map((event) => <ProblemCard key={event.event_id} event={event} onAct={act} />)}
            {!problems.length && <StatusCard status={status} view={view} />}
          </>
        )}

        {details.length > 0 && (
          <div className="tp-all">
            <button className="tp-link" aria-expanded={showDetails} onClick={() => setShowDetails(!showDetails)}>
              {showDetails ? "Hide" : "Show"} details ({details.length})
            </button>
            {showDetails && <ul className="tp-list">{details.map((event) => <FindingRow key={event.event_id} event={event} />)}</ul>}
          </div>
        )}

        {monitor === false && status !== "unsupported" && (
          <div className="tp-permission">
            <p><b>Live monitoring is off.</b> Redirects and new tabs are still detected. Turn it on so TAIF checks every page automatically (fake countdowns, hidden choices, blocking overlays, fake warnings). Everything stays on your computer.</p>
            <button className="tp-btn" onClick={() => void enableMonitoring()}>Enable live monitoring</button>
          </div>
        )}

        <div className="tp-tools">
          {tab && status !== "unsupported" && <button className="tp-link" disabled={scanning} onClick={() => void scan(tab)}>{scanning ? "Checking…" : "Check again"}</button>}
          {tab && status !== "unsupported" && <button className="tp-link" onClick={() => void selectComparisonPage(tab).then(setNote, (cause: Error) => setError(cause.message))}>Use page for price comparison</button>}
          {tab && status !== "unsupported" && <button className="tp-link" onClick={() => void runAccessibilityAudit(tab).then(setNote, (cause: Error) => setError(cause.message))}>Full accessibility audit</button>}
          {tab && status !== "unsupported" && <button className="tp-link" onClick={() => void applySavedAdaptations(tab, false).then(setNote, (cause: Error) => setError(cause.message))}>Apply adaptations</button>}
          {tab && status !== "unsupported" && <button className="tp-link" onClick={() => void applySavedAdaptations(tab, true).then(setNote, (cause: Error) => setError(cause.message))}>Reset adaptations</button>}
          <button className="tp-link" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") })}>Dashboard & settings</button>
        </div>

        <ProtectionPanel />
      </section>}
      <footer className="tp-footer">Local-first · never clicks, blocks or submits for you</footer>
    </main>
  );
}

type Act = (event: TaifEvent, action: "acknowledge" | "dismiss" | "return") => Promise<void>;

interface ProtectionEntry { id: string; at: number; kind: "ad-tab" | "overlay"; host: string; url?: string; reopened?: boolean }

/** Popup protection settings and the log of things TAIF actually blocked or hid. */
function ProtectionPanel() {
  const [settings, setSettings] = useState({ closeAdTabs: false, hideOverlays: false });
  const [log, setLog] = useState<ProtectionEntry[]>([]);

  useEffect(() => {
    const load = async () => {
      const [{ taif_protection: saved }, { taif_protection_log: entries }] = await Promise.all([
        chrome.storage.local.get("taif_protection"),
        chrome.storage.session.get("taif_protection_log")
      ]);
      setSettings((current) => ({ ...current, ...(saved as object | undefined) }));
      setLog(Array.isArray(entries) ? (entries as ProtectionEntry[]).slice().reverse() : []);
    };
    void load();
    const onChange = () => void load();
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  const save = async (next: typeof settings) => {
    setSettings(next);
    await chrome.storage.local.set({ taif_protection: next });
  };

  return (
    <div className="tp-why-list">
      <h3>Popup protection</h3>
      <label className="tp-check"><input type="checkbox" checked={settings.closeAdTabs} onChange={(event) => void save({ ...settings, closeAdTabs: event.target.checked })} /> Add-on: close ad tabs automatically instead of showing the redirect alert (shows "Protected by TAIF" with Reopen)</label>
      <label className="tp-check"><input type="checkbox" checked={settings.hideOverlays} onChange={(event) => void save({ ...settings, hideOverlays: event.target.checked })} /> Hide page overlays that have no close button (never login, payment or consent dialogs)</label>
      <p className="tp-muted">This is TAIF's own popup protection. It does not block network ads and does not control AdGuard, BuyHatke or other extensions (they offer no public API for that).</p>
      {log.length > 0 && <ul>{log.slice(0, 8).map((entry) => (
        <li key={entry.id}>
          {new Date(entry.at).toLocaleTimeString()} · {entry.kind === "ad-tab" ? `closed ad tab (${entry.host})` : `hid an overlay on ${entry.host}`}
          {entry.kind === "ad-tab" && entry.url && !entry.reopened && <button className="tp-link" onClick={() => void chrome.runtime.sendMessage({ type: "TAIF_REOPEN", id: entry.id })}>Reopen</button>}
          {entry.reopened && " · reopened"}
        </li>
      ))}</ul>}
    </div>
  );
}

function RedirectAlert({ event, onAct }: { event: TaifEvent; onAct: Act }) {
  const chain = event.chain!;
  const route = [chain.source_host, ...chain.hops.map((hop) => hop.host)].filter((h, i, all) => i === 0 || all[i - 1] !== h);
  return (
    <article className="tp-alert" aria-live="polite">
      <p className="tp-eyebrow">{EYEBROW[event.event_type] ?? event.title.toUpperCase()}</p>
      <h2>You've been taken to another website.</h2>
      <p className="tp-summary">{event.summary}</p>
      <div className="tp-route">
        <span>Previous website</span><strong>{chain.source_host}</strong>
        {route.length > 2 && <><span>Passed through</span><strong>{route.slice(1, -1).join(" → ")}</strong></>}
        <span>Current website</span><strong>{route[route.length - 1]}</strong>
      </div>
      <div className="tp-why">
        <h3>Why am I seeing this?</h3>
        <p>{event.classification}. A domain change was verified from browser navigation events. The destination has not been confirmed as malicious.</p>
        <p className="tp-meta">Severity {event.severity} · Confidence {Math.round(event.confidence * 100)}% · {event.verification_status}</p>
      </div>
      <div className="tp-actions">
        <button className="tp-btn tp-ghost" onClick={() => void onAct(event, "acknowledge")}>Stay here</button>
        <button className="tp-btn" onClick={() => void onAct(event, "return")}>
          {chain.opened_new_tab ? `Back to ${chain.source_host} tab` : `Back to ${chain.source_host}`}
        </button>
      </div>
      {chain.opened_new_tab && <p className="tp-muted">Going back closes this ad tab.</p>}
      <EvidencePanel event={event} />
      <button className="tp-link tp-dismiss" onClick={() => void onAct(event, "dismiss")}>Dismiss alert</button>
    </article>
  );
}

function ProblemCard({ event, onAct }: { event: TaifEvent; onAct: Act }) {
  return (
    <article className="tp-alert tp-problem">
      <div className="tp-row-head">
        <span className={`tp-sev tp-sev-${event.severity}`}>{event.severity}</span>
        <span className="tp-scenario">{event.scenario_name}</span>
      </div>
      <h2>{event.title}</h2>
      <p className="tp-summary">{event.summary}</p>
      <p className="tp-meta-line">Confidence {Math.round(event.confidence * 100)}% · {event.verification_status} · {event.recommended_action}</p>
      <div className="tp-actions">
        <button className="tp-btn" onClick={() => void onAct(event, "acknowledge")}>Got it</button>
      </div>
      <EvidencePanel event={event} />
    </article>
  );
}

function StatusCard({ status, view }: { status: PageStatus; view: TabView }) {
  const text: Record<PageStatus, string> = {
    monitoring: "TAIF is watching this tab. Nothing needs your attention.",
    scanning: "Checking this page…",
    issue: "",
    clean: "Nothing on this page needs your attention. This is not a safety certificate.",
    inconclusive: `Page checks could not complete${view.scan?.error ? `: ${view.scan.error}` : "."} No clean result is shown.`,
    permission: "Redirect detection is active. Page checks have not run here yet.",
    unsupported: "Chrome does not let extensions inspect this page (browser, store or file pages). Nothing was checked."
  };
  return <article className={`tp-status tp-status-${status}`}><h2>{STATUS_TEXT[status]}</h2><p>{text[status]}</p></article>;
}

function FindingRow({ event }: { event: TaifEvent }) {
  return (
    <li className={event.acknowledged ? "tp-row tp-ack" : "tp-row"}>
      <div className="tp-row-head">
        <span className={`tp-sev tp-sev-${event.severity}`}>{event.severity}</span>
        <strong>{event.title}</strong>
      </div>
      <small>{event.scenario_name}{event.acknowledged ? " · you marked this as seen" : ""}</small>
      <EvidencePanel event={event} />
    </li>
  );
}

/** Feature E: everything the alert is based on, including what TAIF could not establish. */
export function EvidencePanel({ event }: { event: TaifEvent }) {
  return (
    <details className="tp-evidence">
      <summary>View evidence</summary>
      <dl>
        <dt>Scenario</dt><dd>{event.scenario_name} ({typeof event.scenario_id === "number" ? `#${event.scenario_id}` : `feature ${event.scenario_id}`})</dd>
        <dt>Observed event</dt><dd>{event.event_type.replace(/_/g, " ")}</dd>
        {event.source_url && <><dt>Source</dt><dd>{event.source_url}</dd></>}
        {event.destination_url && <><dt>Destination</dt><dd>{event.destination_url}</dd></>}
        <dt>Time</dt><dd>{new Date(event.timestamp).toLocaleString()}{event.occurrences > 1 ? ` · seen ${event.occurrences}×` : ""}</dd>
        {event.element && <><dt>Element</dt><dd>{event.element}</dd></>}
        <dt>Severity / confidence</dt><dd>{event.severity} · {Math.round(event.confidence * 100)}% (separate measures)</dd>
        <dt>Classification</dt><dd>{event.classification} — {event.verification_status}</dd>
      </dl>
      {event.chain && (
        <>
          <h4>Redirect chain {event.chain.complete ? "" : "(incomplete)"}</h4>
          <ol className="tp-chain">
            <li>{event.chain.source_host} <small>start</small></li>
            {event.chain.hops.map((hop, index) => <li key={index}>{hop.host}{hop.path !== "/" ? hop.path : ""} <small>{hop.via}</small></li>)}
          </ol>
          {event.chain.incomplete_reasons.map((reason) => <p className="tp-muted" key={reason}>{reason}</p>)}
        </>
      )}
      {event.claims.length > 0 && <><h4>Claims</h4><ul>{event.claims.map((claim) => <li key={claim.claim}><b>{claim.status}</b>: {claim.claim}</li>)}</ul></>}
      <h4>Evidence</h4>
      <ul>{event.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>
      {event.alternatives.length > 0 && <><h4>Other explanations</h4><ul>{event.alternatives.map((item) => <li key={item}>{item}</li>)}</ul></>}
      <h4>Limitations</h4><p className="tp-muted">{event.limitations}</p>
      <h4>Recommended</h4><p>{event.recommended_action}</p>
    </details>
  );
}

function hostOf(url?: string): string {
  try {
    return url && /^https?:/.test(url) ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

async function selectComparisonPage(tab: chrome.tabs.Tab): Promise<string> {
  if (!tab.id || !tab.url?.startsWith("http")) throw new Error("Open a normal website page to select it for comparison.");
  const [snapshot] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const mask = (value: string) => value
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]")
        .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number masked]");
      let sku: string | undefined;
      let name: string | undefined;
      for (const script of Array.from(document.querySelectorAll("script[type='application/ld+json']")).slice(0, 10)) {
        try {
          const data: unknown = JSON.parse(script.textContent ?? "");
          const items = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
          const product = items.find((item) => item && /Product/i.test(String(item["@type"] ?? "")));
          if (product) {
            const code = product.sku ?? product.gtin13 ?? product.gtin ?? product.mpn;
            sku = code !== undefined ? String(code).slice(0, 60) : undefined;
            name = typeof product.name === "string" ? product.name.slice(0, 200) : undefined;
            break;
          }
        } catch {
          // Malformed JSON-LD is ignored.
        }
      }
      const prices = document.body.innerText.match(/(?:[$€£₹¥]|USD|EUR|GBP|INR|Rs\.?)\s?\d[\d,.\s]*\d|\d[\d,.]*\s?(?:USD|EUR|GBP|INR)/g) ?? [];
      return { url: location.origin + location.pathname, title: mask(document.title.slice(0, 200)), text: prices.slice(0, 30).join(" "), sku, name };
    }
  });
  if (!snapshot?.result) throw new Error("No comparison data was available on this page.");
  await chrome.storage.local.set({ comparisonPage: snapshot.result });
  return `Saved "${snapshot.result.title}" for comparison. Open the same product on another page; TAIF compares automatically.`;
}

/** Injects axe-core only when asked, then reports the counts; nothing is changed on the page. */
async function runAccessibilityAudit(tab: chrome.tabs.Tab): Promise<string> {
  if (!tab.id || !tab.url?.startsWith("http")) throw new Error("Open a normal website to audit it.");
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["axe.min.js"] });
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const axe = (window as Window & { axe?: { run: (context: Document, options: unknown) => Promise<{ violations: { id: string; impact?: string; nodes: unknown[] }[] }> } }).axe;
      if (!axe) throw new Error("axe-core did not load.");
      const report = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
      return report.violations.map((violation) => ({ id: violation.id, impact: violation.impact ?? "minor", count: violation.nodes.length }));
    }
  });
  const violations = (result?.result ?? []) as { id: string; impact: string; count: number }[];
  if (!violations.length) return "Full accessibility audit (axe-core): no WCAG A/AA violations detected by automated rules.";
  const serious = violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  return `Full accessibility audit (axe-core): ${violations.length} rule(s) failed, ${serious.length} serious — ` +
    violations.slice(0, 5).map((violation) => `${violation.id} (${violation.count})`).join(", ") + ".";
}

/** Applies the reversible adaptations chosen in Settings; they never activate page controls. */
async function applySavedAdaptations(tab: chrome.tabs.Tab, reset: boolean): Promise<string> {
  if (!tab.id || !tab.url?.startsWith("http")) throw new Error("Open a normal website to apply adaptations.");
  const { settings } = await chrome.storage.local.get("settings");
  const saved = { largeTargets: false, focus: false, readability: false, autonomy: "balanced", ...(settings as object | undefined) };
  const prefs = reset ? { ...saved, largeTargets: false, focus: false, readability: false } : saved;
  if (!reset && !prefs.largeTargets && !prefs.focus && !prefs.readability) {
    throw new Error("No adaptations are selected. Choose them in Dashboard & settings first.");
  }
  if (!reset && prefs.autonomy === "ask" && !window.confirm("Apply the selected reversible accessibility changes to this page?")) return "";
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (p) => {
      document.documentElement.classList.toggle("taif-large-targets", p.largeTargets);
      document.documentElement.classList.toggle("taif-enhanced-focus", p.focus);
      document.documentElement.classList.toggle("taif-readable", p.readability);
      document.getElementById("taif-adaptations")?.remove();
      if (p.largeTargets || p.focus || p.readability) {
        const style = document.createElement("style");
        style.id = "taif-adaptations";
        style.textContent = `
          html.taif-large-targets button, html.taif-large-targets a, html.taif-large-targets input, html.taif-large-targets select { min-width: 44px !important; min-height: 44px !important; }
          html.taif-enhanced-focus :focus-visible { outline: 3px solid #d97706 !important; outline-offset: 3px !important; }
          html.taif-readable body { line-height: 1.65 !important; letter-spacing: .015em !important; }
        `;
        document.documentElement.append(style);
      }
    },
    args: [prefs]
  });
  return reset ? "Adaptations removed from this page." : "Adaptations applied. Use Reset to undo.";
}
