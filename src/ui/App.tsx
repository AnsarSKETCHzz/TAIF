import { useEffect, useMemo, useState } from "react";
import { detect } from "../shared/detectors";
import type { Finding, PageEvidence, ScanResult, Severity } from "../shared/types";

const emptyScan = (url = "Current tab"): ScanResult => ({
  url, title: "", scannedAt: "", findings: [], detectorCount: 11,
  caveat: "No scan has been run. A clean result would only mean these limited checks did not detect an issue."
});

export function App() {
  const isDashboard = document.body.classList.contains("dashboard");
  const isExtension = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id && chrome.storage);
  const isPreview = isDashboard && !isExtension;
  const [scan, setScan] = useState<ScanResult>(emptyScan());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [severity, setSeverity] = useState<Severity | "all">("all");
  const [category, setCategory] = useState("all");
  const [view, setView] = useState<"results" | "settings">("results");
  const [settings, setSettings] = useState({ autonomy: "balanced", largeTargets: false, focus: false, readability: false });
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [comparisonTitle, setComparisonTitle] = useState("");
  const [activeUrl, setActiveUrl] = useState("Current website");

  const refresh = async () => {
    const data = isExtension
      ? await chrome.storage.local.get(["latestScan", "scans", "settings", "comparisonPage"])
      : readPreviewStorage();
    const [tab] = isExtension ? await chrome.tabs.query({ active: true, currentWindow: true }) : [undefined];
    if (tab?.url?.startsWith("http")) setActiveUrl(new URL(tab.url).host);
    const latest = data.latestScan as ScanResult | undefined;
    if (isDashboard) {
      if (latest) setScan(latest);
    } else if (tab?.url?.startsWith("http") && latest && samePage(tab.url, latest.url)) {
      setScan(latest);
    } else {
      setScan(emptyScan(tab?.url ?? "Current tab"));
    }
    if (Array.isArray(data.scans)) setHistory(data.scans as ScanResult[]);
    if (data.settings) setSettings((current) => ({ ...current, ...(data.settings as typeof settings) }));
    if (data.comparisonPage && typeof data.comparisonPage === "object" && "title" in data.comparisonPage) {
      setComparisonTitle(String(data.comparisonPage.title));
    }
  };

  useEffect(() => {
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load saved dashboard data.");
    });
  }, []);

  const runScan = async () => {
    setBusy(true);
    setError("");
    try {
      if (!isExtension) {
        throw new Error("Live scans need the installed Chrome extension. Use “Load demonstration results” to preview the dashboard.");
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab was found.");
      if (!tab.url?.startsWith("http://") && !tab.url?.startsWith("https://")) {
        throw new Error("Chrome does not allow this extension to scan browser-internal pages. Open a website and try again.");
      }
      const response = await chrome.runtime.sendMessage({ type: "TAIF_SCAN" });
      if (response?.error) throw new Error(response.error);
      if (!response?.scan) throw new Error("The scan did not return a result.");
      const value = response.scan as ScanResult;
      setScan(value);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unknown scan error.");
    } finally {
      setBusy(false);
    }
  };

  const saveSettings = async (next: typeof settings) => {
    setSettings(next);
    await saveStorage({ settings: next });
  };

  const applyAdaptations = async (next: typeof settings) => {
    if (next.autonomy === "ask" && !window.confirm("Apply the selected reversible accessibility changes to this page?")) return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("http")) {
      setError("Open a normal website and use the extension popup to apply adaptations.");
      return;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (prefs) => {
          document.documentElement.classList.toggle("taif-large-targets", prefs.largeTargets);
          document.documentElement.classList.toggle("taif-enhanced-focus", prefs.focus);
          document.documentElement.classList.toggle("taif-readable", prefs.readability);
          let style = document.getElementById("taif-adaptations");
          if (style) style.remove();
          if (prefs.largeTargets || prefs.focus || prefs.readability) {
            style = document.createElement("style");
            style.id = "taif-adaptations";
            style.textContent = `
              html.taif-large-targets button, html.taif-large-targets a, html.taif-large-targets input, html.taif-large-targets select { min-width: 44px !important; min-height: 44px !important; }
              html.taif-enhanced-focus :focus-visible { outline: 3px solid #d97706 !important; outline-offset: 3px !important; }
              html.taif-readable body { line-height: 1.65 !important; letter-spacing: .015em !important; }
            `;
            document.documentElement.append(style);
          }
        },
        args: [next]
      });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply adaptations.");
    }
  };

  const filtered = useMemo(() =>
    scan.findings.filter((finding) =>
      (severity === "all" || finding.severity === severity) &&
      (category === "all" || finding.category === category)
    ),
    [scan, severity, category]
  );
  const groups = useMemo(() => {
    const grouped = new Map<number, Finding[]>();
    for (const finding of filtered) grouped.set(finding.scenario_id, [...(grouped.get(finding.scenario_id) ?? []), finding]);
    return [...grouped.entries()];
  }, [filtered]);

  const exportReport = () => {
    const blob = new Blob([JSON.stringify({ ...scan, findings: scan.findings.map(redactFinding) }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "taif-scan-report.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const openDashboard = () => chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
  const clearSavedData = async () => {
    if (isExtension) {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
    } else {
      localStorage.removeItem("taif-preview-storage");
    }
    setHistory([]);
    setScan(emptyScan());
    setComparisonTitle("");
    setSettings({ autonomy: "balanced", largeTargets: false, focus: false, readability: false });
  };
  const resetAdaptations = async () => {
    const next = { ...settings, largeTargets: false, focus: false, readability: false };
    await saveSettings(next);
    if (isExtension) await applyAdaptations(next);
  };
  const selectComparisonPage = async () => {
    setError("");
    try {
      if (!isExtension) throw new Error("Selecting pages for live comparison is available in the installed extension.");
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.startsWith("http")) throw new Error("Open a normal website page to select it for comparison.");
      const [snapshot] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          url: location.origin + location.pathname,
          title: document.title.slice(0, 200)
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]")
            .replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number masked]")
            .replace(/\b(?:sk|pk|api|key)[-_]?[A-Za-z0-9_-]{16,}\b/gi, "[key-like value masked]"),
          text: [...(document.body.innerText.matchAll(/(?:[$€£]\s?\d+(?:[.,]\d{2})?|\d+(?:[.,]\d{2})?\s?(?:USD|EUR|GBP))/gi))]
            .map((match) => match[0]).slice(0, 30).join(" ")
        })
      });
      if (!snapshot.result) throw new Error("No comparison data was available on this page.");
      await saveStorage({ comparisonPage: snapshot.result });
      setComparisonTitle(String(snapshot.result.title));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not select comparison page.");
    }
  };

  const loadDemoResults = async () => {
    const page: PageEvidence = {
      url: "http://127.0.0.1:5173/test-site/index.html",
      title: "TAIF Synthetic Scenario Lab",
      text: "Only 2 items left. Admin dashboard. Trial automatically renews monthly.",
      observedAt: new Date().toISOString(),
      elements: [
        { description: "synthetic paragraph element", tag: "p", text: "Low contrast example", contrast: 2.4, foreground: "rgb(170, 170, 170)", background: "rgb(255, 255, 255)" },
        { description: "synthetic link element", tag: "a", text: "Terms of service", contrast: 2.1, interactive: true, foreground: "rgb(180, 180, 180)", background: "rgb(255, 255, 255)" }
      ],
      timers: [{ key: "/deal|0|", text: "10:00", seconds: 600, context: "Hurry! Offer ends soon" }],
      previousTimers: [{ key: "/deal|0|", seconds: 600, at: Date.now() - 5 * 60_000, restarts: 1 }],
      claims: [{ text: "Only 2 items left", count: 2 }],
      previousPage: { url: "http://127.0.0.1:5173/test-site/comparison.html", title: "Synthetic comparison", text: "Price $19.99" },
      navigation: { loadMs: 6400, resourceCount: 12 },
      formCount: 1,
      formsNoValidate: true,
      forms: [{ description: "form 1", sensitive: ["email", "password"], validated: false, novalidate: true }],
      accessibility: { unlabeled: ['button ""'], smallTargets: ['button "x"'], focusSuppressed: true, imageLinksWithoutAlt: 0 },
      choicePairs: [{ container: "div cookie banner", positive: { text: "Accept all", area: 9000, contrast: 8, opacity: 1, fontSize: 16 }, negative: { text: "Reject", area: 600, contrast: 1.6, opacity: 1, fontSize: 10 } }],
      subscription: { action: { text: "Start free trial", fontSize: 18, contrast: 7 }, terms: [{ text: "Trial converts to a paid plan and automatically renews monthly.", fontSize: 9, contrast: 2.8, distance: 40 }] }
    };
    const result: ScanResult & { demoMode?: boolean } = {
      url: page.url,
      title: page.title,
      scannedAt: page.observedAt,
      findings: detect(page),
      detectorCount: 11,
      caveat: "DEMONSTRATION DATA: findings were generated by the implemented detectors from synthetic evidence; this is not a scan of a real website.",
      demoMode: true
    };
    setScan(result);
    setError("");
    await saveStorage({ latestScan: result, scans: [result, ...history].slice(0, 30) });
    setHistory([result, ...history].slice(0, 30));
  };

  return (
    <main className={isDashboard ? "app dashboard-app" : "app popup-app"}>
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">T</div>
        <div><h1>TAIF</h1><p>Trustworthy Adaptive Interfaces</p></div>
        {isDashboard && <button className="text-button" onClick={() => setView(view === "results" ? "settings" : "results")}>{view === "results" ? "Settings" : "Results"}</button>}
      </header>
      {!isDashboard && (
        <section className="site-card">
          <span className="eyebrow">CURRENT PAGE</span>
          <strong>{activeUrl}</strong>
          <button className="primary" onClick={() => void runScan()} disabled={busy}>{busy ? "Scanning…" : scan.scannedAt ? "Rescan page" : "Scan this page"}</button>
          <button className="secondary" onClick={() => void selectComparisonPage()}>Use this page for comparison</button>
          {(settings.largeTargets || settings.focus || settings.readability) && <button className="secondary" onClick={() => void applyAdaptations(settings)}>Apply selected accessibility adaptations</button>}
          <button className="text-button" onClick={() => void resetAdaptations()}>Reset adaptations on this page</button>
          <small className="permission-note">Temporary access is limited to this active tab after you request a scan.</small>
        </section>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {view === "settings" && isDashboard ? (
        <section className="panel">
          <h2>Accessibility adaptations</h2>
          <p className="muted">Each choice is opt-in and can be reversed. Choose options here, then return to the website and apply them from the extension popup. They do not activate controls or alter transaction choices.</p>
          <fieldset><legend>Adaptation autonomy</legend>
            {[
              ["ask", "Ask me first", "Show an additional confirmation before applying."],
              ["balanced", "Balanced", "Require an explicit popup action to apply your selections."],
              ["hands-off", "Hands-off", "Remember selections; still apply only when you click."]
            ].map(([value, label, help]) => <label className="radio-row" key={value}><input type="radio" name="autonomy" value={value} checked={settings.autonomy === value} onChange={() => void saveSettings({ ...settings, autonomy: value })} /><span><b>{label}</b><small>{help}</small></span></label>)}
          </fieldset>
          <div className="toggle-list">
            {([
              ["largeTargets", "Increase interactive target sizes"],
              ["focus", "Enhance keyboard focus visibility"],
              ["readability", "Improve text spacing and line height"]
            ] as const).map(([key, label]) => <label className="toggle-row" key={key}><span>{label}</span><input type="checkbox" checked={settings[key]} onChange={(event) => void saveSettings({ ...settings, [key]: event.target.checked })} /></label>)}
          </div>
          <p className="muted">Reset by disabling the options here, then use the extension popup's reset action on the website.</p>
          <h2>Privacy</h2>
          <p className="muted">Page checks run locally after you start a scan. No backend or remote AI is configured. Local history is limited to 30 scans.</p>
          <button className="secondary" onClick={() => void clearSavedData()}>Clear local scan history and settings</button>
          <h2>Risk gate</h2>
          <p className="muted">Inspired by the reference prototype: context → propose → assess risk → explain and authorize → apply with undo → feedback. This prototype does not automate or change consequential website actions.</p>
        </section>
      ) : (
        <section className="results">
          {isDashboard && <div className="dashboard-controls"><h2>Scan results</h2>{isPreview && <button className="secondary" onClick={() => void loadDemoResults()}>Load demonstration results</button>}</div>}
          {isPreview && <p className="preview-note">Preview mode · Browser-only dashboard. Live page scans require loading the Chrome extension.</p>}
          {scan.demoMode && <p className="demo-note"><b>DEMONSTRATION DATA</b> · Synthetic evidence processed by the real detector rules; not findings from a real website.</p>}
          {scan.scannedAt ? (
            <div className="summary">
              <strong>{scan.findings.length === 0 ? "No issue detected by these checks" : `${scan.findings.length} finding${scan.findings.length === 1 ? "" : "s"}`}</strong>
              <span>{new Date(scan.scannedAt).toLocaleString()}</span>
            </div>
          ) : <p className="muted">{isPreview ? "No scan loaded yet. Use “Load demonstration results” to preview the dashboard." : isDashboard ? "No saved scan yet. Scan a website from its extension popup." : "Scan results are local to your browser."}</p>}
          {scan.scannedAt && <div className="severity-summary" aria-label="Finding counts by severity">
            {(["critical", "high", "medium", "low", "informational"] as const).map((level) => {
              const count = scan.findings.filter((finding) => finding.severity === level).length;
              return <span className={`severity ${level}`} key={level}>{count} {level}</span>;
            })}
          </div>}
          <p className="caveat">{scan.caveat}</p>
          {isDashboard && scan.scannedAt && <>
            <div className="comparison"><span>Comparison page: {comparisonTitle || "none selected"} · Select a comparison page from its extension popup.</span></div>
            <div className="filters"><label htmlFor="severity">Severity</label><select id="severity" value={severity} onChange={(event) => setSeverity(event.target.value as Severity | "all")}><option value="all">All severities</option>{["informational", "low", "medium", "high", "critical"].map((value) => <option key={value}>{value}</option>)}</select><label htmlFor="category">Category</label><select id="category" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{[...new Set(scan.findings.map((finding) => finding.category))].map((value) => <option key={value}>{value}</option>)}</select><button className="secondary" onClick={exportReport}>Export redacted report</button></div>
            {history.length > 0 && <section className="history"><h3>Recent scans</h3>{history.slice(0, 8).map((item, index) => <button key={`${item.url}-${item.scannedAt}-${index}`} onClick={() => setScan(item)}>{item.title || item.url}<small>{item.scannedAt ? new Date(item.scannedAt).toLocaleString() : ""} · {item.findings?.length ?? 0} finding(s)</small></button>)}</section>}
          </>}
          {groups.map(([scenarioId, findings]) => <section className="scenario-group" key={scenarioId}>
            <h3>Scenario {scenarioId} · {findings[0].scenario_name}</h3>
            <div className="finding-list">{findings.map((finding) => <FindingCard key={`${scan.scannedAt}-${finding.finding_id}`} finding={finding} />)}</div>
          </section>)}
          {scan.scannedAt && scan.findings.length === 0 && <div className="empty-state"><span aria-hidden="true">✓</span><p>None of the implemented checks produced a finding. This is not a security certification; some scenarios require evidence unavailable to a browser extension.</p></div>}
          {!isDashboard && scan.scannedAt && <button className="secondary full" onClick={() => void openDashboard()}>Open detailed results</button>}
        </section>
      )}
      {!isDashboard && <footer>Local-first · User-initiated · No site is declared secure</footer>}
    </main>
  );
}

function FindingCard({ finding }: { finding: Finding }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return <article className="finding">
    <div className="finding-heading"><span className={`severity ${finding.severity}`}>{finding.severity}</span><span className="confidence">{Math.round(finding.confidence * 100)}% confidence</span></div>
    <h3>{finding.title}</h3><p>{finding.summary}</p>
    <p><b>Scenario {finding.scenario_id}:</b> {finding.scenario_name}</p>
    <details><summary>Evidence, action & limitations</summary>
      <ul>{finding.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>
      <p><b>Affected:</b> {finding.affected_element_description}</p>
      <p><b>Confidence rationale:</b> {finding.confidence_rationale}</p>
      <p><b>Recommended:</b> {finding.recommended_action}</p>
      <p className="muted"><b>Limitations:</b> {finding.limitations}</p>
      <p className="muted">Verification: {finding.verification_status}</p>
    </details>
    <button className="text-button" onClick={() => setDismissed(true)}>Dismiss for this view</button>
  </article>;
}

function redactFinding(finding: Finding): Finding {
  return {
    ...finding,
    page_url: finding.page_url.replace(/[?#].*$/, ""),
    evidence: finding.evidence.map((text) => text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email masked]").replace(/\b(?:\+?\d[\d\s().-]{7,}\d)\b/g, "[number masked]"))
  };
}

function samePage(left: string, right: string): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    first.username = "";
    first.password = "";
    second.username = "";
    second.password = "";
    first.search = "";
    first.hash = "";
    second.search = "";
    second.hash = "";
    return first.href === second.href;
  } catch {
    return false;
  }
}

function readPreviewStorage(): Record<string, unknown> {
  const stored = localStorage.getItem("taif-preview-storage");
  if (!stored) return {};
  const parsed: unknown = JSON.parse(stored);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Saved dashboard preview data is invalid. Clear local dashboard data and retry.");
  }
  return parsed as Record<string, unknown>;
}

async function saveStorage(values: Record<string, unknown>): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.runtime?.id && chrome.storage) {
    await chrome.storage.local.set(values);
    return;
  }
  const existing = readPreviewStorage();
  localStorage.setItem("taif-preview-storage", JSON.stringify({ ...existing, ...values }));
}
